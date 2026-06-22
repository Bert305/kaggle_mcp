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
| `correlation_analysis` | Correlation matrix + strongest pairs |
| `value_counts` | Distribution of a categorical / target column |
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
├── datasets/
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
| 4 | `value_counts` | `filename=train.csv`, `column=Survived` | class balance (62/38) |
| 5 | `correlation_analysis` | `filename=train.csv` | strongest numeric relationships |
| 6 | `plot_distribution` | `filename=train.csv`, `column=Age` | writes a PNG to `outputs/` |
| 7 | `train_model` | `filename=train.csv`, `target=Survived` | ~0.82 accuracy + top features |
| 8 | `list_models` | — | confirms the model was saved |
| 9 | `predict` | `model=train_Survived_classification`, `records=[{"Pclass":1,"Sex":"female","Age":38,"Fare":71.3,"Embarked":"C"}]` | predicted `Survived` + confidence |

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
```bash
claude mcp add kaggle-analyst -- uv --directory c:\dev\kaggle_mcp_project\kaggle_mcp run mcp_server.py
```

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

### Then just ask
> "Profile train.csv, tell me which columns have missing data, then train a
> model to predict Survived and report the most important features."

Claude will call `profile_dataset` → `detect_missing_values` → `train_model`
on its own and summarize the results — the same tools you clicked in the
Inspector, now driven by the AI.

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
