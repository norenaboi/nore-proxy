import crypto from "node:crypto";
import { DatabaseFacade } from "./database.js";

const SESSION_TTL = parseInt(process.env.SESSION_TTL_HOURS || "24", 10) * 60 * 60 * 1000;
let db: DatabaseFacade | undefined;
let initialized: Promise<void> | null = null;

/**
 * Sessions are stored by digest, never by the value held in the cookie, so
 * read access to the database does not yield replayable sessions. A plain
 * SHA-256 is sufficient here: the token is 32 bytes of CSPRNG output, so there
 * is no low-entropy guess space that would call for a slow KDF.
 *
 * Exported so the transform can be verified without a database.
 */
export function hashSessionId(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}

function getDb(): DatabaseFacade {
  if (!db) throw new Error("Session manager has not been initialized");
  return db;
}

export async function initializeSessionManager(): Promise<void> {
  if (initialized) return initialized;

  const database = new DatabaseFacade("sessions.db");
  db = database;
  initialized = (async () => {
    try {
      await database.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        expires_at BIGINT NOT NULL
      )`);
      await database.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");
      await database.run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]);
    } catch (error) {
      if (db === database) db = undefined;
      initialized = null;
      await database.close();
      throw error;
    }
  })();
  return initialized;
}

async function ready(): Promise<void> {
  if (!initialized) throw new Error("Session manager has not been initialized");
  await initialized;
}

export async function cleanupExpiredSessions(): Promise<void> {
  await ready();
  await getDb().run("DELETE FROM sessions WHERE expires_at <= ?", [Date.now()]);
}

export async function createSession(): Promise<string> {
  await ready();
  const sessionId = crypto.randomBytes(32).toString("hex");
  await getDb().run("INSERT INTO sessions (id, expires_at) VALUES (?, ?)", [hashSessionId(sessionId), Date.now() + SESSION_TTL]);
  return sessionId;
}

export async function validateSession(sessionId: string | null | undefined): Promise<boolean> {
  if (!sessionId) return false;
  await ready();
  const storedId = hashSessionId(sessionId);
  const session = await getDb().get<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE id = ?", [storedId]);
  if (!session) return false;
  if (Date.now() > Number(session.expires_at)) {
    await getDb().run("DELETE FROM sessions WHERE id = ?", [storedId]);
    return false;
  }
  return true;
}

export async function deleteSession(sessionId: string | null | undefined): Promise<void> {
  if (sessionId) {
    await ready();
    await getDb().run("DELETE FROM sessions WHERE id = ?", [hashSessionId(sessionId)]);
  }
}

export async function closeSessionManager(): Promise<void> {
  const database = db;
  db = undefined;
  initialized = null;
  await database?.close();
}

export default { createSession, validateSession, deleteSession, initializeSessionManager, cleanupExpiredSessions, closeSessionManager };
