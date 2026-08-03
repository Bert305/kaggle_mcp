/** Minimal markdown renderer for Claude's findings.
 *
 *  Deliberately small and dependency-free, covering only what the analyst
 *  actually emits: headings, bullets, numbered lists, pipe tables, bold, and
 *  inline code. Everything is built as React elements -- no innerHTML, so model
 *  output can never inject markup.
 */

import type { ReactNode } from "react";

/** Bold and inline code inside a line of text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={`${key}-b${n}`}>{tok.slice(2, -2)}</strong>);
    } else {
      out.push(
        <code key={`${key}-c${n}`} className="icode">
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
    n += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => l.trim().startsWith("|") && l.trim().endsWith("|");
const isDivider = (l: string) => /^\|[\s:|-]+\|$/.test(l.trim());
const cells = (l: string) =>
  l
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];

  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    const key = `p${blocks.length}`;
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
    para = [];
  };

  const flushList = () => {
    if (!list) return;
    const key = `l${blocks.length}`;
    const items = list.items.map((it, i) => <li key={`${key}-${i}`}>{inline(it, `${key}-${i}`)}</li>);
    blocks.push(
      list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>,
    );
    list = null;
  };

  const flushAll = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line ends the current block.
    if (trimmed === "") {
      flushAll();
      continue;
    }

    // Pipe table: header row + divider + body rows.
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flushAll();
      const headers = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(cells(lines[i]));
        i += 1;
      }
      i -= 1;
      const key = `t${blocks.length}`;
      blocks.push(
        <div className="scroll" key={key}>
          <table>
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} className={hi === 0 ? undefined : "num"}>
                    {inline(h, `${key}-h${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci} className={ci === 0 ? undefined : "num"}>
                      {inline(c, `${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Headings.
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const key = `h${blocks.length}`;
      const body = inline(heading[2], key);
      blocks.push(
        heading[1].length <= 2 ? (
          <h3 key={key} className="mdh">
            {body}
          </h3>
        ) : (
          <h4 key={key} className="mdh sm">
            {body}
          </h4>
        ),
      );
      continue;
    }

    // List items.
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      const item = (bullet ?? numbered)![1];
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }

    // Anything else accumulates into a paragraph.
    flushList();
    para.push(trimmed);
  }

  flushAll();
  return <div className="md">{blocks}</div>;
}
