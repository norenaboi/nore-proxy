import type { NextFunction, Request, Response } from "express";
import apiKeyManager from "../services/apiKeyManager.js";
import { validateSession } from "../services/sessionManager.js";

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
      return res.redirect("/admin/login");
    }
    next();
  } catch (error) {
    next(error);
  }
}
