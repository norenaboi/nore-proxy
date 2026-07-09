import express from "express";
import { verifyApiKey } from "../middleware/auth.js";
import { usageRateLimit } from "../middleware/rateLimiter.js";
import apiKeyManager from "../services/apiKeyManager.js";
import logManager from "../services/logManager.js";

const router = express.Router();

let startupTime = Date.now() / 1000;

export function setStartupTime(time) {
  startupTime = time;
}

router.get("/api/summary", async (req, res) => {
  const currentTime = Date.now() / 1000;
  const dayAgo = currentTime - 86400;

  const logs = logManager.readRequestLogs(10000);
  const recent24hLogs = logs.filter((log) => (log.timestamp || 0) > dayAgo);

  const totalRequests = logs.length;
  const dailyRequests = recent24hLogs.length;

  const successful = recent24hLogs.filter(
    (log) => log.status === "success",
  ).length;
  const failed = recent24hLogs.length - successful;

  const totalInputTokens = logs.reduce(
    (sum, log) => sum + (log.input_tokens || 0),
    0,
  );
  const totalOutputTokens = logs.reduce(
    (sum, log) => sum + (log.output_tokens || 0),
    0,
  );
  const totalCacheWriteTokens = logs.reduce(
    (sum, log) => sum + (log.cache_write_tokens || 0),
    0,
  );
  const totalCacheReadTokens = logs.reduce(
    (sum, log) => sum + (log.cache_read_tokens || 0),
    0,
  );

  const dailyInputTokens = recent24hLogs.reduce(
    (sum, log) => sum + (log.input_tokens || 0),
    0,
  );
  const dailyOutputTokens = recent24hLogs.reduce(
    (sum, log) => sum + (log.output_tokens || 0),
    0,
  );
  const dailyCacheWriteTokens = recent24hLogs.reduce(
    (sum, log) => sum + (log.cache_write_tokens || 0),
    0,
  );
  const dailyCacheReadTokens = recent24hLogs.reduce(
    (sum, log) => sum + (log.cache_read_tokens || 0),
    0,
  );

  const durations = recent24hLogs
    .map((log) => log.duration || 0)
    .filter((d) => d > 0);
  const avgDuration =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

  const allApiKeys = Object.keys(apiKeyManager.keys);

  res.json({
    total_requests: totalRequests,
    daily_requests: dailyRequests,
    successful,
    failed,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cache_write_tokens: totalCacheWriteTokens,
    total_cache_read_tokens: totalCacheReadTokens,
    daily_input_tokens: dailyInputTokens,
    daily_output_tokens: dailyOutputTokens,
    daily_cache_write_tokens: dailyCacheWriteTokens,
    daily_cache_read_tokens: dailyCacheReadTokens,
    avg_duration: avgDuration,
    success_rate: recent24hLogs.length > 0 ? (successful / recent24hLogs.length) * 100 : 0,
    uptime: Date.now() / 1000 - startupTime,
    total_api_keys: allApiKeys.length,
  });
});

router.post("/api/usage", usageRateLimit, verifyApiKey, async (req, res) => {
  const apiKey = req.apiKey;

  if (!apiKey) {
    return res.status(400).json({ error: "API key required" });
  }

  const stats = apiKeyManager.getUsageStats(apiKey);

  res.json({ usage: stats });
});

export default router;
