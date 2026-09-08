import "./isolated-config.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// The store is in-memory, so this suite needs no database and never joins the
// SQLite skip set that the admin session tests fall into.
const {
  clearAccountSessions,
  createAccountSession,
  deleteAccountSession,
  hashAccountSessionId,
  validateAccountSession,
} = await import("../services/accountSessionManager.js");

const KEY_HASH = crypto.createHash("sha256").update("sk-not-a-real-key").digest("hex");

test.beforeEach(() => clearAccountSessions());

test("session ids are only ever held as an irreversible digest", () => {
  const token = "a".repeat(64);
  const digest = hashAccountSessionId(token);

  assert.equal(digest, crypto.createHash("sha256").update(token).digest("hex"));
  assert.notEqual(digest, token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(digest, hashAccountSessionId("b".repeat(64)));
});

test("a session resolves to the key hash it was opened with", () => {
  const sessionId = createAccountSession(KEY_HASH);

  assert.match(sessionId, /^[0-9a-f]{64}$/);
  assert.equal(validateAccountSession(sessionId), KEY_HASH);
  // Holding the stored digest must not authenticate.
  assert.equal(validateAccountSession(hashAccountSessionId(sessionId)), null);
});

test("unknown, empty, and deleted sessions are rejected", () => {
  assert.equal(validateAccountSession(undefined), null);
  assert.equal(validateAccountSession(null), null);
  assert.equal(validateAccountSession(""), null);
  assert.equal(validateAccountSession("f".repeat(64)), null);

  const sessionId = createAccountSession(KEY_HASH);
  assert.equal(validateAccountSession(sessionId), KEY_HASH);
  deleteAccountSession(sessionId);
  assert.equal(validateAccountSession(sessionId), null);

  // Deleting an unknown id is a no-op rather than an error.
  deleteAccountSession("a".repeat(64));
});

test("expired sessions are rejected and dropped", async () => {
  const previous = process.env.SESSION_TTL_HOURS;
  process.env.SESSION_TTL_HOURS = "0";
  try {
    // The TTL is read at module load, so a zero-TTL store needs its own copy.
    const expiring = await import(
      `../services/accountSessionManager.js?ttl=${Date.now()}`
    );
    const sessionId = expiring.createAccountSession(KEY_HASH);
    // A zero-hour TTL expires at the creation instant, so the session only has
    // to outlive one clock tick to be past it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(expiring.validateAccountSession(sessionId), null);
    // A rejected session is removed rather than left to accumulate.
    expiring.cleanupExpiredAccountSessions();
    assert.equal(expiring.validateAccountSession(sessionId), null);
  } finally {
    if (previous === undefined) delete process.env.SESSION_TTL_HOURS;
    else process.env.SESSION_TTL_HOURS = previous;
  }
});

test("only the passed key hash is retained, never a raw key", () => {
  const rawKey = "sk-not-a-real-key";
  const sessionId = createAccountSession(KEY_HASH);
  const held = validateAccountSession(sessionId);

  assert.equal(held, KEY_HASH);
  assert.notEqual(held, rawKey);
  assert.match(held, /^[0-9a-f]{64}$/);
});
