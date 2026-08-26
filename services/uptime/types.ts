/** Internal types for the uptime layer. Public DTOs live in `shared/contracts/uptime.ts`. */

/** One recorded request outcome. All durations are milliseconds. */
export interface UptimeSample {
  model: string;
  endpoint?: string | null;
  success: boolean;
  latencyMs: number;
  /** Time to first token. Omit when the request path did not measure one. */
  ttftMs?: number | null;
  outputTokens?: number | null;
  /** Time spent generating after the first token; defaults to `latencyMs`. */
  generationMs?: number | null;
  /** Injectable clock for tests. Unix seconds. */
  nowSeconds?: number;
}

export interface BucketCounters {
  requestCount: number;
  successCount: number;
  totalLatencyMs: number;
  ttftSumMs: number;
  ttftCount: number;
  outputTokens: number;
  generationMs: number;
}

export interface BucketRow {
  model: string;
  endpoint: string;
  bucketTs: number;
  counters: BucketCounters;
}

export function emptyCounters(): BucketCounters {
  return {
    requestCount: 0,
    successCount: 0,
    totalLatencyMs: 0,
    ttftSumMs: 0,
    ttftCount: 0,
    outputTokens: 0,
    generationMs: 0,
  };
}

export function addCounters(target: BucketCounters, source: BucketCounters): void {
  target.requestCount += source.requestCount;
  target.successCount += source.successCount;
  target.totalLatencyMs += source.totalLatencyMs;
  target.ttftSumMs += source.ttftSumMs;
  target.ttftCount += source.ttftCount;
  target.outputTokens += source.outputTokens;
  target.generationMs += source.generationMs;
}

/** Bucket start for `ts`, floored as `ts - (ts % bucketSeconds)`. */
export function bucketStart(ts: number, bucketSeconds: number): number {
  const size = bucketSeconds > 0 ? bucketSeconds : 3600;
  const seconds = Math.floor(ts);
  return seconds - (seconds % size);
}
