const SENSITIVE_HEADER_PATTERN =
  /authorization|api[-_]?key|cookie|token|secret/i;

export function sanitizeHeadersForLogging(headers = {}) {
  const plainHeaders =
    typeof headers?.toJSON === "function" ? headers.toJSON() : headers;

  if (!plainHeaders || typeof plainHeaders !== "object") return {};

  return Object.fromEntries(
    Object.entries(plainHeaders).filter(
      ([name]) => !SENSITIVE_HEADER_PATTERN.test(name),
    ),
  );
}
