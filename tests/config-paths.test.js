import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { ensureJsonAtomic } from "../utils/atomicJson.js";
import { resolveConfigPath } from "../utils/configPaths.js";

// Pure path resolution with an injected root, so the fallback cases never
// create files at the repository root or inside the deployed data/ directory.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nore-config-paths-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("an explicit *_PATH override wins outright, disabling the data/ default and fallback", () => {
  assert.equal(
    resolveConfigPath("/elsewhere/endpoints.json", "endpoints.json", scratch),
    "/elsewhere/endpoints.json",
  );
});

test("with no override and no files anywhere, the data/ location is the default", () => {
  assert.equal(
    resolveConfigPath(undefined, "endpoints.json", scratch),
    path.join(scratch, "data", "endpoints.json"),
  );
});

test("a legacy repository-root file is used while data/ has no copy", () => {
  fs.writeFileSync(path.join(scratch, "settings.json"), "{}");
  assert.equal(
    resolveConfigPath(undefined, "settings.json", scratch),
    path.join(scratch, "settings.json"),
  );
});

test("a data/ copy wins over a legacy repository-root file", () => {
  fs.mkdirSync(path.join(scratch, "data"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "data", "settings.json"), "{}");
  assert.equal(
    resolveConfigPath(undefined, "settings.json", scratch),
    path.join(scratch, "data", "settings.json"),
  );
});

test("ensureJsonAtomic creates a missing file with the initial document and never overwrites", () => {
  const created = path.join(scratch, "proxies.json");
  assert.equal(ensureJsonAtomic(created, { proxies: {}, nextIndex: 1 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(created, "utf-8")), { proxies: {}, nextIndex: 1 });

  assert.equal(ensureJsonAtomic(created, { proxies: {} }), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(created, "utf-8")), { proxies: {}, nextIndex: 1 });
});

test("ensureJsonAtomic creates the parent directory along with the file", () => {
  const created = path.join(scratch, "nested", "more", "models.json");
  assert.equal(ensureJsonAtomic(created, { models: {} }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(created, "utf-8")), { models: {} });
});
