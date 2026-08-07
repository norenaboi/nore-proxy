import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MASTER_KEY ??= "test-only-master-key-value";
// Isolated on-disk persistence in a temp directory. A file rather than
// ":memory:" because the assertions open a second handle to inspect stored
// rows, and separate in-memory databases would not share state. Never point
// these at deployed databases.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "nore-session-test-"));
process.env.SESSION_DB_PATH = path.join(scratchDir, "sessions.db");
delete process.env.DATABASE_URL;

test.after(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

const {
  closeSessionManager,
  createSession,
  deleteSession,
  hashSessionId,
  initializeSessionManager,
  validateSession,
} = await import("../services/sessionManager.js");
const { DatabaseFacade } = await import("../services/database.js");

test("session tokens are only ever stored as an irreversible digest", () => {
  const token = "a".repeat(64);
  const digest = hashSessionId(token);

  assert.equal(digest, crypto.createHash("sha256").update(token).digest("hex"));
  assert.notEqual(digest, token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  // Distinct cookies must not collapse to the same stored row.
  assert.notEqual(digest, hashSessionId("b".repeat(64)));
  assert.equal(digest, hashSessionId(token));
});

// These tests need real persistence. The better-sqlite3 native binding does not
// build on every Node release, so skip rather than report a storage failure as
// a session-handling failure.
const sqliteAvailable = await (async () => {
  try {
    const probe = new DatabaseFacade("sessions.db");
    await probe.close();
    return true;
  } catch (error) {
    console.warn(
      `Skipping session persistence tests: SQLite unavailable (${String(error).split("\n")[0]})`,
    );
    return false;
  }
})();

test("sessions validate by token but are stored only as digests", { skip: !sqliteAvailable }, async (t) => {
  await initializeSessionManager();
  t.after(() => closeSessionManager());

  const token = await createSession();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(await validateSession(token), true);

  // The database must not contain anything replayable: a stolen dump should
  // not yield a usable cookie value.
  const stored = await new DatabaseFacade("sessions.db").all("SELECT id FROM sessions");
  const ids = stored.map((row) => row.id);
  assert.equal(ids.length >= 1, true);
  assert.ok(!ids.includes(token), "raw session token must not be stored");
  assert.ok(ids.includes(crypto.createHash("sha256").update(token).digest("hex")));

  // A caller holding the stored digest cannot authenticate with it.
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  assert.equal(await validateSession(digest), false);
});

test("unknown, empty, and deleted sessions are rejected", { skip: !sqliteAvailable }, async (t) => {
  await initializeSessionManager();
  t.after(() => closeSessionManager());

  assert.equal(await validateSession(undefined), false);
  assert.equal(await validateSession(null), false);
  assert.equal(await validateSession(""), false);
  assert.equal(await validateSession("f".repeat(64)), false);

  const token = await createSession();
  assert.equal(await validateSession(token), true);
  await deleteSession(token);
  assert.equal(await validateSession(token), false);

  // Deleting an unknown token is a no-op rather than an error.
  await deleteSession("a".repeat(64));
});

test("expired sessions are rejected and removed", { skip: !sqliteAvailable }, async (t) => {
  await initializeSessionManager();
  t.after(() => closeSessionManager());

  const token = await createSession();
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const db = new DatabaseFacade("sessions.db");
  await db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", [Date.now() - 1000, digest]);

  assert.equal(await validateSession(token), false);
  const remaining = await db.get("SELECT id FROM sessions WHERE id = ?", [digest]);
  assert.equal(remaining, undefined);
});
