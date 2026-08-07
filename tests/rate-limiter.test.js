import assert from "node:assert/strict";
import test from "node:test";

test("invalid ADMIN_MAX_ATTEMPTS does not silently disable the limiter", async () => {
  const previous = process.env.ADMIN_MAX_ATTEMPTS;
  const previousMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY ??= "test-only-master-key-value";
  try {
    // parseInt("abc") yielded NaN, and `attempts >= NaN` is always false, so a
    // typo used to turn brute-force protection off entirely.
    process.env.ADMIN_MAX_ATTEMPTS = "abc";
    const { adminRateLimit } = await import(
      `../middleware/rateLimiter.js?admin-max-attempts=${Date.now()}`
    );

    const run = () => {
      let status = 200;
      let nextCalled = false;
      const res = {
        status(code) { status = code; return this; },
        json() { return this; },
      };
      adminRateLimit(
        { headers: {}, socket: { remoteAddress: "203.0.113.77" } },
        res,
        () => { nextCalled = true; },
      );
      return { status, nextCalled };
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(run().nextCalled, true, `attempt ${attempt + 1} should pass`);
    }
    const blocked = run();
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.status, 429);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_MAX_ATTEMPTS;
    else process.env.ADMIN_MAX_ATTEMPTS = previous;
    if (previousMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = previousMasterKey;
  }
});
