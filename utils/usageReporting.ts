import logManager from "../services/logManager.js";
import { calculateCost } from "./logging.js";

/**
 * Shared usage-reporting shapes. The admin dashboard and the signed-in account
 * page report the same numbers over the same windows, so both read them from
 * here rather than each summing rows their own way.
 */

/** Window length in seconds; null is all time. */
export const USAGE_RANGES: Record<string, number | null> = {
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  total: null,
};

// Groups are logManager.getBulkApiKeyAggregates rows: one per key, model,
// accounting version, and recorded-cost mask, so getCostForGroups resolves
// recorded-versus-calculated cost per group exactly as it would per request.
export function aggregateUsageGroups(groups: any[]) {
  const sum = (field: string) =>
    groups.reduce((total: number, group: any) => total + (Number(group[field]) || 0), 0);
  const costs = logManager.getCostForGroups(groups);
  const requests = sum("total");
  const successes = sum("successful");
  return {
    requests,
    successes,
    failures: sum("failed"),
    success_rate: requests ? (successes / requests) * 100 : 0,
    input_tokens: sum("inputTokens"),
    output_tokens: sum("outputTokens"),
    cache_write_tokens: sum("cacheWriteTokens"),
    cache_read_tokens: sum("cacheReadTokens"),
    input_cost: costs.input,
    output_cost: costs.output,
    cache_write_cost: costs.cacheWrite,
    cache_read_cost: costs.cacheRead,
    estimated_cost: costs.total,
  };
}

/**
 * Projects a request-history row for an API response. The accounting version
 * and the raw recorded-cost fields are internal accounting state, so they are
 * dropped in favour of one resolved cost plus its provenance.
 */
export function withEstimatedCost(request: any) {
  const costs = calculateCost(
    request.model,
    request.inputTokens,
    request.outputTokens,
    request.cacheWriteTokens,
    request.cacheReadTokens,
    request.tokenAccountingVersion,
  );
  const { tokenAccountingVersion, recordedCost, recordedCosts, ...safeRequest } = request;
  return {
    ...safeRequest,
    estimatedCost: recordedCost ?? costs.totalCost,
    costSource: recordedCost === null ? "current-pricing-estimate" : "recorded",
  };
}

/** Query-string integer parser: null marks a rejected value, distinct from an absent one. */
export function parseRequestInteger(value: any, fallback: any, minimum: any, maximum: any) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return null;
  }
  return parsed;
}
