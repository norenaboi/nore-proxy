import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MASTER_KEY ??= "test-only-master-key-value";
delete process.env.DATABASE_URL;
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-api-key-test-"));
test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

const { DatabaseFacade } = await import("../services/database.js");
const { APIKeyManager } = await import("../services/apiKeyManager.js");

const sqliteAvailable = await (async () => {
  try {
    const probePath = path.join(scratchDir, "probe.db");
    process.env.API_KEY_DB_PATH = probePath;
    const probe = new DatabaseFacade("api_keys.db");
    await probe.close();
    return true;
  } catch (error) {
    console.warn(`Skipping API key persistence tests: SQLite unavailable (${String(error).split("\n")[0]})`);
    return false;
  }
})();

async function withManager(name, work) {
  process.env.API_KEY_DB_PATH = path.join(scratchDir, name);
  const manager = new APIKeyManager();
  await manager.initialize();
  try { return await work(manager, process.env.API_KEY_DB_PATH); }
  finally { await manager.close(); }
}

test("new API keys authenticate by hash and are never stored raw", { skip: !sqliteAvailable }, async () => {
  await withManager("new.db", async (manager) => {
    const rawKey = "sk-" + "A".repeat(48);
    await manager.addKey(rawKey, "New key");
    assert.equal(await manager.validateKey(rawKey), true);
    await assert.rejects(() => manager.validateKey(`${rawKey}x`), /Invalid API Key/);

    const db = new DatabaseFacade("api_keys.db");
    const row = await db.get("SELECT key_hash, api_key_masked, api_key_id FROM api_keys");
    await db.close();
    assert.equal(row.key_hash, crypto.createHash("sha256").update(rawKey).digest("hex"));
    assert.equal(row.api_key_masked, `${rawKey.slice(0, 5)}...${rawKey.slice(-3)}`);
    assert.notEqual(row.api_key_id, rawKey);
  });
});

test("startup migrates plaintext API keys without breaking authentication", { skip: !sqliteAvailable }, async () => {
  const dbPath = path.join(scratchDir, "legacy.db");
  process.env.API_KEY_DB_PATH = dbPath;
  const legacy = new DatabaseFacade("api_keys.db");
  await legacy.exec(`CREATE TABLE api_keys (
    api_key TEXT PRIMARY KEY, name TEXT, active INTEGER, usage_today INTEGER,
    rpd INTEGER, rpm INTEGER, max_context_size INTEGER, last_reset_date TEXT
  )`);
  const rawKey = "sk-" + "B".repeat(48);
  await legacy.run("INSERT INTO api_keys VALUES (?, ?, 1, 2, 500, 10, 0, ?)", [rawKey, "Legacy", "2026-08-25"]);
  await legacy.close();

  await withManager("legacy.db", async (manager) => {
    assert.equal(await manager.validateKey(rawKey), true);
    const keys = await manager.getKeys();
    assert.equal(keys[0].name, "Legacy");
    assert.equal(keys[0].usage_today, 2);
    const db = new DatabaseFacade("api_keys.db");
    const columns = (await db.all("PRAGMA table_info(api_keys)")).map((column) => column.name);
    await db.close();
    assert.ok(columns.includes("key_hash"));
    assert.ok(!columns.includes("api_key"));
  });
});
