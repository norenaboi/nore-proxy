import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown } from "../frontend/src/lib/playground/markdown.js";

test("markdown renders block structure", () => {
  assert.equal(renderMarkdown("## Heading"), "<h2>Heading</h2>");
  assert.equal(renderMarkdown("plain text"), "<p>plain text</p>");

  // A soft line break inside one paragraph is preserved as a <br>.
  assert.equal(renderMarkdown("one\ntwo"), "<p>one<br>two</p>");
  assert.equal(renderMarkdown("one\n\ntwo"), "<p>one</p><p>two</p>");

  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderMarkdown("> quoted"), "<blockquote>quoted</blockquote>");
  assert.equal(renderMarkdown("---"), "<hr>");

  // A list directly after a paragraph must end the paragraph.
  assert.equal(renderMarkdown("intro:\n- a"), "<p>intro:</p><ul><li>a</li></ul>");
});

test("markdown renders inline emphasis, code, and links", () => {
  assert.equal(renderMarkdown("**bold**"), "<p><strong>bold</strong></p>");
  assert.equal(renderMarkdown("*italic*"), "<p><em>italic</em></p>");
  assert.equal(renderMarkdown("~~gone~~"), "<p><del>gone</del></p>");
  assert.equal(renderMarkdown("use `npm test`"), "<p>use <code>npm test</code></p>");

  assert.equal(
    renderMarkdown("[docs](https://example.com/a)"),
    '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a></p>',
  );

  // Emphasis markers inside a code span are literal text, not formatting.
  assert.equal(renderMarkdown("`a_b_c`"), "<p><code>a_b_c</code></p>");
  // Snake_case identifiers in prose must not become emphasis.
  assert.equal(renderMarkdown("call read_file_sync now"), "<p>call read_file_sync now</p>");
});

test("markdown renders fenced code without interpreting its contents", () => {
  assert.equal(
    renderMarkdown("```ts\nconst a = 1 < 2;\n```"),
    '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
  );

  assert.equal(renderMarkdown("```\n# not a heading\n```"), "<pre><code># not a heading</code></pre>");

  // Streaming delivers an unterminated fence; it must still render.
  assert.equal(renderMarkdown("```\nhalf"), "<pre><code>half</code></pre>");
});

test("markdown renders tables and keeps ragged rows aligned to the header", () => {
  assert.equal(
    renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |"),
    '<div class="markdown-table"><table><thead><tr><th>a</th><th>b</th></tr></thead>' +
      "<tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>",
  );

  // A short row is padded, and an over-long row is truncated to the header width.
  const ragged = renderMarkdown("| a | b |\n| :-- | --: |\n| 1 |\n| 1 | 2 | 3 |");
  assert.equal(ragged.includes("<tr><td>1</td><td></td></tr>"), true);
  assert.equal(ragged.includes("<td>3</td>"), false);

  // A header-like line without a divider is ordinary text.
  assert.equal(renderMarkdown("| a | b |").startsWith("<p>"), true);
});

test("markdown escapes model text so no foreign markup survives", () => {
  assert.equal(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(renderMarkdown("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  assert.equal(renderMarkdown("a & b"), "<p>a &amp; b</p>");

  // Unsafe link protocols keep the literal text rather than becoming an anchor.
  assert.equal(renderMarkdown("[x](javascript:alert(1))").includes("<a "), false);
  assert.equal(renderMarkdown("[x](data:text/html,<script>)").includes("<a "), false);

  // An attribute-breaking destination cannot escape the href quoting.
  const quoted = renderMarkdown('[x](https://example.com/" onmouseover="alert(1))');
  assert.equal(quoted.includes('onmouseover="alert'), false);

  // Bare HTML inside a table cell and a heading is escaped too.
  assert.equal(renderMarkdown("| <b>x</b> |\n| --- |").includes("<b>"), false);
  assert.equal(renderMarkdown("# <b>x</b>"), "<h1>&lt;b&gt;x&lt;/b&gt;</h1>");
});

test("markdown placeholders cannot be forged by model text", () => {
  // The internal marker is stripped from the source, so a crafted index is inert.
  const forged = renderMarkdown(`${String.fromCharCode(0)}0${String.fromCharCode(0)} and \`code\``);
  assert.equal(forged, "<p>0 and <code>code</code></p>");
});
