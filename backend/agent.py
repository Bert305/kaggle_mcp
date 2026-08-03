"""The Claude layer: open-ended analysis, plus Python/SQL code generation.

Claude drives the *same* MCP tools the deterministic endpoints use -- they are
handed over as tool definitions via the SDK's MCP conversion helpers, so a free
text question turns into real ``profile_dataset`` / ``train_model`` calls against
the user's CSV rather than a guess.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from anthropic import AsyncAnthropic
from anthropic.lib.tools.mcp import async_mcp_tool
from pydantic import BaseModel, Field

from .mcp_bridge import MCPBridge

MODEL = "claude-opus-5"

# Tuned for this model: it defaults to longer prose, verifies work unprompted,
# and can widen scope. The conciseness / no-extra-verification / stay-in-scope
# instructions below are deliberate and should not be "improved" into
# encouragement to double-check or elaborate.
ANALYST_SYSTEM = """\
You are a senior data analyst embedded in a web app. The user has CSV datasets \
and you have MCP tools that operate on them directly.

## Your output is charted
Every tool you call is rendered for the user as a chart or table above your \
written answer, in call order. This is the app's only data-visualisation \
surface, so the tools you choose ARE the visualisation. Specifically:
  * `profile_dataset` renders shape tiles, a distribution-shape line chart, and \
the schema.
  * `detect_missing_values` renders a ranked missing-data bar chart.
  * `plot_distribution` renders its PNG inline -- this is the only way to show \
the distribution of one specific column, so call it when a column's spread or \
class balance matters to your answer.
  * `train_model` renders metric tiles and a feature-importance bar chart.
  * `predict` renders the predicted value and confidence.
You do not need to describe a chart the user can already see; reference it and \
interpret it.

## How to work
Use the tools rather than reasoning about what the data probably contains. \
Always start from `profile_dataset` (or `list_datasets` if you don't know the \
filename) so you are working from real columns and dtypes, never assumed ones. \
For any question about data quality, structure, or "what's interesting here", \
also call `detect_missing_values` -- gaps change what the other numbers mean.

Read what the profile already gives you before reaching for more tools: \
`numeric_summary` carries count/mean/std/min/quartiles/max per numeric column, \
so skew (mean vs median), spread (std vs mean), and implausible bounds are all \
available without another call. `n_unique` against the row count separates \
identifiers from real categories.

Ground every claim in a number a tool returned, and quote that number. If you \
have not measured something, say so instead of estimating it.

## What a good answer looks like
Lead with the single most important finding in one sentence. Then short \
markdown sections with the specifics -- concrete numbers, not adjectives. \
Prefer a compact markdown table when comparing several columns. Close with the \
one next step you would take.

Be genuinely informative but not padded: no filler summaries, no restating tool \
output verbatim, no piling on caveats. Say what is true and stop.

Deliver what was asked at the scope intended. Don't train a model unless the \
question calls for prediction. Report outcomes faithfully: if a tool errors, \
say what failed and what you did instead.
"""

CODEGEN_SYSTEM = """\
You generate runnable analysis code for a specific CSV dataset. You are given \
the dataset's real schema. Use only the columns that exist, spelled exactly as \
given. Prefer clear, idiomatic code over clever code. No placeholder TODOs and \
no invented column names.
"""


# A single tool payload big enough to chart but small enough not to choke the
# SSE stream. `predict` over a whole CSV is the realistic worst case.
MAX_RESULT_CHARS = 200_000


def _block_text(content: Any) -> str:
    """Flatten a tool_result's content, which may be a string or a block list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif getattr(block, "type", None) == "text":
                parts.append(block.text)
        return "\n".join(parts)
    return ""


def _tool_results(tool_response: Any) -> list[dict]:
    """Pull (tool_use_id, parsed payload) out of the runner's tool_result turn."""
    if not tool_response:
        return []
    content = (
        tool_response.get("content")
        if isinstance(tool_response, dict)
        else getattr(tool_response, "content", None)
    )
    if not isinstance(content, list):
        return []

    out: list[dict] = []
    for block in content:
        get = block.get if isinstance(block, dict) else lambda k, d=None: getattr(block, k, d)
        if get("type") != "tool_result":
            continue
        text = _block_text(get("content"))
        if len(text) > MAX_RESULT_CHARS:
            payload: Any = {"message": "Result too large to preview."}
        else:
            try:
                payload = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                payload = {"message": text.strip()}
        out.append(
            {
                "tool_use_id": get("tool_use_id") or "",
                "is_error": bool(get("is_error", False)),
                "data": payload,
            }
        )
    return out


class GeneratedCode(BaseModel):
    """Structured shape for a codegen response."""

    title: str = Field(description="Short title for what this code does.")
    code: str = Field(description="The complete runnable script or query.")
    explanation: str = Field(description="2-4 sentences on what the code does and why.")
    assumptions: list[str] = Field(
        default_factory=list,
        description="Anything the code assumes that the user should verify.",
    )


class ClaudeAnalyst:
    def __init__(self, bridge: MCPBridge) -> None:
        self.bridge = bridge
        self.client = AsyncAnthropic()

    def _tools(self) -> list[Any]:
        session = self.bridge.session
        if session is None:
            raise RuntimeError("MCP session is not running.")
        return [async_mcp_tool(tool, session) for tool in self.bridge.tools]

    # ----------------------------------------------------------------- ask --
    async def ask(self, question: str, filename: str | None) -> AsyncIterator[dict]:
        """Run the agent loop, yielding UI events as they happen.

        Yields dicts of ``{"type": "text"|"tool"|"done"|"error", ...}``. Events
        are emitted per assistant turn rather than per token, which keeps the
        tool-call log and the prose in the order Claude produced them.
        """
        prompt = question if not filename else (
            f"Dataset: {filename}\n\nQuestion: {question}"
        )

        runner = self.client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=16000,
            system=ANALYST_SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            tools=self._tools(),
            messages=[{"role": "user", "content": prompt}],
        )

        try:
            async for message in runner:
                # Remember which tool each id belongs to, so the results below
                # can be labelled and the UI can pick a chart for them.
                pending: dict[str, str] = {}
                for block in message.content:
                    if block.type == "text" and block.text.strip():
                        yield {"type": "text", "text": block.text}
                    elif block.type == "tool_use":
                        pending[block.id] = block.name
                        yield {
                            "type": "tool",
                            "id": block.id,
                            "name": block.name,
                            "input": block.input,
                        }

                if message.stop_reason == "refusal":
                    yield {
                        "type": "error",
                        "message": "The request was declined by safety filters.",
                    }
                    return

                # Run the pending tools and forward their payloads. The response
                # is cached inside the runner, so the tools execute exactly once
                # even though we ask for the result here and the runner also
                # feeds it back to the model on the next turn.
                if pending:
                    tool_response = await runner.generate_tool_call_response()
                    for result in _tool_results(tool_response):
                        name = pending.get(result["tool_use_id"])
                        if name is None:
                            continue
                        yield {
                            "type": "tool_result",
                            "id": result["tool_use_id"],
                            "name": name,
                            "is_error": result["is_error"],
                            "data": result["data"],
                        }
        except Exception as exc:  # noqa: BLE001 -- surfaced to the UI as an event
            yield {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
            return

        yield {"type": "done"}

    # -------------------------------------------------------------- codegen --
    async def generate(
        self,
        language: str,
        filename: str,
        goal: str,
        schema: dict,
    ) -> GeneratedCode:
        """Generate a Python script or SQL query for this dataset."""
        if language == "python":
            target = (
                "Write a single self-contained Python script using pandas "
                "(and scikit-learn/matplotlib only if the goal needs them). "
                f"Load the data with pd.read_csv('datasets/{filename}'). "
                "Print findings to stdout; save any plot to outputs/."
            )
        elif language == "sql":
            target = (
                "Write a SQL query in DuckDB dialect that reads the CSV "
                f"directly: FROM read_csv_auto('datasets/{filename}'). "
                "Use a CTE if it aids readability. Return a single query."
            )
        elif language == "ml":
            target = (
                "Write a single self-contained Python script that builds and "
                "evaluates a scikit-learn model for this goal. Use a Pipeline "
                "with ColumnTransformer so categoricals and missing values are "
                "handled, hold out a test split, print the metrics that suit "
                "the task type, and print the top feature importances. Load "
                f"with pd.read_csv('datasets/{filename}')."
            )
        else:
            raise ValueError(f"Unknown language: {language!r}")

        response = await self.client.messages.parse(
            model=MODEL,
            max_tokens=8000,
            system=CODEGEN_SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"{target}\n\n"
                        f"Goal: {goal}\n\n"
                        f"Dataset schema for {filename}:\n"
                        f"{json.dumps(schema, indent=2)[:6000]}"
                    ),
                }
            ],
            output_format=GeneratedCode,
        )
        return response.parsed_output
