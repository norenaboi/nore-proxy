import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import Config from "../config/index.js";
import { verifyAccountSession } from "../middleware/auth.js";
import { adminRateLimit } from "../middleware/rateLimiter.js";
import apiKeyManager from "../services/apiKeyManager.js";
import logManager from "../services/logManager.js";
import { createSession } from "../services/sessionManager.js";
import {
  createAccountSession,
  deleteAccountSession,
} from "../services/accountSessionManager.js";
import {
  USAGE_RANGES,
  aggregateUsageGroups,
  parseRequestInteger,
  withEstimatedCost,
} from "../utils/usageReporting.js";

const router = express.Router();

const SESSION_MAX_AGE = parseInt(process.env.SESSION_TTL_HOURS || "24", 10) * 60 * 60 * 1000;

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge: SESSION_MAX_AGE,
  };
}

function isMasterKey(provided: string): boolean {
  const expected = Config.MASTER_KEY;
  try {
    return (
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    );
  } catch (_) {
    return false;
  }
}

// POST /api/login — the single sign-in surface for both audiences. The master
// key opens the admin panel; any stored client key opens its own account page.
// IP-level rate limiting throttles brute force against both credential spaces,
// and the two failure paths share one response so it never reveals which space
// a guess landed near.
router.post("/api/login", adminRateLimit, async (req: Request, res: Response) => {
  const provided = (req.body?.key ?? "").toString();

  if (provided && isMasterKey(provided)) {
    const sessionId = await createSession();
    res.cookie("adminSession", sessionId, sessionCookieOptions());
    return res.json({ redirect: "/admin/dashboard" });
  }

  // The raw key is never retained: it is hashed here, and only the resulting
  // stored hash is held for the life of the session.
  const keyHash = provided ? await apiKeyManager.resolveKeyHash(provided) : null;
  if (keyHash) {
    res.cookie("accountSession", createAccountSession(keyHash), sessionCookieOptions());
    return res.json({ redirect: "/account" });
  }

  return res.status(403).json({ error: "Invalid key" });
});

router.post("/api/account/logout", (req: Request, res: Response) => {
  deleteAccountSession(req.cookies?.accountSession);
  res.clearCookie("accountSession", { httpOnly: true, sameSite: "strict" });
  res.json({ success: true });
});

// GET /api/account/summary — the signed-in key's own usage, aggregated exactly
// as the admin dashboard aggregates its API-keys row, over the same windows.
router.get("/api/account/summary", verifyAccountSession, async (req: Request, res: Response) => {
  try {
    const keyHash = req.accountKeyHash as string;
    const storedKey = await apiKeyManager.getStoredKey(keyHash);
    const identity = await apiKeyManager.getLogIdentity(keyHash);
    if (!storedKey || !identity) {
      return res.status(404).json({ error: "API key not found" });
    }

    const now = Date.now() / 1000;
    const ranges = Object.fromEntries(
      await Promise.all(
        Object.entries(USAGE_RANGES).map(async ([range, seconds]) => {
          const groups = await logManager.getBulkApiKeyAggregates(
            seconds === null ? identity : { ...identity, from: now - seconds },
          );
          return [range, aggregateUsageGroups(groups)] as const;
        }),
      ),
    );

    return res.json({
      key: {
        name: storedKey.name || "Unnamed",
        api_key: storedKey.mask,
        active: storedKey.active,
        usage_today: storedKey.usage_today,
        rpd: storedKey.rpd,
        rpm: storedKey.rpm,
        max_context_size: storedKey.max_context_size,
      },
      ranges,
    });
  } catch (error: unknown) {
    console.error("Error loading account summary:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/account/requests — the key's own request history, paged. The identity
// comes from the session and is never accepted from the query, so a caller can
// only ever read its own rows. Endpoint identity is deliberately absent from the
// projection: it is upstream infrastructure detail the admin surface may show
// and a public one may not.
router.get("/api/account/requests", verifyAccountSession, async (req: Request, res: Response) => {
  const limit = parseRequestInteger(req.query.limit, 50, 1, 50);
  const offset = parseRequestInteger(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (limit === null || offset === null) {
    return res.status(400).json({ error: "Invalid pagination values" });
  }

  if (req.query.status !== undefined && typeof req.query.status !== "string") {
    return res.status(400).json({ error: "Invalid filter value" });
  }
  const status = (req.query.status as string | undefined)?.trim() || null;
  if (status && status !== "success" && status !== "failed") {
    return res.status(400).json({ error: "Invalid request status" });
  }

  let from: number | null = null;
  if (req.query.from !== undefined && req.query.from !== "") {
    if (typeof req.query.from !== "string") {
      return res.status(400).json({ error: "Invalid time range" });
    }
    const parsed = Number(req.query.from);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return res.status(400).json({ error: "Invalid time range" });
    }
    from = parsed;
  }

  try {
    const identity = await apiKeyManager.getLogIdentity(req.accountKeyHash as string);
    if (!identity) {
      return res.status(404).json({ error: "API key not found" });
    }

    const result = await logManager.getRequestHistory({ ...identity, limit, offset, status, from });
    const requests = result.requests.map((request: any) => {
      const {
        id, timestamp, model, status: requestStatus,
        inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens,
        duration, estimatedCost, costSource,
      } = withEstimatedCost(request);
      return {
        id, timestamp, model, status: requestStatus,
        inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens,
        duration, estimatedCost, costSource,
      };
    });

    return res.json({ requests, total: result.total, limit, offset });
  } catch (error: unknown) {
    console.error("Error loading account request history:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
