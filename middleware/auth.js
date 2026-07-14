import apiKeyManager from "../services/apiKeyManager.js";
import { validateSession } from "../services/sessionManager.js";

export function verifyApiKey(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: {
        message:
          "Invalid authorization header format. Expected 'Bearer <token>'",
      },
    });
  }

  const apiKey = authorization.replace("Bearer ", "");

  try {
    apiKeyManager.validateKey(apiKey);
    req.apiKey = apiKey;
    next();
  } catch (error) {
    return res.status(error.statusCode || 401).json({
      error: { message: error.message || "Invalid or missing API key" },
    });
  }
}

export function verifySession(req, res, next) {
  const sessionId = req.cookies?.adminSession;
  if (!validateSession(sessionId)) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }
  next();
}

export function verifySessionOrRedirect(req, res, next) {
  const sessionId = req.cookies?.adminSession;
  if (!validateSession(sessionId)) {
    return res.redirect("/admin/login");
  }
  next();
}
