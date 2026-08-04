# Kaggle Dataset Analyst — MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes **tools**,
**resources**, and **prompts** for exploratory data analysis (EDA) and machine
learning on Kaggle-style CSV datasets. Built with Python, Pandas, scikit-learn,
matplotlib, and the MCP Python SDK.

A capstone-level project that touches most of the data skills employers look
for: MCP, Python, Pandas, statistics, EDA, scikit-learn, prompt engineering,
data visualization, feature engineering, and model evaluation.

## What it does

### Tools (model-invoked actions)
| Tool | Purpose |
|------|---------|
| `list_datasets` | List CSV files available under `datasets/` |
| `profile_dataset` | Shape, dtypes, summary stats, sample rows |
| `detect_missing_values` | Per-column missing counts & percentages |
| `plot_distribution` | Save a histogram / bar chart PNG to `outputs/` |
| `train_model` | Train & evaluate a scikit-learn model, save it to `models/` |
| `list_models` | List saved models with their target column and task type |
| `predict` | Score new rows with a saved model — supply any feature values, get the predicted target |
| `download_kaggle_dataset` | Pull a dataset via `kagglehub` (needs Kaggle auth) |

### Resources (read-only context)
- `datasets://list` — newline list of available datasets
- `dataset://{filename}/schema` — JSON schema (columns, dtypes, missing counts)

### Prompts (reusable workflows)
- `eda_walkthrough` — a guided EDA plan for a dataset
- `ml_pipeline` — an end-to-end modelling plan for a target column

## Project structure
```
kaggle_mcp/
├── mcp_server.py        # the MCP server (tools, resources, prompts)
├── smoke_test.py        # calls every tool in-process (logic check)
├── client_test.py       # full MCP client <-> server round-trip (protocol check)
├── main.py              # convenience launcher (same as `uv run mcp_server.py`)
├── run_web.ps1          # starts the web app (API + UI) in one command
├── .env.example         # copy to .env and add your Claude key
├── backend/             # FastAPI app — HTTP for the browser, MCP for the server
│   ├── mcp_bridge.py    #   long-lived MCP stdio session
│   ├── agent.py         #   Claude agent loop + Python/SQL codegen
│   └── main.py          #   the HTTP routes
├── frontend/            # React + Vite + Recharts UI
│   └── src/
│       ├── charts.tsx   #   chart forms (sequential bars, diverging heatmap)
│       ├── api.ts       #   typed client, incl. SSE reader
│       └── panels/      #   Overview · Explore · Model · Ask · Generate code
├── datasets/            # CSVs — the web app uploads here; every tool reads here
│   └── train.csv        # Titanic dataset (891 rows)
├── models/              # saved trained models (.joblib)
├── outputs/             # generated plots (.png)
├── prompts/             # (room for saved prompt templates)
├── pyproject.toml
└── README.md
```

## Setup
```bash
# from the kaggle_mcp/ directory
uv sync          # installs dependencies into .venv
```

> **Mental model.** The server never runs on its own — it speaks the MCP
> protocol over stdio and waits for a *client* to drive it. There are two ways
> to be that client:
>
> - **Level 1 — MCP Inspector:** a web UI where *you* click tools by hand. Best
>   for learning and debugging the server.
> - **Level 2 — Claude (Desktop or Code):** the AI is the client and calls the
>   tools for you from a normal chat. This is the real, day-to-day way to use it.
> - **Level 3 — the bundled React app:** a FastAPI backend is the MCP client, and
>   the browser talks to that backend over HTTP. Point-and-click charts and ML,
>   plus a Claude-powered "ask anything" tab.
>
> Get comfortable in the Inspector first, then graduate to Claude.

## Level 1 — Drive the server with the MCP Inspector

The Inspector is a browser UI that connects to your server and lets you invoke
each tool by hand.

**One-time prerequisites** (already installed if you ran `uv sync`):
- The `cli` extra of the MCP SDK — `uv add "mcp[cli]"` (provides the `mcp dev`
  command). It is declared in `pyproject.toml`, so `uv sync` installs it.
- [Node.js](https://nodejs.org) — the Inspector UI is a Node app launched via `npx`.

**Launch it:**
```bash
uv run mcp dev mcp_server.py
```
It prints a token-prefilled URL like
`http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=...`. Open that link (use the one
with the token — the Inspector requires it). The first launch may pause while
`npx` downloads the Inspector. A green **● Connected** dot means you're live.
Press **Ctrl+C** in the terminal to stop.

**Workflow — run a tool:**
1. Click the **Tools** tab → **List Tools** (you should see all 10 tools).
2. Click a tool, e.g. **`profile_dataset`**.
3. Fill in its arguments — for `profile_dataset`, set `filename` = `train.csv`.
4. Click **Run Tool**. The JSON result appears on the right.

**A good first session (Titanic):**
| Step | Tool | Arguments | What you learn |
|------|------|-----------|----------------|
| 1 | `list_datasets` | — | confirms `train.csv` is visible |
| 2 | `profile_dataset` | `filename=train.csv` | shape, dtypes, sample rows |
| 3 | `detect_missing_values` | `filename=train.csv` | Cabin 77%, Age 20% missing |
| 4 | `plot_distribution` | `filename=train.csv`, `column=Age` | writes a PNG to `outputs/` |
| 5 | `train_model` | `filename=train.csv`, `target=Survived` | ~0.82 accuracy + top features |
| 6 | `list_models` | — | confirms the model was saved |
| 7 | `predict` | `model=train_Survived_classification`, `records=[{"Pclass":1,"Sex":"female","Age":38,"Fare":71.3,"Embarked":"C"}]` | predicted `Survived` + confidence |

> `train_model` actually fits a RandomForest — give it a few seconds.

**Other tabs:**
- **Resources** → **List Resources** shows `datasets://list`; resource
  *templates* like `dataset://{filename}/schema` are filled in with a filename.
- **Prompts** are reusable instruction *templates* — clicking **Get Prompt**
  returns text (e.g. `eda_walkthrough`) meant to be handed to an AI. They don't
  execute anything themselves; the real work is in **Tools**.

> The red **"Error output from MCP server"** panel is **not** errors — the
> Inspector labels everything the server prints to stderr that way. Lines like
> `INFO Processing request of type ...` are normal activity logs.

## Level 2 — Use the server through Claude (real usage)

Here Claude is the client: you chat normally and it decides which tools to call.

### Claude Code (CLI)
On **bash / macOS / Linux**:
```bash
claude mcp add kaggle-analyst -- uv --directory c:/dev/kaggle_mcp_project/kaggle_mcp run mcp_server.py
```

On **Windows PowerShell**, use `add-json` instead. PowerShell mangles the `--`
separator and eats the unquoted backslash path, which silently registers the
server with an empty `args` list — it then fails to start:
```powershell
claude mcp add-json kaggle-analyst '{"command":"uv","args":["--directory","c:\\dev\\kaggle_mcp_project\\kaggle_mcp","run","mcp_server.py"]}'
```
Verify with `/mcp` in a Claude Code session, or `claude mcp get kaggle-analyst`
— `args` must be non-empty.

### Claude Desktop
Add this to your `claude_desktop_config.json`
(Settings → Developer → Edit Config), then restart Claude Desktop:
```json
{
  "mcpServers": {
    "kaggle-analyst": {
      "command": "uv",
      "args": [
        "--directory",
        "c:\\dev\\kaggle_mcp_project\\kaggle_mcp",
        "run",
        "mcp_server.py"
      ]
    }
  }
}
```

Config file location on Windows depends on which build you installed:
- **Microsoft Store build:** `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
- **Standalone installer:** `%APPDATA%\Claude\claude_desktop_config.json`

Settings → Developer → Edit Config opens the right one either way.

### Then just ask
> "Profile train.csv, tell me which columns have missing data, then train a
> model to predict Survived and report the most important features."

Claude will call `profile_dataset` → `detect_missing_values` → `train_model`
on its own and summarize the results — the same tools you clicked in the
Inspector, now driven by the AI.

## Level 3 — The React web app

A browser **cannot speak MCP**: the transport is stdio, which needs a spawned
child process and a pipe. So a FastAPI backend plays the role Claude Desktop
plays — it launches `mcp_server.py` once, speaks real MCP over stdio, and exposes
the results over HTTP:

```
React (browser) ──HTTP/SSE──▶ FastAPI ──MCP stdio──▶ mcp_server.py
                                  └──────────────────▶ Claude API
```

**Run it:**
```powershell
.\run_web.ps1          # installs frontend deps on first run, starts both
```
Then open <http://localhost:5173>. Or start the halves yourself:
```powershell
uv run uvicorn backend.main:app --reload --port 8000   # terminal 1
cd frontend; npm run dev                               # terminal 2
```

### The API key

Only the **Ask Claude** and **Generate code** tabs need a Claude key. Datasets,
charts, model training and prediction all work without one.

Two ways to supply it — either works, and a shell variable **wins** over the file
so an exported key is never silently shadowed by a stale `.env`:

```powershell
# 1. A .env file (gitignored). Put it in kaggle_mcp/ — the project root, NOT
#    backend/, though backend/.env is also read as a fallback.
cp .env.example .env      # then edit in your key

# 2. Or an environment variable
$env:ANTHROPIC_API_KEY = "sk-ant-..."                                            # this shell
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY","sk-ant-...","User")   # persistent
```

The backend resolves `.env` against the project root rather than the current
directory, so it loads no matter where you launch uvicorn from. Restart the
backend after changing the key — it is read once when the client is built.

Check what actually resolved without printing the secret:
```powershell
curl http://127.0.0.1:8000/api/health     # -> "claude_key_loaded": true
```

### What the tabs do
| Tab | What it does | Path |
|-----|--------------|------|
| **Overview** | Row/column/gap tiles, missing-data chart, schema, sample rows | `profile_dataset`, `detect_missing_values` |
| **Model** | Train a model, read its metrics and drivers, score a new record | `train_model`, `list_models`, `predict` |
| **Ask Claude** | Free-text question → Claude picks tools, runs them, **charts every real result**, then writes the findings | any tool, chosen by the model |
| **Generate code** | Python / SQL / ML script written against this dataset's real schema | Claude + `profile_dataset` |

**Ask Claude is the main analysis surface**, and it visualises in two ways.

*Tool cards* — each call becomes its own card with the real payload charted:
shape tiles and a quantile line for `profile_dataset`, a ranked bar for
`detect_missing_values`, the saved PNG inline for `plot_distribution`, metric
tiles plus feature importance for `train_model`.

*Charts Claude draws itself* — it can place a chart anywhere in its write-up by
emitting a fenced ` ```chart ` block, which renders in place, beside the claim it
supports:

````
```chart
{"chart":"pie","title":"Survival by class","insight":"3rd class carried the losses.",
 "series":[{"name":"passengers","points":[{"x":"1st","y":216},{"x":"3rd","y":491}]}]}
```
````

| `chart` | For |
|---|---|
| `bar` / `column` | magnitude across named categories |
| `line` / `area` | change across an ordered scale |
| `pie` / `donut` | parts of one whole (capped at 6 slices, tail folded into "Other") |
| `scatter` | relationship between two numeric measures |
| `stat` | two to four headline numbers |

Specs are parsed defensively — a malformed one degrades to a code block rather
than breaking the answer — and the model is instructed never to plot a number it
did not get from a tool. The prose itself is rendered markdown (headings,
tables, bold, inline code) by a small dependency-free renderer that builds React
elements, so model output can never inject markup.

Uploads land in `datasets/`, so a CSV you drop in the sidebar is immediately
visible to Claude Desktop and the Inspector too — one dataset directory, three
front doors.

### Notes on the implementation
- **Charts are data, not images.** The backend returns JSON and React renders it
  with Recharts, so charts are hoverable and theme-aware. The existing
  matplotlib `plot_distribution` tool still works for report-ready PNGs.
- **Chart form is chosen by the data's job**, not by taste: magnitude → bar,
  shape across an ordered scale → line, each in a single-hue sequential ramp.
  (Part-to-whole is deliberately *not* a pie chart — pies misread at a glance,
  so a stacked bar is the substitute if one is ever needed.) The palette was
  checked with a colour-vision-deficiency validator, and every chart ships a
  table view, so meaning never rides on colour alone.
- **Two path guards.** The upload route rejects anything that is not a plain
  `.csv` name, and `mcp_server.py` independently refuses paths outside
  `datasets/`.
- **The agent loop is the SDK's tool runner** with the MCP tools converted via
  `anthropic.lib.tools.mcp`, so Claude calls the *same* tools the buttons call.
  Progress streams to the browser as Server-Sent Events.

## Making predictions with a trained model

Once `train_model` has saved a model, the `predict` tool scores **new** rows —
you supply whatever feature values you want and it returns the predicted target
(plus a confidence for classifiers). The saved model is a full pipeline, so it
handles missing values and categorical columns for you; you only provide the
feature columns used in training.

**Two input modes:**
- **Ad-hoc rows** — pass `records`, a list of feature dicts you make up:
  ```
  predict(
    model="train_Survived_classification",
    records=[{"Pclass": 1, "Sex": "female", "Age": 38, "Fare": 71.3, "Embarked": "C"}]
  )
  # -> {"Survived": 1, "confidence": 1.0}
  ```
- **A whole CSV** (e.g. a Kaggle `test.csv`) — pass `filename`, optionally echo
  an id column and write a submission CSV:
  ```
  predict(
    model="train_Survived_classification",
    filename="test.csv",
    id_column="PassengerId",
    save_csv=True   # writes outputs/<model>_predictions.csv
  )
  ```

**In Claude, just describe the case** — it fills in the `records` for you:
> "Predict survival for a 28-year-old man in 3rd class who paid £8 and boarded
> at Southampton."

Use `list_models` to see which saved models are available and what each predicts.

## Automated checks (no UI)

Two scripts verify the server without the Inspector — handy for a quick sanity
check or CI:

```bash
uv run python smoke_test.py     # calls every tool in-process (logic check)
uv run python client_test.py    # full MCP client <-> server round-trip (protocol check)
```
`client_test.py` exercises the exact stdio path a real client uses, so prefer it
when confirming the server actually works end-to-end.

## Using your own Kaggle data
1. Drop any `.csv` into `datasets/`, **or**
2. Configure Kaggle credentials (`KAGGLE_USERNAME` / `KAGGLE_KEY`, or
   `~/.kaggle/kaggle.json`) and call the `download_kaggle_dataset` tool with a
   slug like `yasserh/titanic-dataset`.

Every tool takes a `filename` argument, so the server works with any dataset
you add — not just Titanic.

## Troubleshooting

**`Invalid JSON` / `EOF while parsing` after running `uv run mcp_server.py`.**
Expected. The server is waiting for MCP protocol messages on stdin; anything you
type by hand is rejected as malformed. Press Ctrl+C and use `client_test.py` or
an MCP client instead.

**`Error: typer is required. Install with 'pip install mcp[cli]'` from
`uv run mcp dev`.** The MCP SDK was installed without its `cli` extra. Fix:
```bash
uv add "mcp[cli]"
```
(You do **not** need to activate `.venv` — `uv run`/`uv add` already use it.)

**`Failed to spawn mcp` / `os error 4551` from `uv run mcp dev`.** Windows Smart
App Control is blocking the unsigned `mcp.exe` helper. The `mcp dev` Inspector is
optional. Use `uv run python client_test.py` to verify the server without it, or
disable Smart App Control (Settings → Privacy & security → Windows Security →
App & browser control → Smart App Control).

**The Inspector's red "Error output from MCP server" panel is full of lines.**
Not an error — the Inspector shows everything the server logs to stderr there.
`INFO Processing request of type ...` lines are normal.

## Implementation notes

- **Heavy imports are at module scope, not lazy.** FastMCP runs synchronous tool
  functions in a worker thread, and a first-time `import sklearn` from a
  non-main thread can deadlock on CPython's import lock on Windows. So
  scikit-learn / joblib / kagglehub are imported once at startup on the main
  thread. (A purely in-process test like `smoke_test.py` won't catch this — only
  the real stdio path in `client_test.py` does.)
- **`train_model` uses `n_jobs=1`.** As a stdio server this process has its
  stdin/stdout redirected to pipes; parallel joblib/loky workers would inherit
  those handles and can deadlock on Windows. RandomForest on tutorial-sized data
  is fast enough single-threaded.
- **Path-traversal guard.** Every dataset access is resolved safely inside
  `datasets/`, so a `filename` like `../../secret.csv` is refused.
