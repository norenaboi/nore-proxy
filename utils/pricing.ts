const ZERO_MODEL_PRICING = Object.freeze({
  input: 0,
  output: 0,
  cache_write: 0,
  cache_read: 0,
});

export const TOKEN_ACCOUNTING_VERSION = 2;

function normalizeAmount(value: any) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

export function normalizeBillingTokens({
  inputTokens = 0, outputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0, inputIncludesCache = true, } = {}) {
  const input = normalizeAmount(inputTokens);
  const output = normalizeAmount(outputTokens);
  const cacheWrite = normalizeAmount(cacheWriteTokens);
  const cacheRead = normalizeAmount(cacheReadTokens);

  return {
    inputTokens: inputIncludesCache
      ? Math.max(0, input - cacheWrite - cacheRead)
      : input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    tokenAccountingVersion: TOKEN_ACCOUNTING_VERSION,
  };
}

export function normalizeModelPricing(pricing: any) {
  if (!pricing) return ZERO_MODEL_PRICING;

  return {
    input: normalizeAmount(pricing.input),
    output: normalizeAmount(pricing.output),
    cache_write: normalizeAmount(pricing.cache_write),
    cache_read: normalizeAmount(pricing.cache_read),
  };
}

export function addModelPricing(pricingByModel: any, displayName: any, modelConfig: any) {
  if (!modelConfig.pricing) return;

  const backendName = modelConfig.backend || displayName;
  const version = modelConfig.version || "";
  const actualBackend = version ? `${backendName}-${version}` : backendName;
  const pricing = normalizeModelPricing(modelConfig.pricing);

  pricingByModel[displayName] = pricing;
  pricingByModel[actualBackend] = pricing;
}

export function calculateModelCost(pricing: any, inputTokens: any, outputTokens: any, cacheWriteTokens: any, cacheReadTokens: any, tokenAccountingVersion = null, ) {
  const rates = normalizeModelPricing(pricing);
  const normalizedInputTokens = normalizeAmount(inputTokens);
  const normalizedOutputTokens = normalizeAmount(outputTokens);
  const normalizedCacheWriteTokens = normalizeAmount(cacheWriteTokens);
  const normalizedCacheReadTokens = normalizeAmount(cacheReadTokens);

  const cachedInputTokens =
    normalizedCacheWriteTokens + normalizedCacheReadTokens;
  const normalInputTokens =
    tokenAccountingVersion === TOKEN_ACCOUNTING_VERSION
      ? normalizedInputTokens
      : Math.max(0, normalizedInputTokens - cachedInputTokens);

  const inputCost = (normalInputTokens * rates.input) / 1_000_000;
  const outputCost = (normalizedOutputTokens * rates.output) / 1_000_000;
  const cacheWriteCost =
    (normalizedCacheWriteTokens * rates.cache_write) / 1_000_000;
  const cacheReadCost =
    (normalizedCacheReadTokens * rates.cache_read) / 1_000_000;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
  };
}
