import express, { type Request, type Response } from "express";
import { verifyApiKey } from "../middleware/auth.js";
import { usageRateLimit } from "../middleware/rateLimiter.js";
import apiKeyManager from "../services/apiKeyManager.js";
import logManager from "../services/logManager.js";

const router = express.Router();

let startupTime = Date.now() / 1000;

export function setStartupTime(time: number): void {
  startupTime = time;
}

router.get("/api/summary", async (_req: Request, res: Response) => {
  const dayAgo = Date.now() / 1000 - 86400;
  const allTime = logManager.getRequestAggregates();
  const daily = logManager.getRequestAggregates({ from: dayAgo });
  const allApiKeys = Object.keys(apiKeyManager.keys);

  res.json({
    total_requests: allTime.total,
    daily_requests: daily.total,
    all_time_requests: allTime.total,
    all_time_successful: allTime.successful,
    successful: daily.successful,
    failed: daily.failed,
    total_input_tokens: allTime.inputTokens,
    total_output_tokens: allTime.outputTokens,
    total_cache_write_tokens: allTime.cacheWriteTokens,
    total_cache_read_tokens: allTime.cacheReadTokens,
    daily_input_tokens: daily.inputTokens,
    daily_output_tokens: daily.outputTokens,
    daily_cache_write_tokens: daily.cacheWriteTokens,
    daily_cache_read_tokens: daily.cacheReadTokens,
    avg_duration: daily.avgDuration,
    success_rate: daily.total > 0 ? (daily.successful / daily.total) * 100 : 0,
    uptime: Date.now() / 1000 - startupTime,
    total_api_keys: allApiKeys.length,
  });
});

router.post(
  "/api/usage",
  usageRateLimit,
  verifyApiKey,
  async (req: Request, res: Response) => {
  const apiKey = req.apiKey;

  if (!apiKey) {
    return res.status(400).json({ error: "API key required" });
  }

  const stats = apiKeyManager.getUsageStats(apiKey);

  res.json({ usage: stats });
  },
);

export default router;
