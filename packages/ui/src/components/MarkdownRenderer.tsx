import React from "react";

interface MarkdownRendererProps {
  markdown: string;
  className?: string;
}

interface ListItem {
  text: string;
  checked: boolean | null;
}

interface TableBlock {
  headers: string[];
  rows: string[][];
}

const tableSeparatorRe = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*(?:\s*:?-{3,}:?\s*)?\|?\s*$/;
const listItemRe = /^(\s*)([-+*]|\d+\.)\s+(.*)$/;

function splitTableRow(line: string): string[] {
  let cells = line.trim();
  if (cells.startsWith("|")) cells = cells.slice(1);
  if (cells.endsWith("|")) cells = cells.slice(0, -1);
  return cells.split("|").map((cell) => cell.trim());
}

const SAFE_URL_SCHEMES = ["http:", "https:", "mailto:"];

function isSafeHref(rawHref: string): boolean {
  const href = rawHref.trim().toLowerCase();
  // Relative URLs and fragment-only URLs are safe (but reject protocol-relative "//")
  if (href.startsWith("//")) return false;
  if (
    href.startsWith("/") ||
    href.startsWith("#") ||
    href.startsWith("?") ||
    href.startsWith("./") ||
    href.startsWith("../")
  )
    return true;
  // Allow bare relative paths (no scheme)
  if (!href.includes(":")) return true;
  // Allow only known-safe schemes
  return SAFE_URL_SCHEMES.some((scheme) => href.startsWith(scheme));
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  // Order matters: code first (no nested parsing), then links, then bold, italic, strikethrough
  const tokenRe =
    /`([^`]+)`|\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)|\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|\*(.+?)\*|(?<!\w)_(.+?)_(?!\w)|~~(.+?)~~/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = tokenRe.exec(text);
  let tokenIndex = 0;

  while (match) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }

    if (match[1] != null) {
      // Inline code
      result.push(
        <code
          key={`${keyPrefix}-code-${tokenIndex}`}
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
            padding: "0 4px",
            fontSize: "0.92em",
          }}
        >
          {match[1]}
        </code>,
      );
    } else if (match[2] != null && match[3] != null) {
      // Link
      const href = match[3].trim();
      if (isSafeHref(href)) {
        result.push(
          <a
            key={`${keyPrefix}-link-${tokenIndex}`}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--color-primary)", textDecoration: "underline" }}
          >
            {match[2]}
          </a>,
        );
      } else {
        result.push(match[0]);
      }
    } else if (match[4] != null || match[5] != null) {
      // Bold: **text** or __text__
      result.push(
        <strong key={`${keyPrefix}-bold-${tokenIndex}`}>
          {renderInline(match[4] ?? match[5], `${keyPrefix}-bold-${tokenIndex}`)}
        </strong>,
      );
    } else if (match[6] != null || match[7] != null) {
      // Italic: *text* or _text_
      result.push(
        <em key={`${keyPrefix}-em-${tokenIndex}`}>
          {renderInline(match[6] ?? match[7], `${keyPrefix}-em-${tokenIndex}`)}
        </em>,
      );
    } else if (match[8] != null) {
      // Strikethrough: ~~text~~
      result.push(
        <del key={`${keyPrefix}-del-${tokenIndex}`}>
          {renderInline(match[8], `${keyPrefix}-del-${tokenIndex}`)}
        </del>,
      );
    } else {
      result.push(match[0]);
    }

    lastIndex = tokenRe.lastIndex;
    tokenIndex += 1;
    match = tokenRe.exec(text);
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result;
}

function parseList(
  lines: string[],
  startIndex: number,
): {
  nextIndex: number;
  ordered: boolean;
  items: ListItem[];
} {
  const firstMatch = lines[startIndex]?.match(listItemRe);
  if (!firstMatch) {
    return { nextIndex: startIndex + 1, ordered: false, items: [] };
  }

  const ordered = /\d+\./.test(firstMatch[2]);
  const items: ListItem[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(listItemRe);
    if (!match) break;

    const isOrderedLine = /\d+\./.test(match[2]);
    if (isOrderedLine !== ordered) break;

    const rawText = match[3];
    const check = rawText.match(/^\[( |x|X)\]\s+(.*)$/);
    const checked = check ? check[1].toLowerCase() === "x" : null;
    const baseText = check ? check[2] : rawText;
    let text = baseText;
    i += 1;

    while (i < lines.length) {
      const nextLine = lines[i];
      if (!nextLine.trim()) break;
      if (listItemRe.test(nextLine)) break;
      if (nextLine.startsWith(">") || /^#{1,6}\s/.test(nextLine) || nextLine.startsWith("```"))
        break;
      text += ` ${nextLine.trim()}`;
      i += 1;
    }

    items.push({ text, checked });
    while (i < lines.length && !lines[i].trim()) i += 1;
  }

  return { nextIndex: i, ordered, items };
}

function parseTable(
  lines: string[],
  startIndex: number,
): { nextIndex: number; table: TableBlock | null } {
  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];
  if (!headerLine || !separatorLine) return { nextIndex: startIndex + 1, table: null };
  if (!headerLine.includes("|") || !tableSeparatorRe.test(separatorLine)) {
    return { nextIndex: startIndex + 1, table: null };
  }

  const headers = splitTableRow(headerLine);
  const rows: string[][] = [];
  let i = startIndex + 2;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    const cells = splitTableRow(lines[i]);
    while (cells.length < headers.length) cells.push("");
    rows.push(cells.slice(0, headers.length));
    i += 1;
  }
  return { nextIndex: i, table: { headers, rows } };
}

export function MarkdownRenderer({ markdown, className }: MarkdownRendererProps) {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return (
      <div className={className} style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
        No description
      </div>
    );
  }

  const lines = normalized.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const content: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        content.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].startsWith("```")) i += 1;
      nodes.push(
        <pre
          key={`block-${blockKey}`}
          style={{
            margin: "8px 0",
            padding: "10px 12px",
            background: "#0f172a",
            color: "#e2e8f0",
            borderRadius: 8,
            overflowX: "auto",
          }}
        >
          <code className={language ? `language-${language}` : undefined}>
            {content.join("\n")}
          </code>
        </pre>,
      );
      blockKey += 1;
      continue;
    }

    const tableResult = parseTable(lines, i);
    if (tableResult.table) {
      const { headers, rows } = tableResult.table;
      nodes.push(
        <div key={`block-${blockKey}`} style={{ margin: "8px 0", overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 280 }}>
            <thead>
              <tr>
                {headers.map((header, idx) => (
                  <th
                    key={`h-${idx}`}
                    style={{
                      textAlign: "left",
                      border: "1px solid var(--color-border)",
                      background: "var(--color-bg)",
                      padding: "6px 8px",
                    }}
                  >
                    {renderInline(header, `th-${blockKey}-${idx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={`r-${rowIdx}`}>
                  {row.map((cell, colIdx) => (
                    <td
                      key={`c-${rowIdx}-${colIdx}`}
                      style={{ border: "1px solid var(--color-border)", padding: "6px 8px" }}
                    >
                      {renderInline(cell, `td-${blockKey}-${rowIdx}-${colIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = tableResult.nextIndex;
      blockKey += 1;
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.*)$/);
    if (headingMatch) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const HeadingTag = `h${Math.min(level, 6)}` as keyof JSX.IntrinsicElements;
      nodes.push(
        <HeadingTag key={`block-${blockKey}`} style={{ margin: "10px 0 6px", lineHeight: 1.3 }}>
          {renderInline(headingMatch[1], `heading-${blockKey}`)}
        </HeadingTag>,
      );
      i += 1;
      blockKey += 1;
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      nodes.push(
        <blockquote
          key={`block-${blockKey}`}
          style={{
            margin: "8px 0",
            padding: "6px 12px",
            borderLeft: "3px solid var(--color-text-muted)",
            color: "var(--color-text-secondary)",
            background: "var(--color-bg)",
          }}
        >
          {quoteLines.map((qLine, qIdx) => (
            <React.Fragment key={qIdx}>
              {renderInline(qLine, `quote-${blockKey}-${qIdx}`)}
              {qIdx < quoteLines.length - 1 && <br />}
            </React.Fragment>
          ))}
        </blockquote>,
      );
      blockKey += 1;
      continue;
    }

    if (listItemRe.test(line)) {
      const list = parseList(lines, i);
      const ListTag = list.ordered ? "ol" : "ul";
      nodes.push(
        <ListTag key={`block-${blockKey}`} style={{ margin: "8px 0", paddingLeft: 20 }}>
          {list.items.map((item, itemIdx) => (
            <li key={`li-${itemIdx}`} style={{ margin: "2px 0" }}>
              {item.checked == null ? (
                renderInline(item.text, `li-${blockKey}-${itemIdx}`)
              ) : (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" readOnly checked={item.checked} />
                  <span>{renderInline(item.text, `li-${blockKey}-${itemIdx}`)}</span>
                </label>
              )}
            </li>
          ))}
        </ListTag>,
      );
      i = list.nextIndex;
      blockKey += 1;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim()) {
      const next = lines[i];
      if (next.startsWith("```")) break;
      if (next.startsWith(">")) break;
      if (/^#{1,6}\s+/.test(next)) break;
      if (listItemRe.test(next)) break;
      if (next.includes("|") && tableSeparatorRe.test(lines[i + 1] ?? "")) break;
      paragraph.push(next.trim());
      i += 1;
    }
    nodes.push(
      <p key={`block-${blockKey}`} style={{ margin: "8px 0", lineHeight: 1.6 }}>
        {renderInline(paragraph.join(" "), `paragraph-${blockKey}`)}
      </p>,
    );
    blockKey += 1;
  }

  return (
    <div
      className={className}
      style={{ fontSize: 12, color: "var(--color-text)", lineHeight: 1.6 }}
    >
      {nodes}
    </div>
  );
}
