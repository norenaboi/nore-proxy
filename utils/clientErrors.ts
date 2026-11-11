/**
 * Client-facing error formatting shared by the API routes, the auth
 * middleware, and the global Express handlers.
 *
 * The gateway speaks two client protocols: OpenAI-style
 * `{ error: { message, code } }` and Anthropic-style
 * `{ type: "error", error: { type, message, code } }`. Every response the
 * client sees must use the shape its protocol expects — including errors that
 * originate far from the route (auth, body parsing, unknown paths), which is
 * why the protocol is resolved from the request path rather than passed down
 * through every middleware signature.
 */

export type ClientProtocol = "openai" | "anthropic";

export function protocolForPath(path: string | undefined | null): ClientProtocol {
  return typeof path === "string" && (path === "/v1/messages" || path.startsWith("/v1/messages/"))
    ? "anthropic"
    : "openai";
}

export function anthropicErrorType(statusCode: number | null | undefined): string {
  if (statusCode === 400) return "invalid_request_error";
  if (statusCode === 401) return "authentication_error";
  if (statusCode === 403) return "permission_error";
  if (statusCode === 404) return "not_found_error";
  if (statusCode === 413) return "request_too_large";
  if (statusCode === 429) return "rate_limit_error";
  if (statusCode === 529) return "overloaded_error";
  return "api_error";
}

export function anthropicErrorEnvelope(error: any, statusCode: any) {
  if (error?.responseBody?.type === "error" && error.responseBody.error?.type) {
    return {
      ...error.responseBody,
      error: {
        ...error.responseBody.error,
        ...(error.code ? { code: error.code } : {}),
      },
    };
  }
  return {
    type: "error",
    error: {
      type: anthropicErrorType(statusCode),
      message: error?.message || "Internal server error",
      ...(error?.code ? { code: error.code } : {}),
    },
  };
}

export function openAIErrorBody(error: any) {
  return {
    error: {
      message: error?.message || "Internal server error",
      ...(error?.code ? { code: error.code } : {}),
    },
  };
}

export function clientErrorBody(error: any, statusCode: any, protocol: ClientProtocol) {
  return protocol === "anthropic"
    ? anthropicErrorEnvelope(error, statusCode)
    : openAIErrorBody(error);
}

/**
 * Streaming requests pre-set their SSE response headers before routing starts;
 * if routing fails before the first byte, a plain `res.json()` would emit a
 * JSON error body still labelled `Content-Type: text/event-stream`, which no
 * SSE or JSON client can parse. Reset the framing headers so the JSON error
 * the route sends is actually readable as JSON.
 */
export function resetStreamHeaders(res: any) {
  res.setHeader("Content-Type", "application/json");
  res.removeHeader("Cache-Control");
  res.removeHeader("Connection");
  res.removeHeader("X-Accel-Buffering");
}

/** Sets `Retry-After` when the error carries a computed retry delay. */
export function applyRetryAfter(res: any, error: any) {
  const seconds = Number(error?.retryAfterSeconds);
  if (Number.isInteger(seconds) && seconds > 0) res.set("Retry-After", String(seconds));
}
