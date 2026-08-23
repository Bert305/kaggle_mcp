import { useCallback, useEffect, useRef, useState } from "react";

import { api, type DatasetRow } from "./api";
import { Ask } from "./panels/Ask";
import { Code } from "./panels/Code";
import { Model } from "./panels/Model";
import { Overview } from "./panels/Overview";
import { Msg } from "./ui";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "model", label: "Model" },
  { id: "ask", label: "Ask Claude" },
  { id: "code", label: "Generate code" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Theme toggle: an explicit stamp must beat the OS preference both ways. */
function useTheme() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("theme") as "light" | "dark" | null) ?? "system",
  );
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
      localStorage.removeItem("theme");
    } else {
      root.setAttribute("data-theme", theme);
      localStorage.setItem("theme", theme);
    }
  }, [theme]);
  return { theme, setTheme };
}

export default function App() {
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("overview");
  const [status, setStatus] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { theme, setTheme } = useTheme();

  const load = useCallback(
    async (select?: string) => {
      try {
        const rows = await api.datasets();
        setDatasets(rows);
        setFatal(null);
        setActive((prev) => select ?? prev ?? rows[0]?.filename ?? null);
      } catch (e) {
        setFatal(
          `Cannot reach the API (${(e as Error).message}). Is the backend running on port 8000?`,
        );
      }
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setStatus("Only .csv files are supported.");
      return;
    }
    setStatus(`Uploading ${file.name}…`);
    try {
      const res = await api.upload(file);
      setStatus(
        `${res.replaced ? "Replaced" : "Added"} ${res.filename} (${(res.bytes / 1024).toFixed(0)} KB)`,
      );
      await load(res.filename);
      setTab("overview");
    } catch (e) {
      setStatus(`Upload failed: ${(e as Error).message}`);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Kaggle Dataset Analyst
          <small>React → FastAPI → MCP → pandas / scikit-learn</small>
        </div>

        <div>
          <div className="label" style={{ color: "var(--text-muted)", fontSize: 11 }}>
            DATASETS
          </div>
          <div className="datasets">
            {datasets.map((d) => (
              <button
                key={d.filename}
                className="dataset"
                aria-current={d.filename === active}
                onClick={() => setActive(d.filename)}
              >
                <span>{d.filename}</span>
                <span>
                  {d.columns} cols · {d.size_kb.toFixed(0)} KB
                </span>
              </button>
            ))}
            {datasets.length === 0 && !fatal ? (
              <span className="sub">No datasets yet — upload one below.</span>
            ) : null}
          </div>
        </div>

        <div
          className={`drop${dragging ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
        >
          Drop a CSV here {" "}
          <button
            className="btn ghost"
            style={{ padding: "3px 9px", fontSize: 12 }}
            onClick={() => fileInput.current?.click()}
          >
            browse
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
        </div>

        {status ? <div className="sub">{status}</div> : null}

        <div style={{ marginTop: "auto" }}>
          <div className="field">
            <label htmlFor="theme">Appearance</label>
            <select
              id="theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value as "system" | "light" | "dark")}
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>
      </aside>

      <main className="main">
        {fatal ? <Msg kind="err">{fatal}</Msg> : null}

        {active ? (
          <>
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className="tab"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "overview" ? <Overview filename={active} /> : null}
            {tab === "model" ? <Model filename={active} /> : null}
            {tab === "ask" ? <Ask filename={active} /> : null}
            {tab === "code" ? <Code filename={active} /> : null}
          </>
        ) : !fatal ? (
          <Msg>Upload a CSV to get started.</Msg>
        ) : null}
      </main>
    </div>
  );
}
