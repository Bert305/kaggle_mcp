/** Renders a chart for whatever tool Claude just ran.
 *
 *  The Ask tab streams real tool payloads, so the visuals here are the agent's
 *  own evidence -- not a re-derivation. Every branch narrows `unknown` defensively:
 *  a tool can also return a plain sentence (e.g. "No missing values found").
 */

import type { ReactNode } from "react";

import { MagnitudeBarH, QuantileLine } from "./charts";
import { Msg, TableView, Tile } from "./ui";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function rows<T>(v: unknown, pick: (o: Obj) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map(pick).filter((x): x is T => x !== null);
}

/** A tool that returned prose instead of data. */
function Message({ data }: { data: unknown }) {
  const m = isObj(data) ? str(data.message) : undefined;
  return m ? <Msg>{m}</Msg> : null;
}

/**
 * plot_distribution returns a sentence containing the saved path. Pull the
 * filename out and serve it back through the API so the plot renders inline --
 * otherwise the PNG is written to disk where the browser can never see it.
 */
function PlotView({ data }: { data: unknown }) {
  const message = isObj(data) ? (str(data.message) ?? "") : "";
  const match = /([A-Za-z0-9._ -]+\.png)/.exec(message);
  if (!match) return <Message data={data} />;
  const file = match[1];
  return (
    <figure style={{ margin: 0 }}>
      <img
        src={`/api/outputs/${encodeURIComponent(file)}`}
        alt={`Distribution plot: ${file}`}
        style={{
          maxWidth: "100%",
          height: "auto",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "#fff",
        }}
      />
      <figcaption className="sub" style={{ marginTop: 6, marginBottom: 0 }}>
        {file} — saved to outputs/
      </figcaption>
    </figure>
  );
}

function Missing({ data }: { data: unknown }) {
  if (!isObj(data)) return null;
  const bars = rows(data.missing, (o) => {
    const column = str(o.column);
    const pct = num(o.pct_missing);
    return column !== undefined && pct !== undefined
      ? { column, percent: pct, count: num(o.n_missing) ?? 0 }
      : null;
  });
  if (bars.length === 0) return <Message data={data} />;
  return (
    <>
      <MagnitudeBarH
        data={bars.map(({ column, percent }) => ({ column, percent }))}
        nameKey="column"
        valueKey="percent"
        unit="% of rows"
        maxDomain={100}
      />
      <TableView
        headers={["Column", "Missing", "% of rows"]}
        rows={bars.map((b) => [b.column, b.count, b.percent.toFixed(2)])}
      />
    </>
  );
}

function ProfileView({ data }: { data: unknown }) {
  if (!isObj(data)) return null;
  const nRows = num(data.n_rows);
  const nCols = num(data.n_columns);
  if (nRows === undefined) return <Message data={data} />;

  const cols = rows(data.columns, (o) => {
    const name = str(o.name);
    return name ? { name, dtype: str(o.dtype) ?? "?", missing: num(o.n_missing) ?? 0 } : null;
  });
  const withGaps = cols.filter((c) => c.missing > 0).length;

  // Show the shape of the first numeric column as a concrete readout.
  const summary = isObj(data.numeric_summary) ? data.numeric_summary : {};
  const firstNumeric = Object.keys(summary)[0];
  const s = firstNumeric && isObj(summary[firstNumeric]) ? (summary[firstNumeric] as Obj) : undefined;
  const quantiles: { quantile: string; value: number }[] = [];
  if (s) {
    const pairs: [string, string][] = [
      ["min", "min"],
      ["25%", "25th"],
      ["50%", "median"],
      ["75%", "75th"],
      ["max", "max"],
    ];
    for (const [key, label] of pairs) {
      const v = num(s[key]);
      if (v !== undefined) quantiles.push({ quantile: label, value: v });
    }
  }

  return (
    <>
      <div className="kpis" style={{ marginBottom: quantiles.length ? 14 : 0 }}>
        <Tile label="Rows" value={nRows.toLocaleString()} />
        <Tile label="Columns" value={nCols ?? cols.length} />
        <Tile label="Columns with gaps" value={withGaps} />
      </div>
      {quantiles.length > 0 ? (
        <>
          <h3 className="h">Shape of {firstNumeric}</h3>
          <p className="sub">Five-number summary of the first numeric column.</p>
          <QuantileLine data={quantiles} height={220} />
        </>
      ) : null}
      <TableView
        summary="View schema as table"
        headers={["Column", "Dtype", "Missing"]}
        rows={cols.map((c) => [c.name, c.dtype, c.missing])}
      />
    </>
  );
}

function TrainView({ data }: { data: unknown }) {
  if (!isObj(data)) return null;
  const task = str(data.task);
  if (!task) return <Message data={data} />;
  const metrics = isObj(data.metrics) ? data.metrics : {};
  const feats = rows(data.top_features, (o) => {
    const feature = str(o.feature);
    const importance = num(o.importance);
    return feature !== undefined && importance !== undefined ? { feature, importance } : null;
  });

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Tile label="Task" value={task} sub={`target: ${str(data.target) ?? "?"}`} />
        {task === "classification" ? (
          <Tile
            label="Accuracy"
            value={`${((num(metrics.accuracy) ?? 0) * 100).toFixed(1)}%`}
            sub="held-out split"
          />
        ) : (
          <>
            <Tile label="R²" value={(num(metrics.r2) ?? 0).toFixed(3)} />
            <Tile label="RMSE" value={(num(metrics.rmse) ?? 0).toFixed(3)} />
          </>
        )}
        <Tile
          label="Split"
          value={`${num(data.n_train) ?? "?"} / ${num(data.n_test) ?? "?"}`}
          sub="train / test"
        />
      </div>
      {feats.length > 0 ? (
        <>
          <h3 className="h">What drives the prediction</h3>
          <MagnitudeBarH
            data={feats.slice(0, 10).map((f) => ({
              feature: f.feature.replace(/^(num|cat)__/, ""),
              importance: Number(f.importance.toFixed(4)),
            }))}
            nameKey="feature"
            valueKey="importance"
            labelWidth={150}
          />
          <TableView
            headers={["Feature", "Importance"]}
            rows={feats.map((f) => [f.feature, f.importance.toFixed(4)])}
          />
        </>
      ) : null}
    </>
  );
}

function PredictView({ data }: { data: unknown }) {
  if (!isObj(data)) return null;
  const target = str(data.target);
  const preds = Array.isArray(data.predictions) ? data.predictions.filter(isObj) : [];
  if (!target || preds.length === 0) return <Message data={data} />;

  if (preds.length === 1) {
    const conf = num(preds[0].confidence);
    return (
      <div>
        <div className="label" style={{ color: "var(--text-muted)" }}>
          Predicted {target}
        </div>
        <div className="hero">{String(preds[0][target])}</div>
        {conf !== undefined ? (
          <div className="sub">confidence {(conf * 100).toFixed(1)}%</div>
        ) : null}
      </div>
    );
  }

  const keys = Object.keys(preds[0]);
  return (
    <>
      <p className="sub" style={{ marginTop: 0 }}>
        {num(data.n_predicted) ?? preds.length} rows scored
        {data.truncated ? " (preview truncated)" : ""}.
      </p>
      <TableView
        summary={`View ${preds.length} predictions`}
        headers={keys}
        rows={preds.map((p) => keys.map((k) => String(p[k])))}
      />
    </>
  );
}

function ListView({ data, kind }: { data: unknown; kind: "datasets" | "models" }) {
  if (!Array.isArray(data)) return <Message data={data} />;
  const items = data.filter(isObj);
  if (items.length === 0) return null;
  if (kind === "datasets") {
    return (
      <TableView
        summary={`${items.length} datasets`}
        headers={["File", "Columns", "KB"]}
        rows={items.map((d) => [
          str(d.filename) ?? "?",
          num(d.columns) ?? "?",
          num(d.size_kb)?.toFixed(0) ?? "?",
        ])}
      />
    );
  }
  return (
    <TableView
      summary={`${items.length} saved models`}
      headers={["Model", "Target", "Task"]}
      rows={items.map((m) => [
        str(m.model) ?? "?",
        str(m.target) ?? "—",
        str(m.task) ?? "—",
      ])}
    />
  );
}

/** Tools whose payloads we render. Anything else is skipped silently. */
const RENDERERS: Record<string, (data: unknown) => ReactNode> = {
  profile_dataset: (d) => <ProfileView data={d} />,
  detect_missing_values: (d) => <Missing data={d} />,
  train_model: (d) => <TrainView data={d} />,
  predict: (d) => <PredictView data={d} />,
  list_datasets: (d) => <ListView data={d} kind="datasets" />,
  list_models: (d) => <ListView data={d} kind="models" />,
  plot_distribution: (d) => <PlotView data={d} />,
};

export function canVisualize(name: string): boolean {
  return name in RENDERERS;
}

export function ToolResultView({
  name,
  data,
  isError,
}: {
  name: string;
  data: unknown;
  isError: boolean;
}) {
  if (isError) {
    const m = isObj(data) ? str(data.message) : undefined;
    return <Msg kind="err">{name} failed{m ? `: ${m}` : "."}</Msg>;
  }
  const render = RENDERERS[name];
  return render ? <>{render(data)}</> : null;
}
