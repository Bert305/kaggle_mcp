import { useRef, useState } from "react";

import { api, type AskEvent } from "../api";
import { Markdown } from "../Markdown";
import { ToolResultView, canVisualize } from "../ToolResultView";
import { Card, Msg, Spinner } from "../ui";

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

export function Ask({ filename }: { filename: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function run(q: string) {
    if (!q.trim() || running) return;
    setRunning(true);
    setAnswer("");
    setSteps([]);
    setError(null);

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

  return (
    <div className="grid">
      <Card
        title="Ask about this dataset"
        hint={`Claude answers by calling the same MCP tools this app uses, against ${filename}. Each tool's real output is charted below as it runs.`}
      >
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

      {/* One card per tool call, in the order Claude made them. */}
      {steps.map((step) => (
        <Card key={step.id}>
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
          <Markdown text={answer} />
        </Card>
      ) : running && steps.length === 0 ? (
        <Spinner label="Thinking…" />
      ) : null}
    </div>
  );
}
