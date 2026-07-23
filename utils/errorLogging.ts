const SENSITIVE_HEADER_PATTERN =
  /authorization|api[-_]?key|cookie|token|secret/i;

type LogHeaders = Record<string, unknown> | { toJSON(): Record<string, unknown> } | null | undefined;

export function sanitizeHeadersForLogging(headers: LogHeaders = {}) {
  const plainHeaders =
    typeof headers?.toJSON === "function" ? headers.toJSON() : headers;

  if (!plainHeaders || typeof plainHeaders !== "object") return {};

  return Object.fromEntries(
    Object.entries(plainHeaders).filter(
      ([name]) => !SENSITIVE_HEADER_PATTERN.test(name),
    ),
  );
}
