/** Renders a chart from a spec Claude emits inside its answer.
 *
 *  The analyst writes a ```chart fenced block; this turns it into a real chart
 *  placed exactly where the argument needs it. Everything is validated
 *  defensively -- a malformed spec degrades to the raw block, never a crash.
 *
 *  Form rules enforced here rather than left to the model:
 *    * one series  -> sequential single hue, no legend (the title names it)
 *    * many series -> categorical slots in FIXED order, legend always present
 *    * pie         -> slice cap with an "Other" fold, direct % labels, legend
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { ChartTip, Figure, TableView, Tile, axisStyle } from "./ui";

const GRID = "var(--grid)";
const BASELINE = "var(--baseline)";
const SEQ = "var(--seq-450)";

/** Fixed hue order. Never cycled: past slot 8 the tail folds into "Other". */
const SLOTS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
];
const OTHER = "var(--series-other)";

/** More slices than this and angle comparison stops being readable. */
const MAX_SLICES = 6;

export interface Point {
  x: string;
  y: number;
}
export interface Series {
  name: string;
  points: Point[];
}
export interface ChartSpec {
  chart: string;
  title?: string;
  insight?: string;
  x_label?: string;
  y_label?: string;
  unit?: string;
  series: Series[];
}

/** Narrow untrusted JSON into a ChartSpec, or return null. */
export function parseSpec(raw: string): ChartSpec | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.chart !== "string" || !Array.isArray(o.series)) return null;

  const series: Series[] = [];
  for (const s of o.series) {
    if (typeof s !== "object" || s === null) continue;
    const so = s as Record<string, unknown>;
    if (!Array.isArray(so.points)) continue;
    const points: Point[] = [];
    for (const p of so.points) {
      if (typeof p !== "object" || p === null) continue;
      const po = p as Record<string, unknown>;
      const y = typeof po.y === "number" ? po.y : Number(po.y);
      if (!Number.isFinite(y)) continue;
      points.push({ x: String(po.x ?? ""), y });
    }
    if (points.length > 0) series.push({ name: String(so.name ?? "value"), points });
  }
  if (series.length === 0) return null;

  return {
    chart: o.chart.toLowerCase(),
    title: typeof o.title === "string" ? o.title : undefined,
    insight: typeof o.insight === "string" ? o.insight : undefined,
    x_label: typeof o.x_label === "string" ? o.x_label : undefined,
    y_label: typeof o.y_label === "string" ? o.y_label : undefined,
    unit: typeof o.unit === "string" ? o.unit : undefined,
    series,
  };
}

/** Merge series into one row per x value, keyed by series name. */
function toRows(series: Series[]): Record<string, string | number>[] {
  const byX = new Map<string, Record<string, string | number>>();
  for (const s of series) {
    for (const p of s.points) {
      const row = byX.get(p.x) ?? { x: p.x };
      row[s.name] = p.y;
      byX.set(p.x, row);
    }
  }
  return [...byX.values()];
}

function Frame({
  spec,
  chart = true,
  children,
}: {
  spec: ChartSpec;
  /** Stat tiles are markup, not an SVG -- there is nothing to rasterize. */
  chart?: boolean;
  children: React.ReactNode;
}) {
  const multi = spec.series.length > 1;
  const headers = multi
    ? ["Category", ...spec.series.map((s) => s.name)]
    : ["Category", spec.series[0].name];
  const rows = toRows(spec.series).map((r) => [
    String(r.x),
    ...(multi ? spec.series.map((s) => String(r[s.name] ?? "—")) : [String(r[spec.series[0].name] ?? "—")]),
  ]);

  const name = spec.title ?? `${spec.chart}-chart`;

  return (
    <figure className="specchart">
      {spec.title ? <h4 className="h">{spec.title}</h4> : null}
      {spec.insight ? <p className="sub">{spec.insight}</p> : null}
      {chart ? (
        <Figure name={name} title={spec.title} subtitle={spec.insight}>
          {children}
        </Figure>
      ) : (
        children
      )}
      <TableView name={name} headers={headers} rows={rows} />
    </figure>
  );
}

const legendStyle = { fontSize: 12, color: "var(--text-secondary)" } as const;

export function SpecChart({ spec }: { spec: ChartSpec }) {
  const { chart, series, unit } = spec;
  const multi = series.length > 1;
  const rows = toRows(series);

  // --- Stat tiles: a handful of headline numbers is not a chart. ----------
  if (chart === "stat" || chart === "tiles" || chart === "kpi") {
    return (
      <Frame spec={spec} chart={false}>
        <div className="kpis">
          {series[0].points.map((p) => (
            <Tile
              key={p.x}
              label={p.x}
              value={p.y.toLocaleString()}
              sub={unit}
            />
          ))}
        </div>
      </Frame>
    );
  }

  // --- Pie / donut: part-to-whole only. -----------------------------------
  if (chart === "pie" || chart === "donut") {
    const all = [...series[0].points].sort((a, b) => b.y - a.y);
    const head = all.slice(0, MAX_SLICES);
    const tail = all.slice(MAX_SLICES);
    const slices =
      tail.length > 0
        ? [...head, { x: "Other", y: tail.reduce((sum, p) => sum + p.y, 0) }]
        : head;
    const total = slices.reduce((sum, p) => sum + p.y, 0) || 1;

    return (
      <Frame spec={spec}>
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={slices}
              dataKey="y"
              nameKey="x"
              cx="50%"
              cy="50%"
              outerRadius={95}
              innerRadius={chart === "donut" ? 55 : 0}
              paddingAngle={1.5}
              isAnimationActive={false}
              // Direct labels: identity and magnitude never ride on angle alone.
              label={({ name, value }: { name?: string; value?: number }) =>
                `${name} ${(((value ?? 0) / total) * 100).toFixed(0)}%`
              }
              labelLine={{ stroke: BASELINE }}
            >
              {slices.map((p, i) => (
                <Cell
                  key={p.x}
                  fill={p.x === "Other" ? OTHER : SLOTS[i % SLOTS.length]}
                  // 2px surface ring so adjacent fills never merge.
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              ))}
            </Pie>
            <Tooltip content={<ChartTip unit={unit} />} />
            <Legend wrapperStyle={legendStyle} />
          </PieChart>
        </ResponsiveContainer>
      </Frame>
    );
  }

  // --- Scatter: relationship between two numeric measures. ----------------
  if (chart === "scatter") {
    return (
      <Frame spec={spec}>
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart margin={{ top: 10, right: 18, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={GRID} />
            <XAxis
              type="number"
              dataKey="x"
              name={spec.x_label ?? "x"}
              tick={axisStyle}
              stroke={BASELINE}
              tickLine={false}
            />
            <YAxis
              type="number"
              dataKey="y"
              name={spec.y_label ?? "y"}
              tick={axisStyle}
              stroke={BASELINE}
              tickLine={false}
              width={64}
            />
            <ZAxis range={[60, 60]} />
            <Tooltip content={<ChartTip unit={unit} />} cursor={{ stroke: BASELINE }} />
            {multi ? <Legend wrapperStyle={legendStyle} /> : null}
            {series.map((s, i) => (
              <Scatter
                key={s.name}
                name={s.name}
                data={s.points.map((p) => ({ x: Number(p.x), y: p.y }))}
                fill={multi ? SLOTS[i % SLOTS.length] : SEQ}
                isAnimationActive={false}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </Frame>
    );
  }

  // --- Line / area: change across an ordered scale. -----------------------
  if (chart === "line" || chart === "area") {
    const Chart = chart === "area" ? AreaChart : LineChart;
    return (
      <Frame spec={spec}>
        <ResponsiveContainer width="100%" height={300}>
          <Chart data={rows} margin={{ top: 10, right: 18, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="x" tick={axisStyle} stroke={BASELINE} tickLine={false} />
            <YAxis tick={axisStyle} stroke={BASELINE} tickLine={false} width={64} />
            <Tooltip
              content={<ChartTip unit={unit} />}
              cursor={{ stroke: BASELINE, strokeWidth: 1 }}
            />
            {multi ? <Legend wrapperStyle={legendStyle} /> : null}
            {series.map((s, i) =>
              chart === "area" ? (
                <Area
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  stroke={multi ? SLOTS[i % SLOTS.length] : SEQ}
                  fill={multi ? SLOTS[i % SLOTS.length] : SEQ}
                  fillOpacity={0.18}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  stroke={multi ? SLOTS[i % SLOTS.length] : SEQ}
                  strokeWidth={2}
                  dot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }}
                  activeDot={{ r: 5 }}
                  isAnimationActive={false}
                />
              ),
            )}
          </Chart>
        </ResponsiveContainer>
      </Frame>
    );
  }

  // --- Bar (horizontal) / column (vertical): magnitude. -------------------
  const horizontal = chart === "bar";
  const height = horizontal ? Math.max(160, rows.length * 30 + 40) : 300;

  return (
    <Frame spec={spec}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={rows}
          layout={horizontal ? "vertical" : "horizontal"}
          margin={{ top: 8, right: 30, bottom: 4, left: horizontal ? 8 : 0 }}
          barCategoryGap="18%"
        >
          <CartesianGrid stroke={GRID} horizontal={!horizontal} vertical={horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" tick={axisStyle} stroke={BASELINE} tickLine={false} />
              <YAxis
                type="category"
                dataKey="x"
                tick={axisStyle}
                stroke={BASELINE}
                tickLine={false}
                width={140}
              />
            </>
          ) : (
            <>
              <XAxis dataKey="x" tick={axisStyle} stroke={BASELINE} tickLine={false} />
              <YAxis tick={axisStyle} stroke={BASELINE} tickLine={false} width={64} />
            </>
          )}
          <Tooltip content={<ChartTip unit={unit} />} cursor={{ fill: "var(--ghost)" }} />
          {multi ? <Legend wrapperStyle={legendStyle} /> : null}
          {series.map((s, i) => (
            <Bar
              key={s.name}
              dataKey={s.name}
              fill={multi ? SLOTS[i % SLOTS.length] : SEQ}
              radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Frame>
  );
}
