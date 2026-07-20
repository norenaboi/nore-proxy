import { maskKey } from "./helpers.js";

const SENSITIVE_QUERY_PATTERN =
  /^(?:key|.*(?:authorization|api[-_]?key|cookie|token|secret).*)$/i;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;

function parseBodyText(text) {
  if (!text) return "";

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function sanitizeUpstreamUrl(rawUrl) {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PATTERN.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(rawUrl).replace(
      /([?&])([^=&]*(?:authorization|api[-_]?key|cookie|token|secret)[^=&]*)=[^&]*/gi,
      (_match, separator) => (separator === "?" ? "?" : ""),
    );
  }
}

export async function readUpstreamErrorBody(
  body,
  maxBytes = MAX_ERROR_BODY_BYTES,
) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return parseBodyText(body);
  if (Buffer.isBuffer(body)) return parseBodyText(body.toString("utf8"));

  if (typeof body?.[Symbol.asyncIterator] !== "function") return body;

  const chunks = [];
  let bytesRead = 0;
  let truncated = false;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = maxBytes - bytesRead;

    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining));
      bytesRead += remaining;
      truncated = true;
      break;
    }

    chunks.push(buffer);
    bytesRead += buffer.length;
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!truncated) return parseBodyText(text);

  return {
    truncated: true,
    capturedBytes: bytesRead,
    body: parseBodyText(text),
  };
}

export function getUpstreamErrorMessage(body, fallback = "Unknown error") {
  if (typeof body === "string" && body.trim()) return body;

  return (
    body?.error?.message ||
    body?.error?.detail ||
    body?.message ||
    body?.statusMessage ||
    fallback
  );
}

export function buildUpstreamErrorContext({
  modelName,
  endpointInfo,
  requestHeaders = null,
  upstreamUrl = null,
  error = null,
  statusCode,
  responseBody,
  autoModel = null,
  targetModel = null,
  routingAttempts = null,
}) {
  const resolvedStatus =
    statusCode ?? error?.response?.status ?? error?.statusCode ?? null;
  const numericStatus = Number(resolvedStatus);

  return {
    model: modelName ?? null,
    upstreamModel: endpointInfo?.actualModel ?? null,
    endpointKey: endpointInfo?.endpointKey ?? null,
    endpointName: endpointInfo?.endpointName ?? null,
    apiFormat: endpointInfo?.apiFormat ?? null,
    maskedApiKey: endpointInfo?.token ? maskKey(endpointInfo.token) : null,
    autoModel,
    targetModel: targetModel ?? endpointInfo?.targetModel ?? null,
    routingAttempts,
    statusCode: Number.isInteger(numericStatus) ? numericStatus : null,
    errorCode: error?.code ?? null,
    requestHeaders,
    upstreamUrl: sanitizeUpstreamUrl(upstreamUrl),
    responseBody:
      responseBody !== undefined
        ? responseBody
        : (error?.responseBody ?? error?.response?.data ?? null),
  };
}
