"""
Kaggle Dataset Analyst — MCP Server
===================================

An MCP server that exposes tools, resources, and prompts for exploratory
data analysis (EDA) and machine-learning workflows on Kaggle-style CSV
datasets.

Run it standalone (stdio transport):

    uv run mcp_server.py

Or register it with an MCP client (e.g. Claude Desktop / Claude Code) — see
README.md for the client configuration snippet.

Capabilities
------------
Tools (model-invoked actions):
  * list_datasets            — list CSV files available under datasets/
  * profile_dataset          — shape, dtypes, summary stats, sample rows
  * detect_missing_values    — per-column missing counts & percentages
  * correlation_analysis     — correlation matrix of numeric columns
  * value_counts             — distribution of a categorical column
  * plot_distribution        — save a histogram/bar chart PNG to outputs/
  * train_model              — train a sklearn classifier/regressor & save it
  * list_models              — list saved models (target column & task type)
  * predict                  — score new rows with a saved model
  * download_kaggle_dataset  — pull a dataset via kagglehub (needs Kaggle auth)

Resources (read-only context the client can attach):
  * datasets://list                  — newline list of available datasets
  * dataset://{filename}/schema      — JSON schema (columns, dtypes, missing)

Prompts (reusable, parameterized instructions):
  * eda_walkthrough          — guided EDA plan for a dataset
  * insight_report           — open-ended insight discovery + visualizations
  * ml_pipeline              — end-to-end modelling plan for a target column
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any, Literal

import matplotlib

matplotlib.use("Agg")  # headless backend — never opens a GUI window
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# Heavy ML imports are done here at module load (main thread, once at startup)
# rather than lazily inside train_model. FastMCP runs sync tools in a worker
# thread, and a first-time import of scikit-learn from a non-main thread can
# deadlock on CPython's import lock — so these MUST stay at module scope.
import joblib
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    mean_absolute_error,
    r2_score,
    root_mean_squared_error,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

try:  # optional — only needed by download_kaggle_dataset
    import kagglehub
except Exception:  # noqa: BLE001
    kagglehub = None

from mcp.server.fastmcp import FastMCP

# --------------------------------------------------------------------------- #
# Paths & server setup
# --------------------------------------------------------------------------- #
ROOT = Path(__file__).parent
DATASETS_DIR = ROOT / "datasets"
MODELS_DIR = ROOT / "models"
OUTPUTS_DIR = ROOT / "outputs"

for _d in (DATASETS_DIR, MODELS_DIR, OUTPUTS_DIR):
    _d.mkdir(exist_ok=True)

mcp = FastMCP("kaggle-analyst")


# --------------------------------------------------------------------------- #
# Internal helpers
# --------------------------------------------------------------------------- #
def _resolve_dataset(filename: str) -> Path:
    """Resolve a dataset filename safely inside DATASETS_DIR.

    Prevents path traversal (e.g. ``../../secrets.csv``) and gives a clear
    error if the file is missing.
    """
    candidate = (DATASETS_DIR / filename).resolve()
    if DATASETS_DIR.resolve() not in candidate.parents:
        raise ValueError(f"Refusing to access path outside datasets/: {filename!r}")
    if not candidate.exists():
        available = ", ".join(p.name for p in DATASETS_DIR.glob("*.csv")) or "(none)"
        raise FileNotFoundError(
            f"Dataset {filename!r} not found. Available: {available}"
        )
    return candidate


def _load_df(filename: str) -> pd.DataFrame:
    return pd.read_csv(_resolve_dataset(filename))


def _json(obj: Any) -> str:
    """Serialize to pretty JSON, coercing numpy/pandas scalars."""

    def default(o: Any) -> Any:
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, (np.ndarray,)):
            return o.tolist()
        return str(o)

    return json.dumps(obj, indent=2, default=default)


# --------------------------------------------------------------------------- #
# Tools
# --------------------------------------------------------------------------- #
@mcp.tool()
def list_datasets() -> str:
    """List the CSV datasets available under the datasets/ directory."""
    files = sorted(DATASETS_DIR.glob("*.csv"))
    if not files:
        return "No datasets found. Place a .csv file in the datasets/ folder."
    rows = []
    for f in files:
        try:
            df = pd.read_csv(f, nrows=0)
            n_cols = len(df.columns)
        except Exception:
            n_cols = -1
        size_kb = f.stat().st_size / 1024
        rows.append({"filename": f.name, "columns": n_cols, "size_kb": round(size_kb, 1)})
    return _json(rows)


@mcp.tool()
def profile_dataset(filename: str, sample_rows: int = 5) -> str:
    """Profile a dataset: shape, column dtypes, numeric summary stats, and a
    sample of rows.

    Args:
        filename: CSV file inside datasets/ (e.g. "train.csv").
        sample_rows: How many head rows to include in the preview.
    """
    df = _load_df(filename)
    numeric = df.select_dtypes(include="number")
    profile = {
        "filename": filename,
        "n_rows": int(df.shape[0]),
        "n_columns": int(df.shape[1]),
        "columns": [
            {
                "name": col,
                "dtype": str(df[col].dtype),
                "n_unique": int(df[col].nunique(dropna=True)),
                "n_missing": int(df[col].isna().sum()),
            }
            for col in df.columns
        ],
        "numeric_summary": json.loads(numeric.describe().to_json()) if not numeric.empty else {},
        "sample": json.loads(df.head(sample_rows).to_json(orient="records")),
    }
    return _json(profile)


@mcp.tool()
def detect_missing_values(filename: str) -> str:
    """Report missing-value counts and percentages per column, sorted by the
    most-missing first."""
    df = _load_df(filename)
    total = len(df)
    missing = df.isna().sum()
    report = [
        {
            "column": col,
            "n_missing": int(missing[col]),
            "pct_missing": round(float(missing[col]) / total * 100, 2) if total else 0.0,
        }
        for col in df.columns
        if missing[col] > 0
    ]
    report.sort(key=lambda r: r["n_missing"], reverse=True)
    if not report:
        return f"No missing values found in {filename} ({total} rows)."
    return _json({"filename": filename, "n_rows": total, "missing": report})


@mcp.tool()
def correlation_analysis(
    filename: str,
    method: Literal["pearson", "spearman", "kendall"] = "pearson",
    top_n: int = 10,
) -> str:
    """Compute the correlation matrix of numeric columns and surface the
    strongest pairwise correlations.

    Args:
        filename: CSV file inside datasets/.
        method: Correlation method.
        top_n: Number of strongest (by absolute value) pairs to list.
    """
    df = _load_df(filename)
    numeric = df.select_dtypes(include="number")
    if numeric.shape[1] < 2:
        return "Need at least two numeric columns for correlation analysis."
    corr = numeric.corr(method=method)

    # Extract unique upper-triangle pairs, ranked by |correlation|.
    pairs = []
    cols = corr.columns.tolist()
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            value = corr.iloc[i, j]
            if pd.notna(value):
                pairs.append(
                    {"pair": [cols[i], cols[j]], "corr": round(float(value), 4)}
                )
    pairs.sort(key=lambda p: abs(p["corr"]), reverse=True)

    return _json(
        {
            "filename": filename,
            "method": method,
            "matrix": json.loads(corr.round(4).to_json()),
            "top_correlations": pairs[:top_n],
        }
    )


@mcp.tool()
def value_counts(filename: str, column: str, top_n: int = 20) -> str:
    """Show the value distribution of a single column (great for categoricals
    and the target variable)."""
    df = _load_df(filename)
    if column not in df.columns:
        raise ValueError(
            f"Column {column!r} not found. Columns: {', '.join(df.columns)}"
        )
    counts = df[column].value_counts(dropna=False).head(top_n)
    total = len(df)
    dist = [
        {
            "value": ("<NA>" if pd.isna(idx) else idx),
            "count": int(n),
            "pct": round(int(n) / total * 100, 2),
        }
        for idx, n in counts.items()
    ]
    return _json({"filename": filename, "column": column, "distribution": dist})


@mcp.tool()
def plot_distribution(filename: str, column: str, bins: int = 30) -> str:
    """Render a distribution chart for a column and save it as a PNG in
    outputs/. Numeric columns get a histogram; categorical columns get a bar
    chart. Returns the saved file path."""
    df = _load_df(filename)
    if column not in df.columns:
        raise ValueError(
            f"Column {column!r} not found. Columns: {', '.join(df.columns)}"
        )

    fig, ax = plt.subplots(figsize=(8, 5))
    series = df[column]
    if pd.api.types.is_numeric_dtype(series):
        ax.hist(series.dropna(), bins=bins, edgecolor="black", alpha=0.8)
        ax.set_ylabel("Frequency")
    else:
        top = series.value_counts(dropna=False).head(20)
        top.plot(kind="bar", ax=ax, edgecolor="black", alpha=0.8)
        ax.set_ylabel("Count")
    ax.set_title(f"Distribution of {column}")
    ax.set_xlabel(column)
    fig.tight_layout()

    stem = Path(filename).stem
    out_path = OUTPUTS_DIR / f"{stem}_{column}_dist.png"
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    return f"Saved distribution plot to {out_path}"


@mcp.tool()
def train_model(
    filename: str,
    target: str,
    features: list[str] | None = None,
    task: Literal["auto", "classification", "regression"] = "auto",
    test_size: float = 0.2,
    random_state: int = 42,
) -> str:
    """Train a baseline scikit-learn model, evaluate it on a held-out split,
    and persist it to models/.

    Categorical features are one-hot encoded and numeric features are imputed +
    scaled inside a single sklearn Pipeline, so it works on raw Kaggle CSVs.

    Args:
        filename: CSV file inside datasets/.
        target: Column to predict.
        features: Columns to use as predictors. Defaults to all other columns.
        task: "classification", "regression", or "auto" (inferred from target).
        test_size: Fraction held out for evaluation.
        random_state: Reproducibility seed.
    """
    df = _load_df(filename)
    if target not in df.columns:
        raise ValueError(
            f"Target {target!r} not found. Columns: {', '.join(df.columns)}"
        )

    if features:
        missing = [c for c in features if c not in df.columns]
        if missing:
            raise ValueError(f"Unknown feature columns: {', '.join(missing)}")
        feature_cols = list(features)
    else:
        feature_cols = [c for c in df.columns if c != target]

    data = df[feature_cols + [target]].dropna(subset=[target])
    X = data[feature_cols]
    y = data[target]

    # Decide task type.
    if task == "auto":
        if pd.api.types.is_numeric_dtype(y) and y.nunique() > 15:
            task = "regression"
        else:
            task = "classification"

    numeric_cols = X.select_dtypes(include="number").columns.tolist()
    categorical_cols = [c for c in feature_cols if c not in numeric_cols]

    numeric_pipe = Pipeline(
        steps=[
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
        ]
    )
    categorical_pipe = Pipeline(
        steps=[
            ("impute", SimpleImputer(strategy="most_frequent")),
            ("onehot", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    preprocessor = ColumnTransformer(
        transformers=[
            ("num", numeric_pipe, numeric_cols),
            ("cat", categorical_pipe, categorical_cols),
        ]
    )

    # NOTE: keep n_jobs=1. As an MCP stdio server this process has its
    # stdin/stdout redirected to pipes; joblib/loky worker processes would
    # inherit those handles and can deadlock on Windows. RandomForest on
    # Kaggle-tutorial-sized data is fast enough single-threaded.
    if task == "classification":
        estimator = RandomForestClassifier(
            n_estimators=200, random_state=random_state, n_jobs=1
        )
    else:
        estimator = RandomForestRegressor(
            n_estimators=200, random_state=random_state, n_jobs=1
        )

    model = Pipeline(steps=[("prep", preprocessor), ("model", estimator)])

    stratify = y if (task == "classification" and y.nunique() > 1) else None
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=random_state, stratify=stratify
    )
    model.fit(X_train, y_train)
    preds = model.predict(X_test)

    if task == "classification":
        metrics = {
            "accuracy": round(float(accuracy_score(y_test, preds)), 4),
            "report": classification_report(y_test, preds, output_dict=True, zero_division=0),
        }
    else:
        metrics = {
            "r2": round(float(r2_score(y_test, preds)), 4),
            "rmse": round(float(root_mean_squared_error(y_test, preds)), 4),
            "mae": round(float(mean_absolute_error(y_test, preds)), 4),
        }

    # Feature importances (mapped back through the preprocessor).
    try:
        feat_names = model.named_steps["prep"].get_feature_names_out()
        importances = model.named_steps["model"].feature_importances_
        top_feats = sorted(
            ({"feature": str(n), "importance": round(float(v), 4)} for n, v in zip(feat_names, importances)),
            key=lambda d: d["importance"],
            reverse=True,
        )[:15]
    except Exception:
        top_feats = []

    model_path = MODELS_DIR / f"{Path(filename).stem}_{target}_{task}.joblib"
    # Persist the fitted pipeline together with the metadata `predict` needs:
    # which feature columns to supply, the target name, the task, and (for
    # classification) the class labels.
    bundle = {
        "pipeline": model,
        "features": feature_cols,
        "target": target,
        "task": task,
        "classes": (
            estimator.classes_.tolist() if task == "classification" else None
        ),
    }
    joblib.dump(bundle, model_path)

    return _json(
        {
            "filename": filename,
            "target": target,
            "task": task,
            "n_train": int(len(X_train)),
            "n_test": int(len(X_test)),
            "features_used": feature_cols,
            "metrics": metrics,
            "top_features": top_feats,
            "saved_model": str(model_path),
        }
    )


def _resolve_model(model: str) -> Path:
    """Resolve a saved model filename safely inside MODELS_DIR.

    Accepts either the full filename ("train_Survived_classification.joblib")
    or the same name without the .joblib extension.
    """
    name = model if model.endswith(".joblib") else f"{model}.joblib"
    candidate = (MODELS_DIR / name).resolve()
    if MODELS_DIR.resolve() not in candidate.parents:
        raise ValueError(f"Refusing to access path outside models/: {model!r}")
    if not candidate.exists():
        available = ", ".join(p.name for p in MODELS_DIR.glob("*.joblib")) or "(none)"
        raise FileNotFoundError(
            f"Model {model!r} not found. Train one first. Available: {available}"
        )
    return candidate


@mcp.tool()
def list_models() -> str:
    """List the trained models saved under models/, with the target column and
    task type each one predicts."""
    files = sorted(MODELS_DIR.glob("*.joblib"))
    if not files:
        return "No saved models yet. Train one with the train_model tool."
    rows = []
    for f in files:
        info: dict[str, Any] = {"model": f.name}
        try:
            bundle = joblib.load(f)
            if isinstance(bundle, dict):
                info["target"] = bundle.get("target")
                info["task"] = bundle.get("task")
                info["features"] = bundle.get("features")
        except Exception:  # noqa: BLE001
            pass
        rows.append(info)
    return _json(rows)


@mcp.tool()
def predict(
    model: str,
    records: list[dict] | None = None,
    filename: str | None = None,
    id_column: str | None = None,
    save_csv: bool = False,
    top_n: int = 50,
) -> str:
    """Score new data with a previously trained model (from train_model).

    Provide the rows to score in ONE of two ways:
      * `records`: a list of row dicts, e.g.
        [{"Pclass": 3, "Sex": "male", "Age": 22, "Fare": 7.25, "Embarked": "S"}]
      * `filename`: a CSV inside datasets/ to score every row of (e.g. a Kaggle
        "test.csv").

    The saved model is a full pipeline, so missing values and categoricals are
    handled automatically; you only need to supply the feature columns used in
    training. For classifiers, per-class probabilities and a confidence score
    are included.

    Args:
        model: Saved model name (see list_models), with or without ".joblib".
        records: Inline rows to score.
        filename: CSV in datasets/ to score instead of `records`.
        id_column: Optional identifier column to echo alongside each prediction
            (e.g. "PassengerId") — handy for building a submission file.
        save_csv: If true, also write the predictions to outputs/ as a CSV.
        top_n: Max number of prediction rows to include in the response.
    """
    if (records is None) == (filename is None):
        raise ValueError("Provide exactly one of `records` or `filename`.")

    path = _resolve_model(model)
    bundle = joblib.load(path)
    if isinstance(bundle, dict):
        pipeline = bundle["pipeline"]
        features = bundle.get("features")
        target = bundle.get("target") or "prediction"
        task = bundle.get("task")
    else:  # backward-compat: an old bare-pipeline model
        pipeline = bundle
        features = None
        target = "prediction"
        task = None

    if records is not None:
        df = pd.DataFrame(records)
    else:
        df = _load_df(filename)

    # Validate that the required feature columns are present.
    if features:
        missing = [c for c in features if c not in df.columns]
        if missing:
            raise ValueError(
                f"Input is missing required feature column(s): {', '.join(missing)}. "
                f"Model expects: {', '.join(features)}"
            )
        X = df[features]
    else:
        X = df

    preds = pipeline.predict(X)

    ids = None
    if id_column:
        if id_column not in df.columns:
            raise ValueError(
                f"id_column {id_column!r} not found. Columns: {', '.join(df.columns)}"
            )
        ids = df[id_column].tolist()

    # Build per-row prediction records.
    out_rows: list[dict[str, Any]] = []
    proba = None
    if task == "classification" and hasattr(pipeline, "predict_proba"):
        proba = pipeline.predict_proba(X)
    for i, pred in enumerate(preds):
        row: dict[str, Any] = {}
        if ids is not None:
            row[id_column] = ids[i]
        row[target] = pred.item() if hasattr(pred, "item") else pred
        if proba is not None:
            row["confidence"] = round(float(proba[i].max()), 4)
        out_rows.append(row)

    saved_csv_path = None
    if save_csv:
        out_df = pd.DataFrame(out_rows)
        saved_csv_path = OUTPUTS_DIR / f"{path.stem}_predictions.csv"
        out_df.to_csv(saved_csv_path, index=False)

    return _json(
        {
            "model": path.name,
            "target": target,
            "task": task,
            "n_predicted": len(out_rows),
            "predictions": out_rows[:top_n],
            "truncated": len(out_rows) > top_n,
            "saved_csv": str(saved_csv_path) if saved_csv_path else None,
        }
    )


@mcp.tool()
def download_kaggle_dataset(dataset: str) -> str:
    """Download a dataset from Kaggle via kagglehub and copy any CSVs into
    datasets/.

    Requires Kaggle authentication (KAGGLE_USERNAME / KAGGLE_KEY env vars or
    ~/.kaggle/kaggle.json). Example dataset slug: "yasserh/titanic-dataset".
    """
    import shutil  # stdlib, safe to import lazily

    if kagglehub is None:
        return "kagglehub is not installed. Run: uv add kagglehub"

    try:
        path = kagglehub.dataset_download(dataset)
    except Exception as exc:  # noqa: BLE001
        return f"Download failed: {exc}\nEnsure Kaggle credentials are configured."

    copied = []
    for csv in Path(path).rglob("*.csv"):
        dest = DATASETS_DIR / csv.name
        shutil.copy2(csv, dest)
        copied.append(dest.name)
    if not copied:
        return f"Downloaded {dataset} to {path}, but found no CSV files."
    return _json({"dataset": dataset, "copied_to_datasets": copied})


# --------------------------------------------------------------------------- #
# Resources
# --------------------------------------------------------------------------- #
@mcp.resource("datasets://list")
def datasets_list_resource() -> str:
    """The list of available dataset filenames, one per line."""
    files = sorted(p.name for p in DATASETS_DIR.glob("*.csv"))
    return "\n".join(files) if files else "(no datasets)"


@mcp.resource("dataset://{filename}/schema")
def dataset_schema_resource(filename: str) -> str:
    """JSON schema for a dataset: columns, dtypes, and missing counts."""
    df = _load_df(filename)
    schema = {
        "filename": filename,
        "n_rows": int(df.shape[0]),
        "columns": [
            {
                "name": col,
                "dtype": str(df[col].dtype),
                "n_missing": int(df[col].isna().sum()),
                "n_unique": int(df[col].nunique(dropna=True)),
            }
            for col in df.columns
        ],
    }
    return _json(schema)


# --------------------------------------------------------------------------- #
# Prompts
# --------------------------------------------------------------------------- #
@mcp.prompt()
def eda_walkthrough(filename: str = "train.csv") -> str:
    """A guided exploratory-data-analysis plan for a dataset."""
    return (
        f"You are a senior data analyst. Perform a thorough exploratory data "
        f"analysis of the dataset '{filename}'.\n\n"
        "Work through these steps, using the available MCP tools:\n"
        "1. Call `profile_dataset` to understand shape, dtypes, and ranges.\n"
        "2. Call `detect_missing_values` and recommend an imputation strategy "
        "for each affected column.\n"
        "3. Call `correlation_analysis` and interpret the strongest "
        "relationships.\n"
        "4. For key categorical columns, call `value_counts` to inspect class "
        "balance.\n"
        "5. Suggest `plot_distribution` calls for the most interesting columns.\n\n"
        "Finish with a concise bulleted summary of data-quality issues and "
        "three concrete hypotheses worth modelling."
    )


@mcp.prompt()
def insight_report(filename: str = "train.csv") -> str:
    """Open-ended insight discovery for a spreadsheet, with visualizations."""
    return (
        f"You are a senior data analyst. Explore the dataset '{filename}' and "
        "surface the most interesting, non-obvious insights it contains — you "
        "decide what's worth digging into.\n\n"
        "Investigate freely using the available MCP tools:\n"
        f"1. Start with `profile_dataset` on '{filename}' to learn its shape, "
        "columns, dtypes, and value ranges.\n"
        "2. Use `detect_missing_values` to spot data-quality issues that could "
        "skew conclusions.\n"
        "3. Use `correlation_analysis` to find the strongest numeric "
        "relationships, then form hypotheses about WHY they hold.\n"
        "4. Use `value_counts` on categorical columns to find imbalances, "
        "dominant categories, or surprising distributions.\n"
        "5. For every insight worth showing, call `plot_distribution` to save a "
        "chart to outputs/ and reference the saved PNG path in your write-up. "
        "Prioritize the columns that best illustrate each finding.\n\n"
        "Then write a findings report:\n"
        "  * 5-8 concrete insights, each stated as a clear claim backed by the "
        "numbers you observed and the chart that shows it.\n"
        "  * Call out anything anomalous, counter-intuitive, or that warrants "
        "follow-up.\n"
        "  * Finish with the single most important takeaway and a suggested "
        "next analysis."
    )


@mcp.prompt()
def ml_pipeline(filename: str = "train.csv", target: str = "Survived") -> str:
    """A plan for building and evaluating a predictive model for `target`."""
    return (
        f"Build a baseline predictive model for the column '{target}' in "
        f"'{filename}'.\n\n"
        "Follow this workflow:\n"
        f"1. Profile the data and check the class balance of '{target}' with "
        "`value_counts`.\n"
        "2. Identify leakage-prone or ID-like columns to exclude from features.\n"
        f"3. Call `train_model` with target='{target}', letting preprocessing "
        "handle missing values and categoricals.\n"
        "4. Interpret the returned metrics and `top_features`.\n"
        "5. Recommend two concrete next steps to improve the model "
        "(feature engineering, alternative algorithms, or hyperparameters)."
    )


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    mcp.run()
