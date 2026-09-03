/** Outbound proxy definitions that upstream requests can be routed through. */

export type ProxyType = "http" | "socks4" | "socks5";

/** Persisted proxy configuration in proxies.json. */
export interface UpstreamProxyConfig {
  name?: string;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Proxy shape returned to the admin UI; the password is masked, never raw. */
export interface ProxyListItem {
  id: string;
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}
