import crypto from 'crypto';
import { createRequire } from "module";
const Database: any = createRequire(import.meta.url)("better-sqlite3");
import fs from 'fs';
import path from 'path';
import Config from '../config/index.js';

const SESSION_TTL = parseInt(process.env.SESSION_TTL_HOURS || '24', 10) * 60 * 60 * 1000;

// Persistent session store — survives restarts and crashes.
// better-sqlite3 is synchronous, so the exported API stays sync-compatible
// with all existing callers (routes/admin.js, routes/pages.js, middleware/auth.js).
const dbPath = process.env.NORE_PROXY_SESSION_DB_PATH || path.join(Config.LOG_DIR, 'sessions.db');
if (dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

const stmtInsert = db.prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)');
const stmtGet = db.prepare('SELECT expires_at FROM sessions WHERE id = ?');
const stmtDelete = db.prepare('DELETE FROM sessions WHERE id = ?');
interface SessionRow {
  expires_at: number;
}

const stmtDeleteExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

// Purge sessions that expired while the server was down.
stmtDeleteExpired.run(Date.now());

export function createSession() {
  const sessionId = crypto.randomBytes(32).toString('hex');
  stmtInsert.run(sessionId, Date.now() + SESSION_TTL);
  return sessionId;
}

export function validateSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const session = stmtGet.get(sessionId) as SessionRow | undefined;
  if (!session) return false;
  if (Date.now() > session.expires_at) {
    stmtDelete.run(sessionId);
    return false;
  }
  return true;
}

export function deleteSession(sessionId: string | null | undefined): void {
  if (sessionId) stmtDelete.run(sessionId);
}

// Periodically remove expired sessions (every hour).
setInterval(() => {
  stmtDeleteExpired.run(Date.now());
}, 60 * 60 * 1000).unref();

export default { createSession, validateSession, deleteSession };
