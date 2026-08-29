// Relative rather than through the $contracts alias: this is a runtime value, and
// the root test runner resolves this module without Vite's alias map.
import { isReservedBodyParam } from "../../../../shared/contracts/bodyParams.js";

export const ANTHROPIC_BETA_HEADER = "anthropic-beta";
export const ANTHROPIC_BETA_VALUE = "context-1m-2025-08-07";
export const ANTHROPIC_VERSION_HEADER = "anthropic-version";
export const ANTHROPIC_VERSION_VALUE = "2023-06-01";
export const USER_AGENT_HEADER = "User-Agent";

export interface HeaderPresets {
  anthropicBeta: boolean;
  anthropicVersion: boolean;
  userAgent: boolean;
  userAgentValue: string;
}

export type ParsedCustomHeaders =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string };

export function emptyHeaderPresets(): HeaderPresets {
  return { anthropicBeta: false, anthropicVersion: false, userAgent: false, userAgentValue: "" };
}

// Arbitrary headers are edited as one "Name: value" pair per line. Only the first
// colon separates the two, so values holding colons (URLs, timestamps) survive a
// round trip. Names must be RFC 7230 tokens; anything else is rejected here rather
// than failing later inside the upstream fetch.
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/;

export function parseCustomHeaders(text: string): ParsedCustomHeaders {
  const headers: Record<string, string> = {};
  const seenNames = new Set<string>();
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;

    const lineNumber = index + 1;
    const separator = line.indexOf(":");
    if (separator === -1) {
      return { ok: false, error: `Custom header line ${lineNumber} must look like "Header: value"` };
    }

    const name = line.slice(0, separator).trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      return { ok: false, error: `Custom header line ${lineNumber} does not start with a valid header name` };
    }
    if (seenNames.has(name.toLowerCase())) {
      return { ok: false, error: `Custom header "${name}" is listed more than once` };
    }

    seenNames.add(name.toLowerCase());
    headers[name] = line.slice(separator + 1).trim();
  }

  return { ok: true, headers };
}

function matchesHeader(name: string, headerName: string): boolean {
  return name.toLowerCase() === headerName.toLowerCase();
}

// Presets own their canonical name/value pair only. A stored header that shares a
// preset name but carries another value stays an arbitrary header so editing an
// endpoint never rewrites it.
export function extractHeaderPresets(headers: Record<string, string> | undefined): {
  presets: HeaderPresets;
  rest: Record<string, string>;
} {
  const presets = emptyHeaderPresets();
  const rest: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== "string") continue;
    if (matchesHeader(name, ANTHROPIC_BETA_HEADER) && value === ANTHROPIC_BETA_VALUE) {
      presets.anthropicBeta = true;
    } else if (matchesHeader(name, ANTHROPIC_VERSION_HEADER) && value === ANTHROPIC_VERSION_VALUE) {
      presets.anthropicVersion = true;
    } else if (matchesHeader(name, USER_AGENT_HEADER)) {
      presets.userAgent = true;
      presets.userAgentValue = value;
    } else {
      rest[name] = value;
    }
  }

  return { presets, rest };
}

export function mergeHeaderPresets(
  headers: Record<string, string>,
  presets: HeaderPresets,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (presets.anthropicBeta && matchesHeader(name, ANTHROPIC_BETA_HEADER)) continue;
    if (presets.anthropicVersion && matchesHeader(name, ANTHROPIC_VERSION_HEADER)) continue;
    if (presets.userAgent && matchesHeader(name, USER_AGENT_HEADER)) continue;
    merged[name] = value;
  }

  if (presets.anthropicBeta) merged[ANTHROPIC_BETA_HEADER] = ANTHROPIC_BETA_VALUE;
  if (presets.anthropicVersion) merged[ANTHROPIC_VERSION_HEADER] = ANTHROPIC_VERSION_VALUE;
  if (presets.userAgent) merged[USER_AGENT_HEADER] = presets.userAgentValue.trim();

  return merged;
}

export function serializeCustomHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

export interface BodyParamPolicy {
  add: Record<string, unknown>;
  strip: string[];
}

export type ParsedBodyParams =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; error: string };

export type ParsedStripList =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

/**
 * Body params the proxy owns; see shared/contracts/bodyParams.ts. Rejected here
 * so the editor names the problem, and again server-side because a policy can
 * also arrive from a hand-edited endpoints.json.
 */
function reservedBodyParamError(label: string, name: string, line: number): string | null {
  if (!isReservedBodyParam(name)) return null;
  return `${label} line ${line} uses the reserved name "${name}"`;
}

/**
 * Arbitrary body params are edited as one "name: value" pair per line, matching
 * the custom-header editor. The value is read as JSON when it parses, so arrays,
 * objects, numbers, and booleans all round trip; anything else is kept as the
 * literal string, which is what makes `reasoning_effort: high` work without
 * quoting.
 */
export function parseBodyParams(text: string): ParsedBodyParams {
  const params: Record<string, unknown> = {};
  const seenNames = new Set<string>();
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;

    const lineNumber = index + 1;
    const separator = line.indexOf(":");
    if (separator === -1) {
      return { ok: false, error: `Body param line ${lineNumber} must look like "name: value"` };
    }

    const name = line.slice(0, separator).trim();
    if (!name || /\s/.test(name)) {
      return { ok: false, error: `Body param line ${lineNumber} does not start with a valid name` };
    }
    const reserved = reservedBodyParamError("Body param", name, lineNumber);
    if (reserved) return { ok: false, error: reserved };
    if (seenNames.has(name)) {
      return { ok: false, error: `Body param "${name}" is listed more than once` };
    }

    seenNames.add(name);
    params[name] = parseBodyParamValue(line.slice(separator + 1).trim());
  }

  return { ok: true, params };
}

function parseBodyParamValue(raw: string): unknown {
  if (!raw) return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Stripped params are one name per line. A pasted "name: value" pair is accepted
 * and its value ignored, so a line can be moved between the two editors without
 * being rewritten first.
 */
export function parseStripBodyParams(text: string): ParsedStripList {
  const names: string[] = [];
  const seenNames = new Set<string>();
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;

    const lineNumber = index + 1;
    const separator = line.indexOf(":");
    const name = (separator === -1 ? line : line.slice(0, separator)).trim();
    if (!name || /\s/.test(name)) {
      return { ok: false, error: `Stripped param line ${lineNumber} is not a valid name` };
    }
    const reserved = reservedBodyParamError("Stripped param", name, lineNumber);
    if (reserved) return { ok: false, error: reserved };
    if (seenNames.has(name)) continue;

    seenNames.add(name);
    names.push(name);
  }

  return { ok: true, names };
}

export function serializeBodyParams(params: Record<string, unknown> | undefined): string {
  return Object.entries(params ?? {})
    .map(([name, value]) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

export function serializeStripBodyParams(names: string[] | undefined): string {
  return (names ?? []).join("\n");
}

export function bodyParamCounts(policy: BodyParamPolicy | null | undefined): {
  added: number;
  stripped: number;
} {
  return {
    added: Object.keys(policy?.add ?? {}).length,
    stripped: (policy?.strip ?? []).length,
  };
}

export function maskTokenLikeServer(token: string): string {
  return token.length > 8
    ? `${token.substring(0, 4)}****${token.substring(token.length - 4)}`
    : "****";
}

export function isDuplicateToken(value: string, tokens: string[]): boolean {
  if (tokens.includes(value)) return true;
  const masked = maskTokenLikeServer(value);
  return tokens.some((token) => token.includes("****") && token === masked);
}

export function mergeBulkTokens(
  existingTokens: string[],
  input: string,
): { tokens: string[]; added: number; skipped: number } {
  const tokens = [...existingTokens];
  let added = 0;
  let skipped = 0;

  for (const line of input.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    if (value.includes("****") || isDuplicateToken(value, tokens)) {
      skipped++;
      continue;
    }
    tokens.push(value);
    added++;
  }

  return { tokens, added, skipped };
}

export function removeTokenAt(
  tokens: string[],
  pendingConfirmations: Set<number>,
  index: number,
): { tokens: string[]; pendingConfirmations: Set<number> } {
  const nextConfirmations = new Set<number>();
  for (const pendingIndex of pendingConfirmations) {
    if (pendingIndex === index) continue;
    nextConfirmations.add(pendingIndex > index ? pendingIndex - 1 : pendingIndex);
  }

  return {
    tokens: tokens.filter((_, tokenIndex) => tokenIndex !== index),
    pendingConfirmations: nextConfirmations,
  };
}
