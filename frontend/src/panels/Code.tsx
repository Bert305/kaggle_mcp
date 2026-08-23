import { useState } from "react";

import { api, type Generated } from "../api";
import { Card, Msg, Spinner } from "../ui";

type Lang = "python" | "sql" | "ml";

const MODES: { id: Lang; label: string; hint: string; placeholder: string }[] = [
  {
    id: "python",
    label: "Python analysis",
    hint: "A pandas script written against this dataset's real columns: an EDA pass, your analysis, and charts saved as PNGs under outputs/.",
    placeholder: "e.g. survival rate by class and sex",
  },
  {
    id: "sql",
    label: "SQL query",
    hint: "Plain ANSI SQL against a table named after this dataset — paste it into Databricks, Supabase or SQL Workbench.",
    placeholder: "e.g. average fare per class for passengers under 30",
  },
  {
    id: "ml",
    label: "ML script",
    hint: "An end-to-end scikit-learn script: pipeline, split, metrics, feature importances.",
    placeholder: "e.g. predict Survived and report which features matter most",
  },
];

export function Code({ filename }: { filename: string }) {
  const [lang, setLang] = useState<Lang>("python");
  const [goal, setGoal] = useState("");
  const [result, setResult] = useState<Generated | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mode = MODES.find((m) => m.id === lang)!;

  async function generate() {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.generate(lang, filename, goal));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="grid">
      <Card title="Generate code for this dataset" hint={mode.hint}>
        <div className="filterbar">
          <div className="field">
            <label htmlFor="lang">Output</label>
            <select
              id="lang"
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <textarea
          rows={3}
          value={goal}
          placeholder={mode.placeholder}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
          }}
          style={{ width: "100%", resize: "vertical" }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={generate} disabled={busy || !goal.trim()}>
            {busy ? "Generating…" : "Generate"}
          </button>
          <span className="sub" style={{ margin: 0 }}>
            Schema for {filename} is sent along, so column names are real.
          </span>
        </div>
      </Card>

      {busy ? <Spinner label="Writing code…" /> : null}
      {error ? <Msg kind="err">{error}</Msg> : null}

      {result ? (
        <Card title={result.title}>
          <p style={{ marginTop: 0 }}>{result.explanation}</p>

          <div className="row" style={{ marginBottom: 8 }}>
            <button className="btn ghost" onClick={copy}>
              {copied ? "Copied" : "Copy code"}
            </button>
            <span className="sub" style={{ margin: 0 }}>
              {lang === "sql"
                ? `Assumes a table named ${filename.replace(/\.csv$/i, "")} in your warehouse`
                : "Save under kaggle_mcp/ and run: uv run python <file>.py"}
            </span>
          </div>

          <pre className="code">{result.code}</pre>

          {result.assumptions.length > 0 ? (
            <>
              <h3 className="h" style={{ marginTop: 16 }}>
                Assumptions to check
              </h3>
              <ul style={{ margin: 0, paddingLeft: 20, color: "var(--text-secondary)" }}>
                {result.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
