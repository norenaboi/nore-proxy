/**
 * Builds and caches the axios agents that route an upstream request through a
 * configured proxy.
 *
 * HTTP proxies use an HttpsProxyAgent: it issues CONNECT for https targets and
 * forwards plain http requests through the proxy. SOCKS proxies tunnel through
 * a SocksProxyAgent. Both sit in the httpAgent/httpsAgent slots of an axios
 * request, so the routes just spread the returned agents into the config.
 *
 * Agents are cached per proxy id and keyed by the proxy's current config, so
 * editing or reloading a proxy swaps in a fresh agent on the next request while
 * healthy proxies keep their pooled sockets.
 */

import type { Agent as HttpAgent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import proxyManager from "../services/proxyManager.js";
import type { UpstreamProxyConfig } from "../types/proxy.js";

export interface ProxyAgents {
  httpAgent: HttpAgent;
  httpsAgent: HttpAgent;
}

function proxyUrl(config: UpstreamProxyConfig): string {
  const auth =
    config.username !== undefined || config.password !== undefined
      ? `${encodeURIComponent(config.username ?? "")}:${encodeURIComponent(config.password ?? "")}@`
      : "";
  return `${config.type}://${auth}${config.host}:${config.port}`;
}

const cache = new Map<string, { signature: string; agents: ProxyAgents }>();
const missingWarned = new Set<string>();

/**
 * Agents for the proxy an endpoint references, or null for a direct
 * connection (no proxy, blank id, or a proxy id that no longer resolves —
 * the last case warns once and degrades to direct rather than failing every
 * request on a stale hand-edited endpoints.json).
 */
export function proxyAgentsFor(proxyId: string | null | undefined): ProxyAgents | null {
  if (proxyId === null || proxyId === undefined || proxyId === "") return null;

  const config = proxyManager.get(proxyId);
  if (!config) {
    if (!missingWarned.has(proxyId)) {
      missingWarned.add(proxyId);
      console.warn(`Warning: Endpoint references unknown proxy "${proxyId}" — connecting directly`);
    }
    return null;
  }

  const signature = JSON.stringify(config);
  const cached = cache.get(proxyId);
  if (cached && cached.signature === signature) return cached.agents;
  if (cached) cached.agents.httpAgent.destroy();

  const agent = config.type === "http"
    ? new HttpsProxyAgent(proxyUrl(config))
    : new SocksProxyAgent(proxyUrl(config));
  // One agent serves both slots: it tunnels https via CONNECT and proxies
  // plain http by forwarding, and sockets pool across both protocols.
  const agents: ProxyAgents = { httpAgent: agent, httpsAgent: agent };
  cache.set(proxyId, { signature, agents });
  return agents;
}

/** Drops cached agents; used when the proxy set is reloaded wholesale. */
export function clearProxyAgents(): void {
  for (const { agents } of cache.values()) agents.httpAgent.destroy();
  cache.clear();
  missingWarned.clear();
}
