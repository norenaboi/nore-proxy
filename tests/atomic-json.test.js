import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../utils/atomicJson.js";

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-atomic-json-test-"));
test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

test("atomic JSON writes replace the document and rotate backups", () => {
  const filePath = path.join(scratchDir, "settings.json");
  writeJsonAtomic(filePath, { version: 1 });
  writeJsonAtomic(filePath, { version: 2 });
  writeJsonAtomic(filePath, { version: 3 });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { version: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak.1`, "utf8")), { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak.2`, "utf8")), { version: 1 });
  assert.equal(fs.readdirSync(scratchDir).some((name) => name.endsWith(".tmp")), false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
