/**
 * Model uptime contracts.
 *
 * Per-model availability is the success ratio of real relay traffic inside fixed
 * time buckets rather than the verdict of a synthetic prober, so a model counts
 * as healthy exactly when the requests users actually sent it succeeded.
 *
 * The uptime layer is self-contained: it owns its storage, its aggregation, and
 * its routes, and it is designed so no failure inside it can reach the request
 * path or the rest of the server.
 */

/** One aggregation bucket. `ts` is the bucket start in unix seconds. */
export interface ModelUptimeBucket {
  ts: number;
  request_count: number;
  success_count: number;
  /** Percentage in 0..100, rounded to two decimals. */
  success_rate: number;
  avg_latency_ms: number;
}

export interface ModelUptimeSummary {
  model_name: string;
  request_count: number;
  success_count: number;
  failure_count: number;
  /** Percentage in 0..100, rounded to two decimals. */
  success_rate: number;
  avg_latency_ms: number;
  /** Mean time to first token, or 0 when no sample carried one. */
  avg_ttft_ms: number;
  /** Output tokens per second of generation time; 0 when unmeasurable. */
  avg_tps: number;
  /** Trailing bucket success rates, oldest first, for sparkline rendering. */
  recent_success_rates: number[];
  series: ModelUptimeBucket[];
}

export interface ModelUptimeResponse {
  window_hours: number;
  bucket_seconds: number;
  generated_at: number;
  /** False when the layer is unavailable; `models` is then empty rather than an error. */
  available: boolean;
  models: ModelUptimeSummary[];
}

/** Public status-page bucket. Traffic volume is intentionally not exposed. */
export interface PublicUptimeBucket {
  ts: number;
  success_rate: number;
  avg_latency_ms: number;
  status: UptimeStatus;
}

/** Public status-page model summary. Internal counts and throughput stay private. */
export interface PublicUptimeSummary {
  model_name: string;
  success_rate: number;
  avg_latency_ms: number;
  /**
   * Mean time to first token, or 0 when no sample carried one. This is the
   * figure the status page headlines: `avg_latency_ms` covers the whole request,
   * so for a stream it grows with the length of the answer rather than measuring
   * how fast the model started replying.
   */
  avg_ttft_ms: number;
  status: UptimeStatus;
  series: PublicUptimeBucket[];
}

export interface PublicUptimeResponse {
  window_hours: number;
  bucket_seconds: number;
  generated_at: number;
  available: boolean;
  models: PublicUptimeSummary[];
}

export const UPTIME_WINDOW_HOURS_DEFAULT = 24;
/** Upstream caps queries at 30 days; the same ceiling applies here. */
export const UPTIME_WINDOW_HOURS_MAX = 24 * 30;
export const UPTIME_BUCKET_SECONDS_DEFAULT = 3600;
/** Selectable granularities: a minute, 5 and 15 minutes, an hour, and a day. */
export const UPTIME_BUCKET_SECONDS_ALLOWED = [60, 300, 900, 3600, 86400] as const;
/** Trailing buckets returned as `recent_success_rates`. */
export const UPTIME_RECENT_BUCKETS = 12;

/** Availability bands used for status labelling. */
export const UPTIME_STATUS_THRESHOLDS = {
  operational: 90,
  minor: 80,
  degraded: 70,
} as const;

export type UptimeStatus = "operational" | "minor" | "degraded" | "major" | "unknown";

export function uptimeStatus(successRate: number, requestCount: number): UptimeStatus {
  if (!Number.isFinite(successRate) || requestCount <= 0) return "unknown";
  if (successRate >= UPTIME_STATUS_THRESHOLDS.operational) return "operational";
  if (successRate >= UPTIME_STATUS_THRESHOLDS.minor) return "minor";
  if (successRate >= UPTIME_STATUS_THRESHOLDS.degraded) return "degraded";
  return "major";
}
