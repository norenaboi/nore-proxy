import type { RequestHandler } from "express";
import { normalizeToolCatalog, ToolValidationError, type ToolProtocol } from "../utils/toolValidation.js";

export function validateToolCatalog(protocol: ToolProtocol): RequestHandler {
  return (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new ToolValidationError("Request body must be an object.", "invalid_request_body", "body");
      }
      if (req.body.tools != null) {
        const tools = normalizeToolCatalog(req.body.tools, protocol);
        req.body = { ...req.body, tools };
      }
    } catch (error) {
      if (!(error instanceof ToolValidationError)) return next(error);
      const detail = { type: "invalid_request_error", message: error.message, code: error.code };
      if (protocol === "anthropic") {
        res.status(400).json({ type: "error", error: detail });
      } else {
        res.status(400).json({ error: { ...detail, param: error.param } });
      }
      return;
    }
    next();
  };
}
