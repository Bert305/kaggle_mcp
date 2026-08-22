/** Small shared primitives: tiles, messages, tooltips, table views. */

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  canCopyImage,
  canvasBlob,
  copyImage,
  copyText,
  csvBlob,
  download,
  rasterizeFigure,
  slug,
  toCsv,
  toMarkdownTable,
} from "./exporting";

/** A transient "Saved"/"Copied"/error line next to an export control. */
function useFlash(): [string | null, (run: () => Promise<string>) => Promise<void>] {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const act = useCallback(async (run: () => Promise<string>) => {
    window.clearTimeout(timer.current);
    try {
      setNote(await run());
    } catch (e) {
      setNote((e as Error).message);
    }
    timer.current = window.setTimeout(() => setNote(null), 2600);
  }, []);

  return [note, act];
}

function Flash({ note }: { note: string | null }) {
  return note ? (
    <span className="fxnote" role="status">
      {note}
    </span>
  ) : null;
}

/**
 * Wraps a chart so it can leave the app as an image.
 *
 * `title`/`subtitle` are not rendered — the call sites already show a heading.
 * They are baked into the exported picture, which otherwise arrives with no
 * indication of what it plots, and they ride on data attributes so the Ask
 * tab's "export every chart" pass can read them straight off the DOM.
 */
export function Figure({
  name,
  title,
  subtitle,
  children,
}: {
  name: string;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [note, act] = useFlash();

  const run = (kind: "jpeg" | "copy") => () =>
    act(async () => {
      const fig = ref.current;
      if (!fig) throw new Error("Nothing to export yet.");
      const canvas = await rasterizeFigure(fig);
      if (kind === "jpeg") {
        download(`${slug(name)}.jpg`, await canvasBlob(canvas, "image/jpeg"));
        return "Saved JPEG";
      }
      await copyImage(await canvasBlob(canvas, "image/png"));
      return "Copied image";
    });

  return (
    <figure
      className="figure"
      ref={ref}
      data-export-title={title}
      data-export-subtitle={subtitle}
      data-export-name={name}
    >
      <div className="fx">
        <Flash note={note} />
        <button className="btn mini" onClick={run("jpeg")} title="Download this chart as a JPEG">
          JPEG
        </button>
        {canCopyImage() ? (
          <button className="btn mini" onClick={run("copy")} title="Copy this chart as an image">
            Copy
          </button>
        ) : null}
      </div>
      {children}
    </figure>
  );
}

export function Tile({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function Card({
  title,
  hint,
  step,
  children,
}: {
  title?: string;
  hint?: string;
  /** Tags the card with the tool call it shows, so a bulk export can group by it. */
  step?: string;
  children: ReactNode;
}) {
  return (
    <section className="card" data-step={step}>
      {title ? <h2 className="h">{title}</h2> : null}
      {hint ? <p className="sub">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Msg({
  kind = "info",
  children,
}: {
  kind?: "info" | "err" | "ok";
  children: ReactNode;
}) {
  return <div className={`msg ${kind === "info" ? "" : kind}`}>{children}</div>;
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="row" style={{ gap: 8, color: "var(--text-secondary)" }}>
      <span className="spin" aria-hidden="true" />
      <span role="status">{label}</span>
    </span>
  );
}

/** Every chart ships a table view so meaning never rides on color alone. */
export function TableView({
  summary = "View as table",
  name,
  headers,
  rows,
}: {
  summary?: string;
  /** Filename stem for the CSV. Defaults to the summary text. */
  name?: string;
  headers: string[];
  rows: (string | number)[][];
}) {
  const [note, act] = useFlash();
  const stem = slug(name ?? summary);

  const save = () =>
    act(async () => {
      download(`${stem}.csv`, csvBlob(toCsv(headers, rows)));
      return "Saved CSV";
    });

  const copy = () =>
    act(async () => {
      await copyText(toMarkdownTable({ name: stem, headers, rows: rows.map((r) => r.map(String)) }));
      return "Copied";
    });

  return (
    <details className="tableview">
      <summary>{summary}</summary>
      <div className="fx">
        <Flash note={note} />
        <button className="btn mini" onClick={save} title="Download these rows as a CSV">
          CSV
        </button>
        <button className="btn mini" onClick={copy} title="Copy these rows as a markdown table">
          Copy
        </button>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={h} className={i === 0 ? undefined : "num"}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} className={ci === 0 ? undefined : "num"}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Tooltip body in text tokens -- never the series color. */
export function ChartTip({
  active,
  payload,
  label,
  unit = "",
}: {
  active?: boolean;
  payload?: { name?: string; value?: number | string }[];
  label?: string | number;
  unit?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <div className="k">{label}</div>
      {payload.map((p, i) => (
        <div key={i}>
          <span className="v">
            {typeof p.value === "number" ? p.value.toLocaleString() : p.value}
          </span>
          {unit ? <span className="k"> {unit}</span> : null}
        </div>
      ))}
    </div>
  );
}

export const axisStyle = { fill: "var(--text-muted)", fontSize: 11 } as const;
