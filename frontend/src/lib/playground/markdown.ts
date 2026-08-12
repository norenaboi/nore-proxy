/**
 * Minimal Markdown renderer for assistant transcript text.
 *
 * Every span of model text passes through `escapeHtml`, and the only tags in the
 * output are the ones this module emits, so the result is safe to inject with
 * `{@html}`. Covers the subset models actually produce: headings, paragraphs,
 * emphasis, inline code, fenced code, lists, blockquotes, horizontal rules,
 * links, and GitHub-style tables.
 */

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Wraps the index of parked inline HTML. NUL is stripped from the source before
 * parsing, so model text can never forge a placeholder.
 */
const MARK = String.fromCharCode(0);
const MARK_PATTERN = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Returns an escaped href, or null when the destination is not a safe target. */
function safeLink(destination: string): string | null {
  const value = destination.trim();
  if (value.startsWith("#") || value.startsWith("/")) return escapeHtml(value);

  try {
    const url = new URL(value);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? escapeHtml(value) : null;
  } catch {
    return null;
  }
}

function renderInline(source: string): string {
  // Code spans and links render first and park behind placeholders so the
  // emphasis passes below cannot reach inside them.
  const parked: string[] = [];
  const park = (html: string): string => `${MARK}${parked.push(html) - 1}${MARK}`;

  let text = source.replace(/`([^`\n]+)`/g, (_match, code: string) => park(`<code>${escapeHtml(code)}</code>`));

  text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, label: string, destination: string) => {
    const href = safeLink(destination);
    if (!href) return escapeHtml(match);
    return park(`<a href="${href}" target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`);
  });

  text = escapeHtml(text)
    .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^\n]+?)__/g, "<strong>$1</strong>")
    .replace(/~~([^\n]+?)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?;:])/g, "$1<em>$2</em>");

  return text.replace(MARK_PATTERN, (_match, index: string) => parked[Number(index)] ?? "");
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Renders a header/divider/body table starting at `start`, or null if there is none. */
function renderTable(lines: string[], start: number): { html: string; next: number } | null {
  const header = lines[start];
  const divider = lines[start + 1];
  if (divider === undefined || !header.includes("|") || !isTableDivider(divider)) return null;

  const headers = tableCells(header);
  const rows: string[][] = [];
  let next = start + 2;
  while (next < lines.length && lines[next].trim() && lines[next].includes("|")) {
    rows.push(tableCells(lines[next]));
    next += 1;
  }

  const head = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${headers.map((_cell, column) => `<td>${renderInline(row[column] ?? "")}</td>`).join("")}</tr>`)
    .join("");

  return {
    // The wrapper is what scrolls, so a wide table cannot stretch the bubble.
    html:
      `<div class="markdown-table"><table><thead><tr>${head}</tr></thead>` +
      `${body ? `<tbody>${body}</tbody>` : ""}</table></div>`,
    next,
  };
}

const HORIZONTAL_RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** True when the line opens a block that must interrupt an open paragraph. */
function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (/^\s*```/.test(line)) return true;
  if (/^\s*#{1,6}\s+/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (HORIZONTAL_RULE.test(line)) return true;
  if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) return true;
  return renderTable(lines, index) !== null;
}

export function renderMarkdown(source: string): string {
  const lines = source
    .replaceAll(MARK, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");

  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([\w+#-]*)/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      // A fence with no closer is normal mid-stream; render what arrived so far.
      if (index < lines.length) index += 1;
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1].toLowerCase())}"` : "";
      output.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const table = renderTable(lines, index);
    if (table) {
      output.push(table.html);
      index = table.next;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoted.push(renderInline(lines[index].replace(/^\s*>\s?/, "")));
        index += 1;
      }
      output.push(`<blockquote>${quoted.join("<br>")}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-+*]\s+(.+)$/;
    const numbered = /^\s*\d+[.)]\s+(.+)$/;
    const listPattern = bullet.test(line) ? bullet : numbered.test(line) ? numbered : null;
    if (listPattern) {
      const tag = listPattern === bullet ? "ul" : "ol";
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item) break;
        items.push(`<li>${renderInline(item[1])}</li>`);
        index += 1;
      }
      output.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph = [renderInline(line.trim())];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(renderInline(lines[index].trim()));
      index += 1;
    }
    output.push(`<p>${paragraph.join("<br>")}</p>`);
  }

  return output.join("");
}
