/**
 * ProxyManager — persisted outbound proxy definitions.
 *
 * Proxies live in proxies.json as { "p1": { type, host, port, ... }, ... } and
 * are referenced from endpoints.json by id. Raw passwords never leave this
 * module except to build agent URLs; admin responses carry the masked form.
 */

import fs from "fs";
import { getProxiesPath } from "../utils/configPaths.js";
import { writeJsonAtomic } from "../utils/atomicJson.js";
import {
  maskProxyPassword,
  validateProxyConfig,
} from "../shared/contracts/proxies.js";
import type { ProxyListItem, UpstreamProxyConfig } from "../types/proxy.js";

type ProxiesDocument = { proxies?: Record<string, UpstreamProxyConfig>; nextIndex?: number };

class ProxyManager {
  private _proxies: Record<string, UpstreamProxyConfig> = {};
  // Ids are never reused within the life of the file: a stale hand-edited
  // endpoints.json reference must stay unknown (and degrade to a direct
  // connection), not silently attach itself to a newer proxy.
  private _nextIndex = 1;

  constructor() {
    this._load();
  }

  _load(): void {
    this._proxies = {};
    this._nextIndex = 1;
    const proxiesPath = getProxiesPath();

    if (!fs.existsSync(proxiesPath)) {
      // Self-materialize so a mounted-but-empty data/ directory starts with a
      // writable proxies file the admin API can extend.
      try {
        writeJsonAtomic(proxiesPath, { proxies: {}, nextIndex: 1 });
        console.log(`proxies.json not found — created an empty one at ${proxiesPath}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`Error creating proxies.json: ${message}`);
      }
      return;
    }

    try {
      const content = fs.readFileSync(proxiesPath, "utf-8");
      const data = JSON.parse(content) as ProxiesDocument;
      const entries = data?.proxies && typeof data.proxies === "object" ? Object.entries(data.proxies) : [];

      for (const [id, proxy] of entries) {
        if (!/^p\d+$/.test(id)) {
          console.warn(`Warning: Invalid proxy id "${id}" — skipping`);
          continue;
        }
        // Hand-edited files bypass the admin API, so revalidate here: a
        // malformed proxy would otherwise fail at connection time.
        const validated = validateProxyConfig(proxy);
        if (!validated.ok) {
          console.warn(`Warning: Proxy "${id}" is invalid (${validated.error}) — skipping`);
          continue;
        }
        this._proxies[id] = validated.value;
      }

      // The persisted counter wins when present; otherwise derive it from the
      // highest id in the file so a counter-less file still starts past every
      // existing proxy.
      let highest = 0;
      for (const id of Object.keys(this._proxies)) {
        highest = Math.max(highest, parseInt(id.slice(1), 10));
      }
      this._nextIndex = Math.max(
        typeof data?.nextIndex === "number" && Number.isFinite(data.nextIndex) ? data.nextIndex : 1,
        highest + 1,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error loading proxies.json: ${message}`);
    }
  }

  _save(): void {
    const document: ProxiesDocument = { proxies: this._proxies, nextIndex: this._nextIndex };
    writeJsonAtomic(getProxiesPath(), document);
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._proxies, id);
  }

  get(id: string): UpstreamProxyConfig | null {
    return this.has(id) ? this._proxies[id] : null;
  }

  /** All proxies with their ids, ordered by numeric id. */
  entries(): Array<{ id: string; config: UpstreamProxyConfig }> {
    return Object.entries(this._proxies)
      .sort(([a], [b]) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
      .map(([id, config]) => ({ id, config }));
  }

  /** Admin-facing list: same order, with the password masked. */
  maskedList(): ProxyListItem[] {
    return this.entries().map(({ id, config }) => ({
      id,
      name: config.name || `Proxy ${id.slice(1)}`,
      type: config.type,
      host: config.host,
      port: config.port,
      username: config.username ?? null,
      password: config.password !== undefined ? maskProxyPassword(config.password) : null,
    }));
  }

  /** Persists a validated config under a fresh id and returns the id. */
  create(value: UpstreamProxyConfig): string {
    const id = `p${this._nextIndex}`;
    this._nextIndex += 1;
    this._proxies[id] = value;
    this._save();
    return id;
  }

  /** Replaces the stored config. Returns false when the id is unknown. */
  update(id: string, value: UpstreamProxyConfig): boolean {
    if (!this.has(id)) return false;
    this._proxies[id] = value;
    this._save();
    return true;
  }

  /** Deletes a proxy. Endpoint references are the admin route's concern. */
  remove(id: string): boolean {
    if (!this.has(id)) return false;
    delete this._proxies[id];
    this._save();
    return true;
  }

  reload(): void {
    this._load();
  }
}

export default new ProxyManager();
