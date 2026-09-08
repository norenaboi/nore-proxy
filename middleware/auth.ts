import type { NextFunction, Request, Response } from "express";
import apiKeyManager from "../services/apiKeyManager.js";
import { validateSession } from "../services/sessionManager.js";
import { validateAccountSession } from "../services/accountSessionManager.js";

/**
 * Bearer-token auth for OpenAI-format endpoints (/v1/chat/completions).
 * Expects: Authorization: Bearer <token>
 */
export async function verifyApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: {
        message:
          "Invalid authorization header format. Expected 'Authorization: Bearer <token>'.",
      },
    });
  }

  const apiKey = authorization.replace("Bearer ", "");

  try {
    await apiKeyManager.validateKey(apiKey);
    req.apiKey = apiKey;
    next();
  } catch (error: unknown) {
    const authError = error as { statusCode?: number; message?: string };
    if (!authError.statusCode) return next(error);
    return res.status(authError.statusCode).json({
      error: { message: authError.message || "Invalid or missing API key" },
    });
  }
}

export async function verifySession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const sessionId = req.cookies?.adminSession;
  try {
    if (!(await validateSession(sessionId))) {
      return res.status(401).json({ error: "Unauthorized. Please log in." });
    }
    next();
  } catch (error) {
    next(error);
  }
}

export async function verifySessionOrRedirect(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  const sessionId = req.cookies?.adminSession;
  try {
    if (!(await validateSession(sessionId))) {
      return res.redirect("/login");
    }
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Resolves the signed-in API key from the account session cookie. The key row is
 * re-read on every request, so deleting a key immediately invalidates every
 * session holding it — the in-memory store needs no revocation channel.
 */
async function resolveAccountKeyHash(req: Request): Promise<string | null> {
  const keyHash = validateAccountSession(req.cookies?.accountSession);
  if (!keyHash) return null;
  return (await apiKeyManager.getStoredKey(keyHash)) ? keyHash : null;
}

export async function verifyAccountSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  try {
    const keyHash = await resolveAccountKeyHash(req);
    if (!keyHash) {
      return res.status(401).json({ error: "Unauthorized. Please sign in." });
    }
    req.accountKeyHash = keyHash;
    next();
  } catch (error) {
    next(error);
  }
}

export async function verifyAccountSessionOrRedirect(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void | Response> {
  try {
    const keyHash = await resolveAccountKeyHash(req);
    if (!keyHash) return res.redirect("/login");
    req.accountKeyHash = keyHash;
    next();
  } catch (error) {
    next(error);
  }
}
