/** Typed client for the FastAPI backend (which in turn speaks MCP). */

export interface DatasetRow {
  filename: string;
  columns: number;
  size_kb: number;
}

export interface ColumnInfo {
  name: string;
  dtype: string;
  n_unique: number;
  n_missing: number;
}

export interface Profile {
  filename: string;
  n_rows: number;
  n_columns: number;
  columns: ColumnInfo[];
  numeric_summary: Record<string, Record<string, number>>;
  sample: Record<string, unknown>[];
}

export interface MissingReport {
  filename?: string;
  n_rows?: number;
  missing?: { column: string; n_missing: number; pct_missing: number }[];
  message?: string;
}

export interface TrainResult {
  filename: string;
  target: string;
  task: "classification" | "regression";
  n_train: number;
  n_test: number;
  features_used: string[];
  metrics: Record<string, unknown>;
  top_features: { feature: string; importance: number }[];
  saved_model: string;
}

export interface SavedModel {
  model: string;
  target?: string;
  task?: string;
  features?: string[];
}

export interface PredictResult {
  model: string;
  target: string;
  task: string | null;
  n_predicted: number;
  predictions: Record<string, unknown>[];
}

export interface Generated {
  title: string;
  code: string;
  explanation: string;
  assumptions: string[];
}

export type AskEvent =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      name: string;
      is_error: boolean;
      data: unknown;
    }
  | { type: "done" }
  | { type: "error"; message: string };

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  health: () => req<{ ok: boolean; tools: string[]; prompts: string[] }>("/api/health"),

  datasets: () => req<DatasetRow[]>("/api/datasets"),

  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return req<{ filename: string; bytes: number; replaced: boolean }>("/api/upload", {
      method: "POST",
      body: form,
    });
  },

  profile: (f: string) => req<Profile>(`/api/dataset/${encodeURIComponent(f)}/profile`),

  missing: (f: string) =>
    req<MissingReport>(`/api/dataset/${encodeURIComponent(f)}/missing`),

  train: (body: {
    filename: string;
    target: string;
    features?: string[];
    task?: string;
  }) => req<TrainResult>("/api/train", json(body)),

  models: () => req<SavedModel[]>("/api/models"),

  predict: (model: string, records: Record<string, unknown>[]) =>
    req<PredictResult>("/api/predict", json({ model, records })),

  generate: (language: "python" | "sql" | "ml", filename: string, goal: string) =>
    req<Generated>("/api/generate", json({ language, filename, goal })),

  /**
   * Stream the agent loop. EventSource cannot POST, so this reads the SSE body
   * off fetch directly and splits on the blank-line record separator.
   */
  async ask(
    question: string,
    filename: string | null,
    onEvent: (e: AskEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch("/api/ask", {
      ...json({ question, filename }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const record = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of record.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            onEvent(JSON.parse(line.slice(5).trim()) as AskEvent);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    }
  },
};
