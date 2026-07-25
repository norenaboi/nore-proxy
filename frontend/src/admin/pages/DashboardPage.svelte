<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson } from "$frontend/lib/api/admin";
  import { dashboardRange, type DashboardRange } from "$frontend/lib/stores";

  interface RangeSummary {
    requests: number; input_tokens: number; output_tokens: number;
    cache_write_tokens: number; cache_read_tokens: number;
    successes: number; failures: number; success_rate: number;
    estimated_cost: number; input_cost: number; output_cost: number;
    cache_write_cost: number; cache_read_cost: number;
  }

  interface ApiKeyUsage {
    name: string; requests: number; input_tokens: number; output_tokens: number;
    cache_write_tokens: number; cache_read_tokens: number; estimated_cost: number;
  }

  interface DashboardData {
    ranges: Record<string, { summary: RangeSummary; api_keys: ApiKeyUsage[] }>;
  }

  interface Request {
    id: number; timestamp: number; name: string; apiKey: string; model: string;
    endpointName: string; inputTokens: number; outputTokens: number;
    cacheWriteTokens: number; cacheReadTokens: number; duration: number;
    estimatedCost: number; status: string;
  }

  let data = $state<DashboardData | null>(null);
  let loading = $state(true);
  let errorMsg = $state("");
  let range = $state<DashboardRange>("24h");

  $effect(() => {
    const unsubscribe = dashboardRange.subscribe((value) => { range = value; });
    return unsubscribe;
  });

  let requests = $state<Request[]>([]);
  let requestsLoading = $state(false);
  let requestsState = $state("");
  let requestsExpanded = $state(false);
  let cursor = $state<string | null>(null);
  let hasMore = $state(true);
  let seen = new Set<number>();
  let generation = 0;
  let filtersLoaded = false;

  let apiKeyFilter = $state("");
  let modelFilter = $state("");
  let statusFilter = $state("");
  let timeFilter = $state("");
  let apiKeyOptions = $state<{ value: string; label: string }[]>([]);
  let modelOptions = $state<string[]>([]);

  let sentinel = $state<HTMLElement>();
  let observer: IntersectionObserver;

  const rangeLabels: Record<DashboardRange, string> = {
    "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", total: "All time",
  };

  async function load() {
    if (document.hidden) return;
    try {
      data = await requestAdminJson<DashboardData>("/api/logs");
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load dashboard";
    } finally {
      loading = false;
    }
  }

  function buildUrl() {
    const p = new URLSearchParams({ limit: "50" });
    if (cursor) p.set("cursor", cursor);
    if (apiKeyFilter) p.set("apiKey", apiKeyFilter);
    if (modelFilter) p.set("model", modelFilter);
    if (statusFilter) p.set("status", statusFilter);
    if (timeFilter) {
      const s = ({ "24h": 86400, "7d": 604800, "30d": 2592000 } as Record<string, number>)[timeFilter];
      if (s) p.set("from", String(Math.floor(Date.now() / 1000) - s));
    }
    return `/api/requests?${p}`;
  }

  async function loadRequests({ reset = false } = {}) {
    if (reset) {
      generation++; cursor = null; hasMore = true; seen.clear(); requests = [];
    } else if (requestsLoading || !hasMore) return;
    const gen = generation;
    requestsLoading = true;
    requestsState = "Loading requests…";
    try {
      const d = await requestAdminJson<{ requests: Request[]; nextCursor: string; hasMore: boolean }>(buildUrl());
      if (gen !== generation) return;
      const fresh = d.requests.filter((r) => !seen.has(r.id));
      fresh.forEach((r) => seen.add(r.id));
      requests = [...requests, ...fresh];
      cursor = d.nextCursor;
      hasMore = Boolean(d.hasMore);
      requestsState = seen.size === 0 ? "No requests match these filters."
        : !hasMore ? "All matching requests are shown."
        : "Scroll to load 50 more requests.";
    } catch (e) {
      if (gen === generation) requestsState = e instanceof Error ? e.message : "Error";
    } finally {
      if (gen === generation) requestsLoading = false;
    }
  }

  async function loadFilters() {
    if (filtersLoaded) return;
    const d = await requestAdminJson<{ apiKeys: { value: string; label: string }[]; models: string[] }>("/api/requests/filters");
    apiKeyOptions = d.apiKeys;
    modelOptions = d.models;
    filtersLoaded = true;
  }

  async function toggleExpanded() {
    requestsExpanded = !requestsExpanded;
    if (requestsExpanded) {
      await loadFilters().catch(() => {});
      observer?.observe(sentinel);
    } else {
      observer?.disconnect();
    }
  }

  function resetFilters() {
    apiKeyFilter = ""; modelFilter = ""; statusFilter = ""; timeFilter = "";
    loadRequests({ reset: true });
  }

  function fmt(n: number) { return Number(n || 0).toLocaleString(); }
  function cost(n: number) { return `$${Number(n || 0).toFixed(4)}`; }
  function fmtTime(ts: number) { const d = new Date(ts * 1000); return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`; }
  function requestStatus(status: string) { return ["success", "failed"].includes(status) ? status : "unknown"; }

  onMount(() => {
    load();
    loadRequests({ reset: true });
    const interval = setInterval(load, 30000);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && requestsExpanded) loadRequests();
    }, { rootMargin: "300px" });
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", vis);
      observer.disconnect();
    };
  });
</script>

{#if loading}
  <div class="loading dashboard-loading"><div class="loading-spinner"></div><span>Loading dashboard data…</span></div>
{:else if errorMsg && !data}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else if data}
  {@const rd = data.ranges?.[range]}
  {#if !rd}
    <div class="page-error" role="alert">Dashboard range data unavailable. Restart the server with the matching frontend and backend update.</div>
  {:else}
    <section class="summary-strip" aria-label="Traffic summary">
      <article>
        <span>Requests</span>
        <strong>{fmt(rd.summary.requests)}</strong>
        <small>{rangeLabels[range]}</small>
      </article>
      <article>
        <span>Estimated cost</span>
        <strong>${Number(rd.summary.estimated_cost || 0).toFixed(2)}</strong>
        <small>Model-aware estimate</small>
      </article>
      <article>
        <span>Success rate</span>
        <strong>{Number(rd.summary.success_rate || 0).toFixed(1)}%</strong>
        <small>{fmt(rd.summary.successes)} successful · {fmt(rd.summary.failures)} failed</small>
      </article>
    </section>

    <section class="token-ledger" aria-label="Token totals">
      <article><span>Input tokens</span><strong>{fmt(rd.summary.input_tokens)}</strong><small>{cost(rd.summary.input_cost)}</small></article>
      <article><span>Output tokens</span><strong>{fmt(rd.summary.output_tokens)}</strong><small>{cost(rd.summary.output_cost)}</small></article>
      <article><span>Cache read</span><strong>{fmt(rd.summary.cache_read_tokens)}</strong><small>{cost(rd.summary.cache_read_cost)}</small></article>
      <article><span>Cache write</span><strong>{fmt(rd.summary.cache_write_tokens)}</strong><small>{cost(rd.summary.cache_write_cost)}</small></article>
    </section>

    <div class="tables-grid">
      <section class="table-card usage-table-card">
        <header class="table-header">
          <div><p class="eyebrow">API keys</p><h2>API Keys Usage</h2></div>
          <span><strong>{rangeLabels[range]}</strong> · {fmt(rd.api_keys.length)} keys</span>
        </header>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="table-scroll" role="region" tabindex="0" aria-label="API key usage table">
          <table>
            <caption class="visually-hidden">API key usage for selected period</caption>
            <thead><tr><th>Name</th><th class="numeric-cell">Requests</th><th class="numeric-cell">Input</th><th class="numeric-cell">Output</th><th class="numeric-cell">Cache Write</th><th class="numeric-cell">Cache Read</th><th class="numeric-cell">Estimated Cost</th></tr></thead>
            <tbody>
              {#each rd.api_keys as key}
                <tr>
                  <td><strong>{key.name}</strong></td>
                  <td class="numeric-cell">{fmt(key.requests)}</td>
                  <td class="numeric-cell">{fmt(key.input_tokens)}</td>
                  <td class="numeric-cell">{fmt(key.output_tokens)}</td>
                  <td class="numeric-cell">{fmt(key.cache_write_tokens)}</td>
                  <td class="numeric-cell">{fmt(key.cache_read_tokens)}</td>
                  <td class="numeric-cell">${Number(key.estimated_cost || 0).toFixed(2)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      <section class="table-card request-history-card">
        <header class="table-header">
          <div><p class="eyebrow">Recent traffic</p><h2>Recent Requests</h2></div>
          <button class="request-history-toggle" type="button" aria-expanded={requestsExpanded} aria-controls="request-history-filters" onclick={toggleExpanded}>
            Browse all requests <i class={`fa-solid fa-chevron-${requestsExpanded ? "up" : "down"}`}></i>
          </button>
        </header>
        {#if requestsExpanded}
          <div id="request-history-filters" class="request-history-filters">
            <label>API key<select bind:value={apiKeyFilter} onchange={() => loadRequests({ reset: true })}><option value="">All API keys</option>{#each apiKeyOptions as o}<option value={o.value}>{o.label}</option>{/each}</select></label>
            <label>Model<select bind:value={modelFilter} onchange={() => loadRequests({ reset: true })}><option value="">All models</option>{#each modelOptions as m}<option value={m}>{m}</option>{/each}</select></label>
            <label>Status<select bind:value={statusFilter} onchange={() => loadRequests({ reset: true })}><option value="">All statuses</option><option value="success">Success</option><option value="failed">Failed</option></select></label>
            <label>Time range<select bind:value={timeFilter} onchange={() => loadRequests({ reset: true })}><option value="">All time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
            <button type="button" onclick={resetFilters}>Reset filters</button>
          </div>
        {/if}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="request-table-scroll" role="region" tabindex="0" aria-label="Recent requests table">
          <table>
            <caption class="visually-hidden">Recent API request metadata</caption>
            <thead><tr><th>Time</th><th>Name</th><th>Model</th><th class="numeric-cell">Input Tokens</th><th class="numeric-cell">Output Tokens</th><th class="numeric-cell">Cache Write</th><th class="numeric-cell">Cache Read</th><th class="numeric-cell">Duration</th><th class="numeric-cell">Est. Cost</th><th>Status</th></tr></thead>
            <tbody>
              {#each requests as req (req.id)}
                <tr>
                  <td class="timestamp">{fmtTime(req.timestamp)}</td>
                  <td>{req.name || req.apiKey || "Unknown"}</td>
                  <td class="request-model">{req.model || "Unknown"}</td>
                  <td class="numeric-cell">{fmt(req.inputTokens)}</td>
                  <td class="numeric-cell">{fmt(req.outputTokens)}</td>
                  <td class="numeric-cell">{fmt(req.cacheWriteTokens)}</td>
                  <td class="numeric-cell">{fmt(req.cacheReadTokens)}</td>
                  <td class="numeric-cell">{Number(req.duration || 0).toFixed(2)}s</td>
                  <td class="numeric-cell">${Number(req.estimatedCost || 0).toFixed(4)}</td>
                  <td><span class="request-status {requestStatus(req.status)}">{requestStatus(req.status)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class:error={requestsState && !requestsLoading && requestsState !== "No requests match these filters." && !requestsState.startsWith("All matching") && !requestsState.startsWith("Scroll to load")} class="request-history-state" role="status" aria-live="polite">{requestsState}</div>
        <div class="request-history-sentinel" bind:this={sentinel} aria-hidden="true"></div>
      </section>
    </div>
  {/if}
{/if}

<style>
  .summary-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-bottom: 18px;
    overflow: hidden;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--card-bg);
  }
  .summary-strip article {
    padding: 25px 28px;
    border-right: 1px solid var(--border-color);
  }
  .summary-strip article:last-child { border-right: 0; }
  .summary-strip span,
  .token-ledger span { color: var(--text-secondary); }
  .summary-strip strong {
    display: block;
    margin: 12px 0 4px;
    font: 500 38px/1 Georgia, serif;
    font-variant-numeric: tabular-nums;
  }
  .summary-strip small,
  .token-ledger small { color: var(--text-secondary); }
  .token-ledger {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    margin-bottom: 36px;
    border-block: 1px solid var(--border-color);
  }
  .token-ledger article { padding: 20px 22px; }
  .token-ledger strong {
    display: block;
    margin: 7px 0;
    font: 500 22px/1.2 Georgia, serif;
    font-variant-numeric: tabular-nums;
  }
  .tables-grid { display: grid; gap: 18px; }
  .table-card { overflow: hidden; }
  .table-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
    padding: 24px 26px;
    border-bottom: 1px solid var(--border-color);
  }
  .table-header h2 { font: 500 23px/1.2 Georgia, serif; }
  .table-header > span { color: var(--text-secondary); font-size: 12px; }
  .table-header > span strong { color: var(--primary-dark); }
  .table-scroll,
  .request-table-scroll { overflow-x: auto; }
  .usage-table-card table { min-width: 820px; }
  .request-table-scroll table { min-width: 1180px; }
  th,
  td { padding: 12px 14px; white-space: nowrap; }
  .numeric-cell { text-align: right; font-variant-numeric: tabular-nums; }
  .timestamp { font-size: 12px; }
  .request-model {
    color: var(--primary-dark);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .dashboard-loading {
    min-height: 65vh;
    flex-direction: column;
    justify-content: center;
  }
  .dashboard-loading :global(.loading-spinner) {
    width: 38px;
    height: 38px;
    margin-bottom: 2px;
    border-width: 3px;
  }
  .request-history-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 8px 13px;
    border: 1px solid var(--primary);
    background: var(--primary-light);
    color: var(--primary-dark);
    cursor: pointer;
    font-weight: 700;
  }
  .request-history-toggle:hover { border-color: var(--primary-dark); }
  .request-history-filters {
    display: grid;
    grid-template-columns: repeat(4, minmax(145px, 1fr)) auto;
    gap: 12px;
    align-items: end;
    padding: 18px 26px;
    border-bottom: 1px solid var(--border-color);
    background: var(--primary-light);
  }
  .request-history-filters label {
    display: grid;
    gap: 6px;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 700;
  }
  .request-history-filters select,
  .request-history-filters button { min-width: 0; min-height: 40px; padding: 8px 10px; }
  .request-history-filters button {
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--primary-dark);
    cursor: pointer;
    font-weight: 700;
  }
  .request-status {
    display: inline-flex;
    padding: 4px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    text-transform: capitalize;
  }
  .request-status.success { background: var(--success-alpha-01); color: var(--success-dark); }
  .request-status.failed { background: var(--danger-alpha-01); color: var(--danger-dark); }
  .request-status.unknown { background: var(--bg-tertiary); color: var(--text-secondary); }
  .request-history-state {
    min-height: 42px;
    padding: 12px 24px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .request-history-state.error { color: var(--danger-dark); }
  .request-history-sentinel { height: 1px; }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @media (max-width: 900px) {
    .request-history-filters { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 720px) {
    .summary-strip { grid-template-columns: 1fr; }
    .summary-strip article { border-right: 0; border-bottom: 1px solid var(--border-color); }
    .summary-strip article:last-child { border-bottom: 0; }
    .token-ledger { grid-template-columns: 1fr 1fr; }
    .table-header { display: grid; }
  }
  @media (max-width: 520px) {
    .token-ledger,
    .request-history-filters { grid-template-columns: 1fr; }
  }
</style>
