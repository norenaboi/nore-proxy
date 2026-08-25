/**
 * Uptime layer entry point.
 *
 * Import this module — not `service.ts` — from the rest of the server. Every
 * export here is failure-isolated: recording cannot throw, and reads degrade to
 * an empty payload rather than an error.
 */
import { UptimeService } from "./service.js";
import type { UptimeSample } from "./types.js";

const uptimeService = new UptimeService();

export default uptimeService;
export { UptimeService, foldSummaries } from "./service.js";
export { UptimeStore } from "./store.js";
export { bucketStart } from "./types.js";
export type { BucketCounters, BucketRow, UptimeSample } from "./types.js";

/**
 * Record one request outcome. Safe to call unguarded from the request path:
 * it is synchronous, in-memory, and swallows its own failures.
 */
export function recordUptimeSample(sample: UptimeSample): void {
  uptimeService.record(sample);
}
