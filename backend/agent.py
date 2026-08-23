"""The Claude layer: open-ended analysis, plus Python/SQL code generation.

Claude drives the *same* MCP tools the deterministic endpoints use -- they are
handed over as tool definitions via the SDK's MCP conversion helpers, so a free
text question turns into real ``profile_dataset`` / ``train_model`` calls against
the user's CSV rather than a guess.
"""

from __future__ import annotations

import json
from pathlib import Path
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

## Draw your own charts
You can place a chart anywhere in your written answer by emitting a fenced \
```chart block containing JSON. It renders as a real interactive chart at that \
exact point, so put each one directly beside the claim it supports.

Schema -- `chart` and `series` are required, the rest are optional:

```chart
{"chart":"pie","title":"Survival by class","insight":"3rd class carried the \
losses.","unit":"passengers","series":[{"name":"passengers","points":[\
{"x":"1st","y":216},{"x":"2nd","y":184},{"x":"3rd","y":491}]}]}
```

Pick `chart` by the job the data has to do:
  * `"bar"` — compare magnitude across named categories (horizontal; best for \
long labels). `"column"` for vertical.
  * `"line"` — change across an ordered scale (time, quantiles, bins, ranks).
  * `"area"` — same as line when the filled volume is the point.
  * `"pie"` / `"donut"` — parts of ONE whole, where the shares are the story. \
Only when the parts genuinely sum to 100%. Six slices maximum; beyond that use \
a bar.
  * `"scatter"` — relationship between two numeric measures. Here `x` must be \
numeric.
  * `"stat"` — two to four headline numbers with no comparison to draw.

Multiple entries in `series` become multiple lines/bars with a legend, so use \
that for genuine comparisons.

Vary the form to fit each finding rather than repeating one chart type -- a \
good answer usually mixes a part-to-whole, a magnitude comparison, and a \
trend. **Reach for a chart whenever the shape or ranking of the numbers is the \
point; keep tables for exact reference values.** Three to five charts is right \
for a substantial answer: enough that each major section carries one, without \
one per paragraph.

Never invent numbers. Every value must come from a tool result you actually \
received, or from arithmetic you can do on those numbers. If you cannot ground \
a value, do not plot it -- say what you would need to measure instead.

## What a good answer looks like
Lead with the single most important finding in one sentence. Then short \
markdown sections with the specifics -- concrete numbers, not adjectives -- \
each significant one carrying a chart. Prefer a compact markdown table when \
comparing several columns. Close with the one next step you would take.

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

# Chart rules for generated matplotlib. The hexes are a validated categorical
# order (adjacent-pair CVD separation holds for all eight; only the first three
# hold when every pair is compared at once, hence the scatter cap).
VIZ_GUIDE = """\
Charts -- two to four, each earning its place:
  * Pick the form by the job the data has to do: `barh` to compare magnitude \
across named categories (horizontal when the labels are long, `bar` when they \
are short), `line` for change across an ordered scale, `hist` for one \
distribution, `boxplot` for a distribution compared across groups, `scatter` \
for the relationship between two numeric measures, a heatmap for a correlation \
matrix. A single headline number is a `print`, not a chart.
  * Never a dual y-axis. Two measures on different scales -> two charts, or \
index both to a common base.
  * Color: assign these hexes in this order, one per entity, never cycled --
    #2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #4a3aa7, #e34948.
    Scatter and other forms where every pair sits side by side stop at the \
first three; past that, fold the tail into "Other" or facet into subplots. A \
single-series chart uses #2a78d6 alone. Continuous magnitude is one hue \
light->dark (`cmap="Blues"`), never a rainbow map; signed data diverges \
(`cmap="coolwarm"`, `vmin=-vmax` so 0 lands on the neutral midpoint).
  * Style each axes: `figsize=(8, 5)`, left-aligned title in #0b0b0b, tick and \
axis-label text in #52514e, `ax.set_axisbelow(True)` with a gridline in \
#e1e0d9 on the value axis only, top/right spines hidden and the remaining \
baseline in #c3c2b7. Label axes with their units. Legend only for 2+ series; \
direct-label instead when few enough marks. Never a value label on every point.
  * Headless: `import matplotlib; matplotlib.use("Agg")` before pyplot, \
`os.makedirs("outputs", exist_ok=True)`, then \
`fig.savefig(f"outputs/{name}.png", dpi=150, bbox_inches="tight")` and \
`plt.close(fig)` per figure. Never `plt.show()`.\
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
                "Write a single self-contained Python script using pandas and "
                "matplotlib (scikit-learn only if the goal needs it). Load the "
                f"data with pd.read_csv('datasets/{filename}').\n\n"
                "Structure it in three parts:\n"
                "  1. EDA -- shape, dtypes, missing-value counts per column, "
                "describe() on the numerics, value counts for the categoricals "
                "that matter, and the correlations between the numerics "
                "relevant to the goal.\n"
                "  2. The specific analysis the goal asks for.\n"
                "  3. The charts below.\n\n"
                "Print every finding to stdout under short labelled headings "
                "so the run reads as a report, and save each chart as its own "
                "PNG under outputs/ with a descriptive filename.\n\n"
                f"{VIZ_GUIDE}"
            )
        elif language == "sql":
            table = Path(filename).stem
            target = (
                "Write a plain, portable ANSI SQL query against a table named "
                f"`{table}`. Reference that table name directly -- no file "
                "paths, and no read_csv_auto() or other file-reading "
                "functions. It must run as-is on Databricks, Postgres "
                "(Supabase) and SQL Workbench, so stick to standard SQL: "
                "CTEs, joins, aggregates and window functions are fine, but "
                "avoid engine-specific functions, casts and syntax. Return a "
                "single query."
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
