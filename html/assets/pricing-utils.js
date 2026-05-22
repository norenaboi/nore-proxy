// Shared pricing utilities for frontend
// This module provides pricing data and cost calculation functions

let MODEL_PRICING_CACHE = null;

/**
 * Fetch and cache model pricing from the API
 */
async function fetchModelPricing() {
  try {
    const response = await fetch("/api/models");
    const data = await response.json();

    MODEL_PRICING_CACHE = {};

    if (data.models && Array.isArray(data.models)) {
      data.models.forEach((model) => {
        if (model.pricing) {
          MODEL_PRICING_CACHE[model.name] = {
            input: model.pricing.input || 0,
            output: model.pricing.output || 0,
            cache_write: model.pricing.cache_write || 0,
            cache_read: model.pricing.cache_read || 0,
          };
        }
      });
    }

    return MODEL_PRICING_CACHE;
  } catch (error) {
    console.error("Failed to fetch model pricing:", error);
    return {};
  }
}

/**
 * Get pricing for a specific model
 */
function getModelPricing(modelName) {
  if (MODEL_PRICING_CACHE && MODEL_PRICING_CACHE[modelName]) {
    return MODEL_PRICING_CACHE[modelName];
  }

  // Default pricing
  return { input: 0, output: 0, cache_write: 0, cache_read: 0 };
}

/**
 * Calculate cost based on model and token usage
 * Returns an object with individual costs and total
 */
function calculateCost(
  model,
  inputTokens,
  outputTokens,
  cacheWriteTokens,
  cacheReadTokens,
) {
  const pricing = getModelPricing(model);

  const inputRate = pricing.input / 1_000_000;
  const outputRate = pricing.output / 1_000_000;
  const cacheWriteRate = pricing.cache_write / 1_000_000;
  const cacheReadRate = pricing.cache_read / 1_000_000;

  // Calculate normal input tokens (excluding cache write and cache read tokens)
  const normalInputTokens = inputTokens - cacheWriteTokens - cacheReadTokens;

  const inputCost = normalInputTokens * inputRate;
  const outputCost = outputTokens * outputRate;
  const cacheWriteCost = cacheWriteTokens * cacheWriteRate;
  const cacheReadCost = cacheReadTokens * cacheReadRate;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
  };
}

/**
 * Format cost as currency string
 */
function formatCost(cost) {
  return `$${cost.toFixed(4)}`;
}

// Export functions for use in other scripts
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    fetchModelPricing,
    getModelPricing,
    calculateCost,
    formatCost,
  };
}
