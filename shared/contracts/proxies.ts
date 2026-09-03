/**
 * Outbound proxy definitions shared by the admin API and the proxy manager.
 *
 * A proxy is stored in proxies.json and referenced by id from endpoints.json.
 * HTTP proxies are forwarded through as-is; SOCKS proxies tunnel through a
 * SOCKS handshake. Both may carry username/password authentication.
 */

import type { ProxyType, UpstreamProxyConfig } from "../../types/proxy.js";

export const PROXY_TYPES: readonly ProxyType[] = ["http", "socks4", "socks5"] as const;

const MAX_NAME_LENGTH = 128;
const MAX_HOST_LENGTH = 253;
const MAX_CREDENTIAL_LENGTH = 512;

/**
 * Masks a stored proxy password for admin responses, matching the endpoint
 * token masking shape. A masked value round-trips through the update API as
 * "keep the stored secret" and is never persisted as a replacement password.
 */
export function maskProxyPassword(password: string): string {
  return password.length > 8
    ? `${password.substring(0, 4)}****${password.substring(password.length - 4)}`
    : "****";
}

/** True when a submitted password is a masked placeholder, not a new secret. */
export function isMaskedProxyPassword(value: string): boolean {
  return value.includes("****");
}

/**
 * Validates an admin-submitted proxy definition. Field-by-field so the editor
 * and API can name the problem. Returns a normalized config: optional string
 * fields are trimmed and dropped when empty, so callers never persist blanks.
 */
export function validateProxyConfig(
  input: unknown,
): { ok: true; value: UpstreamProxyConfig } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Proxy definition must be a JSON object" };
  }
  const body = input as Record<string, unknown>;

  let name: string | undefined;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string") return { ok: false, error: "Proxy name must be a string" };
    name = body.name.trim();
    if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `Proxy name must be at most ${MAX_NAME_LENGTH} characters` };
    if (name === "") name = undefined;
  }

  const type = body.type;
  if (!PROXY_TYPES.includes(type as ProxyType)) {
    return { ok: false, error: `Proxy type must be one of: ${PROXY_TYPES.join(", ")}` };
  }

  const host = typeof body.host === "string" ? body.host.trim() : "";
  if (host === "") return { ok: false, error: "Proxy host is required" };
  if (host.length > MAX_HOST_LENGTH) return { ok: false, error: `Proxy host must be at most ${MAX_HOST_LENGTH} characters` };
  if (/\s/.test(host) || host.includes("://")) {
    return { ok: false, error: "Proxy host must be a bare host or IP address, without a scheme" };
  }

  const portValue = typeof body.port === "string" ? Number(body.port.trim()) : body.port;
  if (!Number.isInteger(portValue) || (portValue as number) < 1 || (portValue as number) > 65535) {
    return { ok: false, error: "Proxy port must be an integer from 1 to 65535" };
  }

  let username: string | undefined;
  if (body.username !== undefined && body.username !== null) {
    if (typeof body.username !== "string") return { ok: false, error: "Proxy username must be a string" };
    username = body.username.trim();
    if (username.length > MAX_CREDENTIAL_LENGTH) return { ok: false, error: `Proxy username must be at most ${MAX_CREDENTIAL_LENGTH} characters` };
    if (username === "") username = undefined;
  }

  // Not trimmed: passwords may legitimately begin or end with whitespace.
  let password: string | undefined;
  if (body.password !== undefined && body.password !== null) {
    if (typeof body.password !== "string") return { ok: false, error: "Proxy password must be a string" };
    if (body.password.length > MAX_CREDENTIAL_LENGTH) return { ok: false, error: `Proxy password must be at most ${MAX_CREDENTIAL_LENGTH} characters` };
    if (body.password !== "") password = body.password;
  }

  return {
    ok: true,
    value: { ...(name !== undefined ? { name } : {}), type: type as ProxyType, host, port: portValue as number, ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}) },
  };
}
