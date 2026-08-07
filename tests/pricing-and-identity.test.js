import assert from "node:assert/strict";
import test from "node:test";

import { getApiKeyId, getSafeKeyMetadata } from "../utils/keyIdentity.js";
import { maskKey } from "../utils/helpers.js";
import {
  TOKEN_ACCOUNTING_VERSION,
  calculateModelCost,
  normalizeBillingTokens,
  normalizeModelPricing,
} from "../utils/pricing.js";

test("billing normalization separates cached input tokens", () => {
  assert.deepEqual(normalizeBillingTokens({
    inputTokens: 100,
    outputTokens: 20,
    cacheWriteTokens: 10,
    cacheReadTokens: 30,
  }), {
    inputTokens: 60,
    outputTokens: 20,
    cacheWriteTokens: 10,
    cacheReadTokens: 30,
    tokenAccountingVersion: TOKEN_ACCOUNTING_VERSION,
  });
  assert.deepEqual(normalizeModelPricing({ input: -1, output: "2", cache_read: "bad" }), {
    input: 0, output: 2, cache_write: 0, cache_read: 0,
  });
});

test("cost calculation applies per-million token rates", () => {
  const cost = calculateModelCost(
    { input: 1, output: 2, cache_write: 3, cache_read: 0.5 },
    1_000_000,
    500_000,
    100_000,
    200_000,
    TOKEN_ACCOUNTING_VERSION,
  );
  assert.deepEqual(cost, {
    inputCost: 1,
    outputCost: 1,
    cacheWriteCost: 0.3,
    cacheReadCost: 0.1,
    totalCost: 2.4,
  });
});

test("API key identity is stable, secret-bound, and safely masked", () => {
  const previousMasterKey = process.env.MASTER_KEY;
  const previousAnalyticsSecret = process.env.NORE_PROXY_ANALYTICS_SECRET;
  try {
    process.env.MASTER_KEY = "test-only-master-key";
    delete process.env.NORE_PROXY_ANALYTICS_SECRET;
    const first = getApiKeyId("secret-api-key");
    assert.equal(first, getApiKeyId("secret-api-key"));
    assert.notEqual(first, getApiKeyId("different-key"));
    assert.deepEqual(getSafeKeyMetadata("secret-api-key"), {
      api_key: "secre...key",
      api_key_id: first,
    });

    // Short keys must collapse to "****" rather than being echoed whole; the
    // hand-rolled substring masks this replaced would return them intact.
    for (const shortKey of ["sk-1", "12345678"]) {
      assert.equal(maskKey(shortKey), "****");
      assert.equal(getSafeKeyMetadata(shortKey).api_key, "****");
    }
    assert.equal(maskKey("123456789"), "12345...789");

    // Masking is idempotent, so re-masking an already-masked stored log value
    // does not reveal more of it.
    assert.equal(maskKey(maskKey("secret-api-key")), "secre...key");
  } finally {
    if (previousMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = previousMasterKey;
    if (previousAnalyticsSecret === undefined) delete process.env.NORE_PROXY_ANALYTICS_SECRET;
    else process.env.NORE_PROXY_ANALYTICS_SECRET = previousAnalyticsSecret;
  }
});
