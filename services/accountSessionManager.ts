import crypto from "node:crypto";

const SESSION_TTL = parseInt(process.env.SESSION_TTL_HOURS || "24", 10) * 60 * 60 * 1000;

interface AccountSession {
  keyHash: string;
  expiresAt: number;
}

/**
 * Sessions for API-key holders live only in this process. The store is a map
 * rather than a database because nothing derived from a live client key is
 * written to disk: restarting the server signs everyone out, which is the
 * intended trade.
 *
 * Two hashes are involved and neither is reversible:
 *   - the map key is the SHA-256 of the session id, so a heap dump yields no
 *     replayable cookie value, matching sessionManager's storage rule;
 *   - the stored value is the API key's `key_hash`, already the SHA-256 that
 *     `api_keys` is keyed by, so no new material is derived from the secret.
 */
const sessions = new Map<string, AccountSession>();

/** Exported so the transform can be verified without starting the server. */
export function hashAccountSessionId(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}

export function createAccountSession(keyHash: string): string {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(hashAccountSessionId(sessionId), {
    keyHash,
    expiresAt: Date.now() + SESSION_TTL,
  });
  return sessionId;
}

/** Returns the signed-in key's stored hash, or null when the cookie is unusable. */
export function validateAccountSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const storedId = hashAccountSessionId(sessionId);
  const session = sessions.get(storedId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(storedId);
    return null;
  }
  return session.keyHash;
}

export function deleteAccountSession(sessionId: string | null | undefined): void {
  if (sessionId) sessions.delete(hashAccountSessionId(sessionId));
}

export function cleanupExpiredAccountSessions(): void {
  const now = Date.now();
  for (const [storedId, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(storedId);
  }
}

/** Test seam: the store is process-global, so suites must be able to reset it. */
export function clearAccountSessions(): void {
  sessions.clear();
}

export default {
  createAccountSession,
  validateAccountSession,
  deleteAccountSession,
  cleanupExpiredAccountSessions,
};
