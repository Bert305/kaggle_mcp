"""HTTP API for the Kaggle Analyst web frontend.

Every analysis route forwards to the kaggle-analyst MCP server over stdio (see
mcp_bridge.py) -- the browser talks HTTP, the backend talks MCP. Chart routes
return structured JSON so React can render interactive charts instead of PNGs.

Run it:
    uv run uvicorn backend.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .agent import ClaudeAnalyst
from .mcp_bridge import ROOT, MCPBridge, MCPToolError

# Load .env before anything constructs an Anthropic client. Paths are resolved
# against the project root, not the current directory, so it works no matter
# where uvicorn was launched from. override=False means a variable already
# exported in the shell wins over the file -- so a real environment variable is
# never silently shadowed by a stale .env.
for _env_file in (ROOT / ".env", ROOT / "backend" / ".env"):
    load_dotenv(_env_file, override=False)

DATASETS_DIR = ROOT / "datasets"
OUTPUTS_DIR = ROOT / "outputs"
MAX_UPLOAD_BYTES = 64 * 1024 * 1024  # 64 MB
SAFE_NAME = re.compile(r"^[A-Za-z0-9._ -]+$")

bridge = MCPBridge()
analyst: ClaudeAnalyst | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    global analyst
    await bridge.start()
    analyst = ClaudeAnalyst(bridge)
    try:
        yield
    finally:
        await bridge.stop()


app = FastAPI(title="Kaggle Analyst API", lifespan=lifespan)

# The Vite dev server runs on a different origin during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _safe_csv_name(filename: str) -> str:
    """Reject anything that is not a plain .csv file name.

    The MCP server also refuses paths outside datasets/, so this is the outer of
    two guards rather than the only one.
    """
    name = Path(filename).name
    if not name or name != filename or not SAFE_NAME.match(name):
        raise HTTPException(400, f"Invalid filename: {filename!r}")
    if not name.lower().endswith(".csv"):
        raise HTTPException(400, "Only .csv files are supported.")
    return name


async def _tool_json(name: str, args: dict[str, Any] | None = None) -> Any:
    try:
        return await bridge.call_json(name, args)
    except MCPToolError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


def _require_analyst() -> ClaudeAnalyst:
    if analyst is None:
        raise HTTPException(503, "Backend is still starting.")
    return analyst


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class TrainRequest(BaseModel):
    filename: str
    target: str
    features: list[str] | None = None
    task: str = "auto"
    test_size: float = 0.2


class PredictRequest(BaseModel):
    model: str
    records: list[dict[str, Any]]


class AskRequest(BaseModel):
    question: str
    filename: str | None = None


class GenerateRequest(BaseModel):
    language: str = Field(pattern="^(python|sql|ml)$")
    filename: str
    goal: str


# --------------------------------------------------------------------------- #
# Datasets
# --------------------------------------------------------------------------- #
@app.get("/api/health")
async def health() -> dict:
    """Diagnostics. Reports *whether* a Claude key resolved, never its value."""
    return {
        "ok": bridge.session is not None,
        "tools": [t.name for t in bridge.tools],
        "prompts": [p.name for p in bridge.prompts],
        # The Ask / Generate tabs need this; the rest of the app does not.
        "claude_key_loaded": bool(os.environ.get("ANTHROPIC_API_KEY")),
    }


@app.get("/api/datasets")
async def list_datasets() -> Any:
    """Every CSV in datasets/ -- uploaded and pre-existing alike."""
    result = await _tool_json("list_datasets")
    return result if isinstance(result, list) else []


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> dict:
    name = _safe_csv_name(file.filename or "")
    dest = DATASETS_DIR / name
    DATASETS_DIR.mkdir(exist_ok=True)

    size = 0
    chunks: list[bytes] = []
    while chunk := await file.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "File exceeds the 64 MB limit.")
        chunks.append(chunk)

    replaced = dest.exists()
    dest.write_bytes(b"".join(chunks))
    return {"filename": name, "bytes": size, "replaced": replaced}


@app.get("/api/dataset/{filename}/profile")
async def profile(filename: str) -> Any:
    return await _tool_json("profile_dataset", {"filename": _safe_csv_name(filename)})


@app.get("/api/dataset/{filename}/missing")
async def missing(filename: str) -> Any:
    return await _tool_json(
        "detect_missing_values", {"filename": _safe_csv_name(filename)}
    )


@app.get("/api/outputs/{filename}")
async def output_file(filename: str) -> FileResponse:
    """Serve a generated plot from outputs/ so `plot_distribution` can render.

    Guarded the same way uploads are: plain names only, resolved and confirmed
    to sit inside outputs/ before anything is read from disk.
    """
    name = Path(filename).name
    if name != filename or not SAFE_NAME.match(name) or not name.lower().endswith(".png"):
        raise HTTPException(400, f"Invalid output name: {filename!r}")
    path = (OUTPUTS_DIR / name).resolve()
    if OUTPUTS_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(path, media_type="image/png")


@app.get("/api/dataset/{filename}/schema")
async def schema(filename: str) -> Any:
    """The MCP *resource* rather than a tool -- exercises the resource path too."""
    name = _safe_csv_name(filename)
    try:
        text = await bridge.read_resource_text(f"dataset://{name}/schema")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Could not read schema: {exc}") from exc
    return json.loads(text)


# --------------------------------------------------------------------------- #
# Machine learning
# --------------------------------------------------------------------------- #
@app.post("/api/train")
async def train(req: TrainRequest) -> Any:
    args: dict[str, Any] = {
        "filename": _safe_csv_name(req.filename),
        "target": req.target,
        "task": req.task,
        "test_size": req.test_size,
    }
    if req.features:
        args["features"] = req.features
    return await _tool_json("train_model", args)


@app.get("/api/models")
async def models() -> Any:
    result = await _tool_json("list_models")
    return result if isinstance(result, list) else []


@app.post("/api/predict")
async def predict(req: PredictRequest) -> Any:
    return await _tool_json(
        "predict", {"model": req.model, "records": req.records}
    )


# --------------------------------------------------------------------------- #
# Claude-powered routes
# --------------------------------------------------------------------------- #
@app.post("/api/ask")
async def ask(req: AskRequest) -> StreamingResponse:
    """Stream the agent loop to the browser as Server-Sent Events."""
    agent = _require_analyst()
    filename = _safe_csv_name(req.filename) if req.filename else None

    async def event_stream() -> AsyncIterator[str]:
        try:
            async for event in agent.ask(req.question, filename):
                yield f"data: {json.dumps(event)}\n\n"
        except asyncio.CancelledError:  # client navigated away
            raise
        except Exception as exc:  # noqa: BLE001
            payload = {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/generate")
async def generate(req: GenerateRequest) -> Any:
    agent = _require_analyst()
    name = _safe_csv_name(req.filename)
    dataset_schema = await _tool_json("profile_dataset", {"filename": name})
    result = await agent.generate(req.language, name, req.goal, dataset_schema)
    return result.model_dump()
