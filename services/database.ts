import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import Config from "../config/index.js";

const require = createRequire(import.meta.url);
const SqliteDatabase: any = require("better-sqlite3");

export type SqlParams = readonly unknown[];
export type DatabaseKind = "sqlite" | "postgres";

function postgresUrl(): string | null {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid DATABASE_URL: expected a PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Invalid DATABASE_URL: expected postgres:// or postgresql://");
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new Error("Invalid DATABASE_URL: host and database name are required");
  }
  return value;
}

function sqlitePath(file: string): string {
  const overrides: Record<string, string | undefined> = {
    "sessions.db": process.env.SESSION_DB_PATH || process.env.NORE_PROXY_SESSION_DB_PATH,
    "api_keys.db": process.env.API_KEY_DB_PATH || process.env.NORE_PROXY_API_KEY_DB_PATH,
    "key_states.db": process.env.KEY_STATE_DB_PATH || process.env.NORE_PROXY_KEY_STATE_DB_PATH,
    "logs.db": process.env.LOG_DB_PATH || process.env.NORE_PROXY_LOG_DB_PATH,
    "uptime.db": process.env.UPTIME_DB_PATH || process.env.NORE_PROXY_UPTIME_DB_PATH,
  };
  return overrides[file] || path.join(Config.LOG_DIR, file);
}

/** Async facade over the project's SQLite files or one PostgreSQL database. */
export class DatabaseFacade {
  readonly kind: DatabaseKind;
  readonly sqlite: any | null;
  readonly pool: Pool | null;
  private readonly client: PoolClient | null;
  private sqliteTransactionTail: Promise<void> = Promise.resolve();

  constructor(file: string, client: PoolClient | null = null) {
    this.client = client;
    const url = postgresUrl();
    this.kind = client || url ? "postgres" : "sqlite";
    this.sqlite = null;
    this.pool = null;
    if (client) return;
    if (url) this.pool = new Pool({ connectionString: url });
    else {
      const filename = sqlitePath(file);
      if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
      this.sqlite = new SqliteDatabase(filename);
      this.sqlite.pragma("journal_mode = WAL");
    }
  }

  private pgSql(sql: string): string {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }
  private query<T extends QueryResultRow = QueryResultRow>(sql: string, params: SqlParams = []) {
    const executor = this.client ?? this.pool;
    if (!executor) throw new Error("PostgreSQL connection is unavailable");
    return executor.query<T>(this.pgSql(sql), params as unknown[]);
  }

  async exec(sql: string): Promise<void> {
    if (this.sqlite) this.sqlite.exec(sql);
    else await this.query(sql);
  }
  async all<T extends QueryResultRow = QueryResultRow>(sql: string, params: SqlParams = []): Promise<T[]> {
    return this.sqlite ? this.sqlite.prepare(sql).all(...params) as T[] : (await this.query<T>(sql, params)).rows;
  }
  async get<T extends QueryResultRow = QueryResultRow>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }
  async run(sql: string, params: SqlParams = []): Promise<{ changes: number; lastInsertRowid?: number }> {
    if (this.sqlite) {
      const result = this.sqlite.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    }
    const result = await this.query(sql, params);
    return { changes: result.rowCount ?? 0 };
  }
  async transaction<T>(work: (db: DatabaseFacade) => Promise<T>): Promise<T> {
    if (this.sqlite) {
      const previous = this.sqliteTransactionTail;
      let release!: () => void;
      this.sqliteTransactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        this.sqlite.exec("BEGIN IMMEDIATE");
        try {
          const result = await work(this);
          this.sqlite.exec("COMMIT");
          return result;
        } catch (error) {
          this.sqlite.exec("ROLLBACK");
          throw error;
        }
      } finally {
        release();
      }
    }
    if (this.client) return work(this);
    const client = await this.pool!.connect();
    const tx = new DatabaseFacade("", client);
    try { await client.query("BEGIN"); const result = await work(tx); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> {
    if (this.sqlite?.open) this.sqlite.close();
    if (this.pool) await this.pool.end();
  }
}
