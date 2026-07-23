import type { NextFunction, Request, Response } from "express";
import settingsManager from "../services/settingsManager.js";
import { getClientIp } from "../utils/helpers.js";

type AttemptMap = Map<string, number[]>;
type RateLimitError = Error & { statusCode: number };

// IP-level brute-force limiter for admin/auth routes
// Tracks attempt timestamps per IP and rejects if too many occur within the window
const ADMIN_WINDOW_SECONDS = 60;
const ADMIN_MAX_ATTEMPTS = parseInt(process.env.ADMIN_MAX_ATTEMPTS || "100", 10);
const adminAttempts: AttemptMap = new Map();

// IP-level brute-force limiter for /api/usage
// Prevents attackers from enumerating valid API keys via repeated lookups
const USAGE_WINDOW_SECONDS = 60;
const USAGE_MAX_ATTEMPTS = 10;
const usageAttempts: AttemptMap = new Map();

setInterval(() => {
  const cutoff = Date.now() / 1000 - USAGE_WINDOW_SECONDS * 2;
  for (const [ip, timestamps] of usageAttempts.entries()) {
    const fresh = timestamps.filter((t: any) => t > cutoff);
    if (fresh.length === 0) usageAttempts.delete(ip);
    else usageAttempts.set(ip, fresh);
  }
}, 60000);

setInterval(() => {
  const cutoff = Date.now() / 1000 - ADMIN_WINDOW_SECONDS * 2;
  for (const [ip, timestamps] of adminAttempts.entries()) {
    const fresh = timestamps.filter((t: any) => t > cutoff);
    if (fresh.length === 0) adminAttempts.delete(ip);
    else adminAttempts.set(ip, fresh);
  }
}, 60000);

export function usageRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  const ip = getClientIp(req);
  const now = Date.now() / 1000;
  const recent = (usageAttempts.get(ip) || []).filter(
    (t: any) => now - t < USAGE_WINDOW_SECONDS,
  );
  if (recent.length >= USAGE_MAX_ATTEMPTS) {
    return res
      .status(429)
      .json({ detail: "Too many requests. Please try again later." });
  }
  recent.push(now);
  usageAttempts.set(ip, recent);
  next();
}

export function adminRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  const ip = getClientIp(req);
  const now = Date.now() / 1000;
  const recent = (adminAttempts.get(ip) || []).filter(
    (t: any) => now - t < ADMIN_WINDOW_SECONDS,
  );
  if (recent.length >= ADMIN_MAX_ATTEMPTS) {
    return res
      .status(429)
      .json({ error: "Too many requests. Please slow down." });
  }
  recent.push(now);
  adminAttempts.set(ip, recent);
  next();
}

class RateLimiter {
  private apiKeyUsage: AttemptMap;

  constructor() {
    this.apiKeyUsage = new Map();
  }

  checkRateLimit(
    apiKey: string,
    rateLimit: number = settingsManager.get("rpmDefault") as number,
  ): void {
    const currentTime = Date.now() / 1000;

    // Get or initialize timestamps for this API key
    if (!this.apiKeyUsage.has(apiKey)) {
      this.apiKeyUsage.set(apiKey, []);
    }

    // Clean up old timestamps (older than 60 seconds)
    const timestamps = this.apiKeyUsage
      .get(apiKey)!
      .filter((t: any) => currentTime - t < 60);
    this.apiKeyUsage.set(apiKey, timestamps);

    if (timestamps.length >= rateLimit) {
      const oldestTimestamp = Math.min(...timestamps);
      let retryAfter = Math.floor(60 - (currentTime - oldestTimestamp));
      retryAfter = Math.max(1, retryAfter);

      const error = new Error(
        `You exceeded your requests per minute limit (${rateLimit}). Please wait and try after ${retryAfter} seconds.`,
      ) as RateLimitError;
      error.statusCode = 429;
      throw error;
    }

    timestamps.push(currentTime);
    this.apiKeyUsage.set(apiKey, timestamps);
  }

  // Periodically evict entries that haven't been used recently to prevent unbounded growth
  startCleanup() {
    setInterval(() => {
      const cutoff = Date.now() / 1000 - 120;
      for (const [key, timestamps] of this.apiKeyUsage.entries()) {
        if (timestamps.every((t: any) => t < cutoff)) {
          this.apiKeyUsage.delete(key);
        }
      }
    }, 60000);
  }
}

const rateLimiter = new RateLimiter();
export default rateLimiter;
