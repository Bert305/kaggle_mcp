/** Taking the analysis out of the app: CSV, JPEG, and the clipboard.
 *
 *  Two things make this less trivial than `canvas.toBlob`:
 *
 *  1. Chart colours are CSS custom properties (`fill="var(--seq-450)"`). A
 *     serialized SVG is rendered in its own isolated document where those
 *     variables do not exist, so every fill would come back black. `cloneStyled`
 *     resolves the computed value of each paint property onto a detached clone
 *     first.
 *  2. Recharts renders the legend as HTML *outside* the SVG, so a multi-series
 *     export would lose its key. `readLegend` pulls it back out of the DOM and
 *     `rasterize` redraws it onto the canvas under the chart.
 *
 *  Reading tables out of the DOM rather than out of component state is
 *  deliberate: the export is then exactly what is on screen, and there is only
 *  one place that decides how a payload becomes rows.
 */

// --------------------------------------------------------------- files --- //

/** Trigger a browser download for an in-memory blob. */
export function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "export"
  );
}

/** `20260822-1403` — sortable, and safe in a filename on every platform. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ----------------------------------------------------------------- csv --- //

const NEEDS_QUOTE = /[",\r\n]/;
/** Excel executes a cell that opens with one of these. */
const FORMULA = /^[=+\-@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  // Guard against CSV injection, but never mangle a plain negative number.
  if (FORMULA.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** U+FEFF. Written as an escape: a bare BOM in source is invisible and does
 *  not survive an editor that re-saves the file in another encoding. */
const BOM = "\uFEFF";

/** A BOM so Excel reads UTF-8 instead of the machine's ANSI codepage. */
export function csvBlob(body: string): Blob {
  return new Blob([BOM, body], { type: "text/csv;charset=utf-8" });
}

/**
 * One file holding several tables, each under a `# name` line. Not strict
 * RFC 4180, but it keeps a whole session in a single download and every
 * spreadsheet imports it.
 */
export function sectionedCsv(tables: TableData[]): string {
  return tables
    .map((t) => `# ${t.name}\r\n${toCsv(t.headers, t.rows)}`)
    .join("\r\n\r\n");
}

// ------------------------------------------------------------ markdown --- //

const mdCell = (s: string) => s.replace(/\|/g, "\\|");

export function toMarkdownTable(t: TableData): string {
  const head = `| ${t.headers.map(mdCell).join(" | ")} |`;
  const rule = `| ${t.headers.map(() => "---").join(" | ")} |`;
  const body = t.rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

// ------------------------------------------------- reading back the DOM --- //

export interface TableData {
  name: string;
  headers: string[];
  rows: string[][];
}

export interface LegendItem {
  label: string;
  color: string;
}

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";

/** The nearest human label above a table: its own summary, else the card heading. */
function tableName(table: HTMLTableElement, index: number): string {
  const details = table.closest("details.tableview");
  const summary = text(details?.querySelector(":scope > summary"));
  const figure = text(table.closest("figure")?.querySelector(":scope > .h"));
  const heading = text(table.closest(".card, [data-step]")?.querySelector(".h"));
  return figure || summary || heading || `table ${index + 1}`;
}

export function readTable(table: HTMLTableElement, name: string): TableData {
  const headers = [...table.querySelectorAll("thead th")].map(text);
  const rows = [...table.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td")].map(text),
  );
  return { name, headers, rows };
}

/** Stat tiles carry real numbers (rows, accuracy, R²) that are in no table. */
export function readTiles(root: ParentNode, name = "Summary"): TableData | null {
  const rows = [...root.querySelectorAll(".tile")].map((t) => [
    text(t.querySelector(".label")),
    text(t.querySelector(".value")),
    text(t.querySelector(".sub")),
  ]);
  return rows.length ? { name, headers: ["Metric", "Value", "Note"], rows } : null;
}

export function collectTables(root: ParentNode): TableData[] {
  const tiles = readTiles(root);
  const tables = [...root.querySelectorAll("table")].map((t, i) =>
    readTable(t as HTMLTableElement, tableName(t as HTMLTableElement, i)),
  );
  return [...(tiles ? [tiles] : []), ...tables].filter((t) => t.rows.length > 0);
}

export function readLegend(root: ParentNode): LegendItem[] {
  return [...root.querySelectorAll(".recharts-legend-item")]
    .map((item) => {
      const icon = item.querySelector("path, rect, line, circle");
      const cs = icon ? getComputedStyle(icon) : null;
      const paint = [cs?.fill, cs?.stroke].find((c) => c && c !== "none" && !/rgba\(0, 0, 0, 0\)/.test(c));
      return {
        label: text(item.querySelector(".recharts-legend-item-text")) || text(item),
        color: paint ?? "#888888",
      };
    })
    .filter((i) => i.label);
}

// -------------------------------------------------------------- raster --- //

/** Paint and type properties worth carrying onto the detached clone. */
const PAINT = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
];

/** Only present while the pointer is over the chart — never part of an export. */
const TRANSIENT = ".recharts-tooltip-cursor, .recharts-active-dot";

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function cloneStyled(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")];
  const dst = [clone, ...clone.querySelectorAll("*")];

  for (let i = 0; i < src.length && i < dst.length; i += 1) {
    const cs = getComputedStyle(src[i]);
    let css = "";
    for (const prop of PAINT) {
      const v = cs.getPropertyValue(prop);
      if (v) css += `${prop}:${v};`;
    }
    dst[i].setAttribute("style", css);
  }

  for (const el of clone.querySelectorAll(TRANSIENT)) el.remove();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return clone;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The chart could not be rendered to an image."));
    img.src = src;
  });
}

export interface RasterOptions {
  title?: string;
  subtitle?: string;
  legend?: LegendItem[];
  scale?: number;
}

const PAD = 18;
const TITLE_H = 24;
const SUB_H = 18;
const LEGEND_ROW = 20;
const LEGEND_COLS = 4;

/** Cut `s` to fit `max` px under the current ctx font, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * Draw a chart onto a canvas: title, the chart itself, then the legend.
 * Accepts either a live Recharts `<svg>` or an already-loaded `<img>` (the
 * matplotlib PNG from `plot_distribution` takes the second path).
 */
export async function rasterize(
  source: SVGSVGElement | HTMLImageElement,
  opts: RasterOptions = {},
): Promise<HTMLCanvasElement> {
  const scale = opts.scale ?? Math.min(3, Math.max(2, window.devicePixelRatio || 1));
  const bg = cssVar("--surface-1", "#ffffff");
  const ink = cssVar("--text-primary", "#111111");
  const muted = cssVar("--text-secondary", "#555555");
  const font = cssVar("--font", "system-ui, sans-serif");

  let bitmap: CanvasImageSource;
  let w: number;
  let h: number;

  if (source instanceof HTMLImageElement) {
    bitmap = source.complete && source.naturalWidth > 0 ? source : await loadImage(source.src);
    w = (bitmap as HTMLImageElement).naturalWidth;
    h = (bitmap as HTMLImageElement).naturalHeight;
  } else {
    const rect = source.getBoundingClientRect();
    w = Math.round(rect.width);
    h = Math.round(rect.height);
    if (w < 2 || h < 2) throw new Error("The chart is not visible, so it cannot be exported.");
    const clone = cloneStyled(source);
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const xml = new XMLSerializer().serializeToString(clone);
    bitmap = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
  }

  const legend = opts.legend ?? [];
  const titleH = opts.title ? TITLE_H : 0;
  const subH = opts.subtitle ? SUB_H : 0;
  const legendH = legend.length ? LEGEND_ROW * Math.ceil(legend.length / LEGEND_COLS) + 8 : 0;
  const cw = w + PAD * 2;
  const ch = h + PAD * 2 + titleH + subH + legendH;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser did not provide a 2D canvas.");
  ctx.scale(scale, scale);

  // JPEG has no alpha channel: unpainted pixels come out black, not white.
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cw, ch);
  ctx.textBaseline = "top";

  let y = PAD;
  if (opts.title) {
    ctx.fillStyle = ink;
    ctx.font = `600 15px ${font}`;
    ctx.fillText(fit(ctx, opts.title, w), PAD, y);
    y += TITLE_H;
  }
  if (opts.subtitle) {
    ctx.fillStyle = muted;
    ctx.font = `12px ${font}`;
    ctx.fillText(fit(ctx, opts.subtitle, w), PAD, y);
    y += SUB_H;
  }

  ctx.drawImage(bitmap, PAD, y, w, h);
  y += h + 8;

  if (legend.length) {
    ctx.font = `12px ${font}`;
    ctx.textBaseline = "middle";
    const colW = w / LEGEND_COLS;
    legend.forEach((item, i) => {
      const x = PAD + (i % LEGEND_COLS) * colW;
      const cy = y + Math.floor(i / LEGEND_COLS) * LEGEND_ROW + LEGEND_ROW / 2;
      ctx.fillStyle = item.color;
      ctx.fillRect(x, cy - 5, 10, 10);
      ctx.fillStyle = muted;
      ctx.fillText(fit(ctx, item.label, colW - 22), x + 16, cy);
    });
  }

  return canvas;
}

export function canvasBlob(
  canvas: HTMLCanvasElement,
  type: "image/jpeg" | "image/png" = "image/jpeg",
  quality = 0.94,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))),
      type,
      quality,
    );
  });
}

/**
 * Rasterize a `<figure>` rendered by the `Figure` component. Title and subtitle
 * ride along as data attributes so a bulk export can find them in the DOM.
 */
export async function rasterizeFigure(fig: HTMLElement): Promise<HTMLCanvasElement> {
  const svg =
    fig.querySelector<SVGSVGElement>("svg.recharts-surface") ??
    fig.querySelector<SVGSVGElement>("svg");
  const source = svg ?? fig.querySelector<HTMLImageElement>("img");
  if (!source) throw new Error("There is no chart in this card to export.");
  return rasterize(source, {
    title: fig.dataset.exportTitle || undefined,
    subtitle: fig.dataset.exportSubtitle || undefined,
    legend: svg ? readLegend(fig) : [],
  });
}

// ----------------------------------------------------------- clipboard --- //

/** Firefox has no `ClipboardItem`, so image copy is offered only where it works. */
export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/** The clipboard image type must be PNG — Chrome rejects a JPEG blob. */
export async function copyImage(png: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export async function copyText(s: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(s);
    return;
  }
  // `navigator.clipboard` is undefined outside a secure context (an app served
  // over plain http from a LAN address, say), so keep the old path as a fallback.
  const ta = document.createElement("textarea");
  ta.value = s;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("This browser blocked the copy.");
}
