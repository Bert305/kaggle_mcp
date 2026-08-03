/** Small shared primitives: tiles, messages, tooltips, table views. */

import type { ReactNode } from "react";

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
  children,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card">
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
  headers,
  rows,
}: {
  summary?: string;
  headers: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="tableview">
      <summary>{summary}</summary>
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
