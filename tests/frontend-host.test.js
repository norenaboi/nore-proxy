import assert from "node:assert/strict";
import test from "node:test";

import { adminPageChunkKey, withFaviconPreload } from "../frontend/server/frontendHost.js";

const TAG = '<link rel="preload" as="image" href="/favicon.ico">';

test("every rendered document preloads the brand mark the shells actually request", () => {
  const html = withFaviconPreload("<html><head>\n    <title>t</title>\n  </head><body></body></html>");

  assert.ok(html.includes(TAG));
  // Ahead of </head>, so the fetch starts while the document is still parsing.
  assert.ok(html.indexOf(TAG) < html.indexOf("</head>"));
  // The URL must be the one the components request at run time. Vite rewrites
  // absolute asset URLs in HTML onto the build base, which is exactly why this
  // tag is injected here instead of being authored into the entry documents.
  assert.equal(html.includes("/assets/app/favicon.ico"), false);
});

test("the preload is not duplicated when a document is rendered again", () => {
  const once = withFaviconPreload("<head></head>");
  const twice = withFaviconPreload(once);

  assert.equal(twice, once);
  assert.equal(twice.split(TAG).length - 1, 1);
});

test("a document without a head is passed through untouched", () => {
  const html = "<html><body>no head</body></html>";
  assert.equal(withFaviconPreload(html), html);
});

test("admin page chunk keys map only well-formed slugs", () => {
  assert.equal(adminPageChunkKey("/admin/model-stats"), "src/admin/pages/ModelStatsPage.svelte");
  assert.equal(adminPageChunkKey("/admin/logs/"), "src/admin/pages/LogsPage.svelte");
  assert.equal(adminPageChunkKey("/admin/Not-Valid"), null);
  assert.equal(adminPageChunkKey("/something/else"), null);
});
