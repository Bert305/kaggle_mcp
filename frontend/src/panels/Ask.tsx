import { useRef, useState } from "react";

import { api, type AskEvent } from "../api";
import {
  canvasBlob,
  collectTables,
  copyText,
  csvBlob,
  download,
  rasterizeFigure,
  sectionedCsv,
  slug,
  stamp,
  toMarkdownTable,
  type TableData,
} from "../exporting";
import { Markdown } from "../Markdown";
import { ToolResultView, canVisualize } from "../ToolResultView";
import { Card, Msg, Spinner } from "../ui";

/** What one question actually produces — stated up front, because it is not
 *  obvious from a text box that this returns a full report and not a sentence. */
const CAPABILITIES = [
  {
    title: "Data analysis",
    body: "Profiles, missing-data audits, distributions and trained models — run against the real file, not a summary of it.",
  },
  {
    title: "Visualizations",
    body: "Every tool result is charted as it returns, and Claude places its own charts inline next to the claim each one supports.",
  },
  {
    title: "Insight report",
    body: "A written answer with the numbers, the caveats and a next step — exportable as CSV, JPEG or markdown.",
  },
];

const SUGGESTIONS = [
  "What are the most interesting non-obvious insights in this dataset?",
  "Which columns have data-quality problems, and how should I handle each?",
  "What should I predict with this data, and which columns would leak the answer?",
  "Profile this dataset and train a model for the most promising target.",
];

interface Step {
  id: string;
  name: string;
  input: Record<string, unknown>;
  data?: unknown;
  isError?: boolean;
  done: boolean;
}

/** The call's arguments, rendered like a function signature. */
function argsOf(input: Record<string, unknown>): string {
  const args = Object.entries(input)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `(${args.length > 90 ? `${args.slice(0, 90)}…` : args})`;
}

/** Chrome asks once before saving several files from one click. */
const DOWNLOAD_GAP_MS = 250;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Ask({ filename }: { filename: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  async function run(q: string) {
    if (!q.trim() || running) return;
    setRunning(true);
    setAnswer("");
    setSteps([]);
    setError(null);
    setNote(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const onEvent = (e: AskEvent) => {
      switch (e.type) {
        case "text":
          setAnswer((prev) => prev + (prev ? "\n\n" : "") + e.text);
          break;
        case "tool":
          setSteps((prev) => [
            ...prev,
            { id: e.id, name: e.name, input: e.input, done: false },
          ]);
          break;
        case "tool_result":
          setSteps((prev) =>
            prev.map((s) =>
              s.id === e.id ? { ...s, data: e.data, isError: e.is_error, done: true } : s,
            ),
          );
          break;
        case "error":
          setError(e.message);
          break;
      }
    };

    try {
      await api.ask(q, filename, onEvent, controller.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  // ------------------------------------------------------------- export -- //
  // Everything below reads the rendered DOM rather than re-deriving rows from
  // `steps`. The export is then exactly what is on screen, and ToolResultView
  // stays the single place that decides how a tool payload becomes a table.

  const stem = `${slug(filename.replace(/\.csv$/i, ""))}-${stamp()}`;
  const hasResults = steps.length > 0 || answer !== "";

  /** Every table in the session, each labelled with the tool call it came from. */
  function sessionTables(): TableData[] {
    const root = resultsRef.current;
    if (!root) return [];
    const out: TableData[] = [];
    for (const step of steps) {
      const card = root.querySelector<HTMLElement>(`[data-step="${CSS.escape(step.id)}"]`);
      if (!card) continue;
      for (const t of collectTables(card)) out.push({ ...t, name: `${step.name} — ${t.name}` });
    }
    const findings = root.querySelector<HTMLElement>("[data-findings]");
    if (findings) {
      for (const t of collectTables(findings)) out.push({ ...t, name: `findings — ${t.name}` });
    }
    return out;
  }

  function sessionMarkdown(): string {
    const out = [
      `# Kaggle Dataset Analyst — ${filename}`,
      `_${new Date().toLocaleString()}_`,
      "",
      `**Question:** ${question.trim() || "(none)"}`,
      "",
    ];
    const root = resultsRef.current;

    if (steps.length) {
      out.push("## Tool calls", "");
      for (const step of steps) {
        out.push(`### \`${step.name}${argsOf(step.input)}\``, "");
        const card = root?.querySelector<HTMLElement>(`[data-step="${CSS.escape(step.id)}"]`);
        const tables = card ? collectTables(card) : [];
        if (tables.length) {
          for (const t of tables) out.push(`**${t.name}**`, "", toMarkdownTable(t), "");
        } else {
          // No table rendered for this tool -- fall back to the raw payload.
          out.push("```json", JSON.stringify(step.data, null, 2).slice(0, 4000), "```", "");
        }
      }
    }
    if (answer) out.push("## Findings", "", answer, "");
    return out.join("\n");
  }

  async function act(what: "copy" | "csv" | "jpeg") {
    try {
      if (what === "copy") {
        await copyText(sessionMarkdown());
        setNote("Session copied as markdown");
        return;
      }
      if (what === "csv") {
        const tables = sessionTables();
        if (!tables.length) throw new Error("No tabular results in this session yet.");
        download(`${stem}.csv`, csvBlob(sectionedCsv(tables)));
        setNote(`Saved ${tables.length} table${tables.length === 1 ? "" : "s"} to one CSV`);
        return;
      }
      const figures = [...(resultsRef.current?.querySelectorAll<HTMLElement>("figure.figure") ?? [])];
      if (!figures.length) throw new Error("No charts in this session yet.");
      for (let i = 0; i < figures.length; i += 1) {
        const canvas = await rasterizeFigure(figures[i]);
        const label = figures[i].dataset.exportName ?? `chart-${i + 1}`;
        download(`${stem}-${i + 1}-${slug(label)}.jpg`, await canvasBlob(canvas, "image/jpeg"));
        if (i < figures.length - 1) await wait(DOWNLOAD_GAP_MS);
      }
      setNote(`Saved ${figures.length} chart${figures.length === 1 ? "" : "s"} as JPEG`);
    } catch (e) {
      setNote((e as Error).message);
    }
  }

  return (
    <div className="grid">
      <Card
        title="Ask about this dataset"
        hint={`One question in, a full report out: data analysis, visualizations and written insights for ${filename}. Every number comes from a real tool call against the file — nothing is estimated.`}
      >
        <div className="caps">
          {CAPABILITIES.map((c) => (
            <div className="cap" key={c.title}>
              <b>{c.title}</b>
              <span>{c.body}</span>
            </div>
          ))}
        </div>

        <textarea
          rows={3}
          value={question}
          placeholder="e.g. Which passengers were most likely to survive, and what drove it?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(question);
          }}
          style={{ width: "100%", resize: "vertical" }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => run(question)} disabled={running}>
            {running ? "Analysing…" : "Ask"}
          </button>
          {running ? (
            <button className="btn ghost" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <span className="sub" style={{ margin: 0 }}>
              ⌘/Ctrl + Enter to submit
            </span>
          )}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="btn ghost"
              style={{ fontSize: 12, padding: "5px 10px" }}
              disabled={running}
              onClick={() => {
                setQuestion(s);
                run(s);
              }}
            >
              {s.length > 46 ? `${s.slice(0, 46)}…` : s}
            </button>
          ))}
        </div>
      </Card>

      {hasResults ? (
        <div className="exportbar">
          <span className="label">Export this analysis</span>
          <button
            className="btn mini"
            onClick={() => act("csv")}
            title="Every table in this session, as one CSV with a section per result"
          >
            Data (CSV)
          </button>
          <button
            className="btn mini"
            onClick={() => act("jpeg")}
            title="Every chart in this session as a JPEG — the browser will ask before saving several files"
          >
            Charts (JPEG)
          </button>
          <button
            className="btn mini"
            onClick={() => act("copy")}
            title="Copy the whole session — question, tool results, and findings — as markdown"
          >
            Copy all
          </button>
          {note ? (
            <span className="fxnote" role="status">
              {note}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid" ref={resultsRef}>
        {/* One card per tool call, in the order Claude made them. */}
        {steps.map((step) => (
          <Card key={step.id} step={step.id}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <span className="toollog">
                <span className="name">{step.name}</span>
                <span style={{ color: "var(--text-muted)" }}>{argsOf(step.input)}</span>
              </span>
              {step.done ? null : <Spinner label="running" />}
            </div>

            {step.done ? (
              canVisualize(step.name) ? (
                <ToolResultView
                  name={step.name}
                  data={step.data}
                  isError={step.isError ?? false}
                />
              ) : (
                <p className="sub" style={{ margin: 0 }}>
                  Completed — no chart for this tool.
                </p>
              )
            ) : null}
          </Card>
        ))}

        {error ? <Msg kind="err">{error}</Msg> : null}

        {answer ? (
          <Card title="Findings">
            <div data-findings="">
              <Markdown text={answer} />
            </div>
          </Card>
        ) : running && steps.length === 0 ? (
          <Spinner label="Thinking…" />
        ) : null}
      </div>
    </div>
  );
}
