/** Chart forms, one per data job.
 *
 *  - magnitude (low -> high)   -> bar, SEQUENTIAL one hue
 *  - shape across an ordered scale -> line, one hue
 *
 *  Single-series charts carry no legend box: the title names the series. Every
 *  chart gets a hover tooltip, a recessive grid, and a paired table view.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartTip, Figure, axisStyle } from "./ui";

const GRID = "var(--grid)";
const BASELINE = "var(--baseline)";
const SERIES = "var(--seq-450)";

/** Horizontal magnitude bars -- the right form for long category names. */
export function MagnitudeBarH({
  data,
  nameKey,
  valueKey,
  unit = "",
  height,
  maxDomain,
  labelWidth = 124,
  title,
  exportName,
}: {
  data: Record<string, string | number>[];
  nameKey: string;
  valueKey: string;
  unit?: string;
  height?: number;
  maxDomain?: number;
  labelWidth?: number;
  /** Baked into the exported image, which otherwise has no caption. */
  title?: string;
  exportName?: string;
}) {
  const h = height ?? Math.max(140, data.length * 30 + 34);
  return (
    <Figure
      name={exportName ?? title ?? `${valueKey}-by-${nameKey}`}
      title={title}
      subtitle={unit || undefined}
    >
      <ResponsiveContainer width="100%" height={h}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 34, bottom: 4, left: 8 }}
          barCategoryGap="18%"
        >
          {/* Recessive grid: value-axis lines only. */}
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis
            type="number"
            domain={maxDomain ? [0, maxDomain] : undefined}
            tick={axisStyle}
            stroke={BASELINE}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey={nameKey}
            tick={axisStyle}
            stroke={BASELINE}
            tickLine={false}
            width={labelWidth}
          />
          <Tooltip content={<ChartTip unit={unit} />} cursor={{ fill: "var(--ghost)" }} />
          {/* 4px rounded data-end; the baseline end stays square. */}
          <Bar dataKey={valueKey} fill={SERIES} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </Figure>
  );
}

/**
 * Shape of a distribution across an ordered scale (the five-number summary).
 * A line is the right form here: the x-axis is ordered, so the slope between
 * quartiles *is* the reading -- a steep tail means skew.
 */
export function QuantileLine({
  data,
  height = 260,
  unit = "",
  title,
  exportName,
}: {
  data: { quantile: string; value: number }[];
  height?: number;
  unit?: string;
  title?: string;
  exportName?: string;
}) {
  return (
    <Figure
      name={exportName ?? title ?? "distribution-shape"}
      title={title}
      subtitle={unit || undefined}
    >
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 10, right: 18, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="quantile" tick={axisStyle} stroke={BASELINE} tickLine={false} />
          <YAxis
            tick={axisStyle}
            stroke={BASELINE}
            tickLine={false}
            width={68}
            tickFormatter={(v: number) =>
              Math.abs(v) >= 10000 ? v.toExponential(1) : String(Number(v.toFixed(2)))
            }
          />
          {/* Line charts get a crosshair cursor as well as the tooltip. */}
          <Tooltip
            content={<ChartTip unit={unit} />}
            cursor={{ stroke: BASELINE, strokeWidth: 1 }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={SERIES}
            strokeWidth={2}
            dot={{ r: 4, fill: SERIES, stroke: "var(--surface-1)", strokeWidth: 2 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </Figure>
  );
}
