/**
 * Uptime bucket persistence.
 *
 * Owns its own storage so nothing in this layer shares a connection, a
 * transaction, or a lock with request logging. On SQLite that is a separate
 * `uptime.db` file; when `DATABASE_URL` selects PostgreSQL it is one more table
 * in that database, consistent with every other service here.
 *
 * Buckets are keyed by model and `endpoint_name` rather than by any tenant or
 * group dimension, since routing here is per endpoint.
 */
import { DatabaseFacade } from "../database.js";
import type { BucketCounters, BucketRow } from "./types.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS uptime_buckets (
    model_name TEXT NOT NULL,
    endpoint_name TEXT NOT NULL DEFAULT '',
    bucket_ts BIGINT NOT NULL,
    request_count BIGINT NOT NULL DEFAULT 0,
    success_count BIGINT NOT NULL DEFAULT 0,
    total_latency_ms BIGINT NOT NULL DEFAULT 0,
    ttft_sum_ms BIGINT NOT NULL DEFAULT 0,
    ttft_count BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    generation_ms BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (model_name, endpoint_name, bucket_ts)
  );
  CREATE INDEX IF NOT EXISTS idx_uptime_buckets_ts ON uptime_buckets(bucket_ts);
  CREATE INDEX IF NOT EXISTS idx_uptime_buckets_model_ts ON uptime_buckets(model_name, bucket_ts);
`;

/** Counter columns, in the order the upsert binds them. */
const COUNTERS: Array<keyof BucketCounters> = [
  "requestCount",
  "successCount",
  "totalLatencyMs",
  "ttftSumMs",
  "ttftCount",
  "outputTokens",
  "generationMs",
];

const COLUMNS: Record<keyof BucketCounters, string> = {
  requestCount: "request_count",
  successCount: "success_count",
  totalLatencyMs: "total_latency_ms",
  ttftSumMs: "ttft_sum_ms",
  ttftCount: "ttft_count",
  outputTokens: "output_tokens",
  generationMs: "generation_ms",
};

const UPSERT = `INSERT INTO uptime_buckets (
    model_name, endpoint_name, bucket_ts, ${COUNTERS.map((key) => COLUMNS[key]).join(", ")}
  ) VALUES (?, ?, ?, ${COUNTERS.map(() => "?").join(", ")})
  ON CONFLICT (model_name, endpoint_name, bucket_ts) DO UPDATE SET
  ${COUNTERS.map((key) => `${COLUMNS[key]} = uptime_buckets.${COLUMNS[key]} + excluded.${COLUMNS[key]}`).join(", ")}`;

export class UptimeStore {
  private readonly dbFile: string;
  private database: DatabaseFacade | undefined;

  constructor(dbFile = "uptime.db") {
    this.dbFile = dbFile;
  }

  get ready(): boolean {
    return this.database !== undefined;
  }

  async initialize(): Promise<void> {
    if (this.database) return;
    const database = new DatabaseFacade(this.dbFile);
    try {
      await database.exec(SCHEMA);
      this.database = database;
    } catch (error) {
      await database.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Fold a batch of drained buckets into storage. Increments rather than
   * replaces, so a retried flush after a partial failure stays correct.
   */
  async persist(rows: BucketRow[]): Promise<void> {
    const database = this.database;
    if (!database || rows.length === 0) return;
    await database.transaction(async (tx) => {
      for (const row of rows) {
        await tx.run(UPSERT, [
          row.model,
          row.endpoint,
          row.bucketTs,
          ...COUNTERS.map((key) => row.counters[key]),
        ]);
      }
    });
  }

  /** Persisted buckets inside `[startTs, endTs]`, oldest first. */
  async read(startTs: number, endTs: number): Promise<BucketRow[]> {
    const database = this.database;
    if (!database) return [];
    const rows = await database.all<Record<string, unknown>>(
      `SELECT model_name, endpoint_name, bucket_ts, ${COUNTERS.map((key) => COLUMNS[key]).join(", ")}
       FROM uptime_buckets WHERE bucket_ts >= ? AND bucket_ts <= ?
       ORDER BY bucket_ts ASC`,
      [startTs, endTs],
    );
    return rows.map((row) => ({
      model: String(row.model_name ?? ""),
      endpoint: String(row.endpoint_name ?? ""),
      bucketTs: Number(row.bucket_ts) || 0,
      counters: {
        requestCount: Number(row.request_count) || 0,
        successCount: Number(row.success_count) || 0,
        totalLatencyMs: Number(row.total_latency_ms) || 0,
        ttftSumMs: Number(row.ttft_sum_ms) || 0,
        ttftCount: Number(row.ttft_count) || 0,
        outputTokens: Number(row.output_tokens) || 0,
        generationMs: Number(row.generation_ms) || 0,
      },
    }));
  }

  /** Drop buckets that start before `cutoffTs`. */
  async deleteBefore(cutoffTs: number): Promise<number> {
    const database = this.database;
    if (!database || cutoffTs <= 0) return 0;
    const result = await database.run("DELETE FROM uptime_buckets WHERE bucket_ts < ?", [cutoffTs]);
    return result.changes;
  }

  async close(): Promise<void> {
    const database = this.database;
    this.database = undefined;
    if (database) await database.close();
  }
}
