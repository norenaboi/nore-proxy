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

export function parseCustomHeaders(text: string): ParsedCustomHeaders {
  if (!text.trim()) return { ok: true, headers: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON in custom headers" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Custom headers must be a JSON object" };
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      return { ok: false, error: `Custom header "${name}" must have a text value` };
    }
    headers[name] = value;
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
  return Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : "";
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
