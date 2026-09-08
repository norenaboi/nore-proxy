<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson } from "$frontend/lib/api/admin";
  import SelectMenu, { type SelectMenuOption } from "$frontend/components/admin/SelectMenu.svelte";

  interface Request {
    id: number; timestamp: number; name: string; apiKey: string; model: string;
    endpointName: string; inputTokens: number; outputTokens: number;
    cacheWriteTokens: number; cacheReadTokens: number; duration: number;
    estimatedCost: number; status: string;
  }

  interface RequestDetail {
    id: number; requestId: string; timestamp: number; name: string; apiKey: string;
    model: string; status: string; duration: number; costSource: string;
    request: { clientIp: string; protocol: string; method: string; path: string; streaming: boolean | null };
    routing: { requestedModel: string; targetModel: string; upstreamModel: string; endpointName: string; apiFormat: string; upstreamUrl: string; maskedUpstreamKey: string; attemptCount: number; attempts: unknown };
    outcome: { proxyStatus: number; upstreamStatus: number; error: string };
    billing: { accounting_version: string; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; pricing_per_million: Record<string, number>; costs: Record<string, number> };
    relatedError: { id: number; errorMessage: string; errorType: string } | null;
  }

  let requests = $state<Request[]>([]);
  let detail = $state<RequestDetail | null>(null);
  let detailOpen = $state(false);
  let detailLoading = $state(false);
  let detailError = $state("");
  let listError = $state("");
  let loading = $state(false);
  let total = $state(0);
  let offset = $state(0);
  const limit = 50;
  let generation = 0;
  let filtersLoaded = $state(false);

  let apiKeyFilter = $state("");
  let modelFilter = $state("");
  let endpointFilter = $state("");
  let statusFilter = $state("");
  let timeFilter = $state("");
  let apiKeyOptions = $state<{ value: string; label: string }[]>([]);
  let modelOptions = $state<string[]>([]);
  let endpointOptions = $state<string[]>([]);

  let previousBodyOverflow: string | null = null;

  function buildUrl(requestedOffset = offset) {
    const p = new URLSearchParams({ limit: String(limit), offset: String(requestedOffset) });
    if (apiKeyFilter) p.set("apiKey", apiKeyFilter);
    if (modelFilter) p.set("model", modelFilter);
    if (endpointFilter) p.set("endpoint", endpointFilter);
    if (statusFilter) p.set("status", statusFilter);
    if (timeFilter) {
      const s = ({ "24h": 86400, "7d": 604800, "30d": 2592000 } as Record<string, number>)[timeFilter];
      if (s) p.set("from", String(Math.floor(Date.now() / 1000) - s));
    }
    return `/api/requests?${p}`;
  }

  // New traffic keeps arriving, so a page that was in range when it was
  // requested can fall past the end; step back to the last populated page.
  // A filter change can also land mid-flight, so only the newest load wins.
  async function loadRequests(requestedOffset = offset) {
    const gen = ++generation;
    loading = true;
    listError = "";
    try {
      let d = await requestAdminJson<{ requests: Request[]; total: number }>(buildUrl(requestedOffset));
      if (gen !== generation) return;
      let nextOffset = requestedOffset;
      const nextTotal = d.total ?? 0;
      if (nextOffset >= nextTotal && nextOffset > 0) {
        nextOffset = Math.max(0, Math.floor(Math.max(nextTotal - 1, 0) / limit) * limit);
        d = await requestAdminJson<{ requests: Request[]; total: number }>(buildUrl(nextOffset));
        if (gen !== generation) return;
      }
      offset = nextOffset;
      total = d.total ?? 0;
      requests = d.requests ?? [];
    } catch (e) {
      if (gen === generation) listError = e instanceof Error ? e.message : "Could not load request history.";
    } finally {
      if (gen === generation) loading = false;
    }
  }

  async function loadFilters() {
    if (filtersLoaded) return;
    const d = await requestAdminJson<{ apiKeys: { value: string; label: string }[]; models: string[]; endpoints: string[] }>("/api/requests/filters");
    apiKeyOptions = d.apiKeys;
    modelOptions = d.models;
    endpointOptions = d.endpoints ?? [];
    filtersLoaded = true;
  }

  function lockBodyScroll() {
    if (previousBodyOverflow !== null) return;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }

  function restoreBodyScroll() {
    if (previousBodyOverflow === null) return;
    document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = null;
  }

  async function openDetail(id: number) {
    lockBodyScroll();
    detailOpen = true; detailLoading = true; detailError = ""; detail = null;
    try {
      const d = await requestAdminJson<{ request: RequestDetail }>(`/api/requests/${id}`);
      detail = d.request;
    } catch (e) {
      detailError = e instanceof Error ? e.message : "Failed to load";
    } finally {
      detailLoading = false;
    }
  }

  function closeDetail() {
    detailOpen = false;
    restoreBodyScroll();
  }

  function fmtTime(ts: number) { const d = new Date(ts * 1000); return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`; }
  function money(v: number) { return `$${Number(v || 0).toFixed(8)}`; }

  // Each list keeps the empty sentinel the query builder reads as "unfiltered".
  // The key, model, and endpoint lists come from traffic, so they can run long
  // enough for the menu to grow its own search box.
  const apiKeyMenuOptions = $derived<SelectMenuOption[]>([
    { value: "", label: "All keys" },
    ...apiKeyOptions.map((option) => ({ value: option.value, label: option.label })),
  ]);
  const modelMenuOptions = $derived<SelectMenuOption[]>([
    { value: "", label: "All models" },
    ...modelOptions.map((model) => ({ value: model, label: model })),
  ]);
  const endpointMenuOptions = $derived<SelectMenuOption[]>([
    { value: "", label: "All endpoints" },
    ...endpointOptions.map((endpoint) => ({ value: endpoint, label: endpoint })),
  ]);
  const statusMenuOptions: SelectMenuOption[] = [
    { value: "", label: "All statuses" },
    { value: "success", label: "Success" },
    { value: "failed", label: "Failed" },
  ];
  const timeMenuOptions: SelectMenuOption[] = [
    { value: "", label: "All time" },
    { value: "24h", label: "Last 24 hours" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
  ];

  function resetFilters() {
    apiKeyFilter = ""; modelFilter = ""; endpointFilter = ""; statusFilter = ""; timeFilter = "";
    void loadRequests(0);
  }

  onMount(() => {
    let disposed = false;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && detailOpen) closeDetail(); };
    document.addEventListener("keydown", onKey);

    void (async () => {
      await loadFilters().catch(() => {});
      if (disposed) return;
      await loadRequests(0);
    })();

    return () => {
      disposed = true;
      document.removeEventListener("keydown", onKey);
      restoreBodyScroll();
    };
  });

  const start = $derived(total === 0 ? 0 : offset + 1);
  const end = $derived(Math.min(offset + limit, total));
</script>

<section class="toolbar" aria-label="Request filters">
  <div class="filters">
    <div class="filter-field">
      <span class="filter-label" id="apiKeyFilterLabel">API key</span>
      <SelectMenu
        options={apiKeyMenuOptions}
        value={apiKeyFilter}
        onSelect={(value) => { apiKeyFilter = value; loadRequests(0); }}
        panelId="logs-api-key-filter-menu"
        panelLabel="API key filter"
        labelledBy="apiKeyFilterLabel"
        searchPlaceholder="Search keys…"
        emptyText="No keys match."
        panelMinWidth={260}
      />
    </div>
    <div class="filter-field">
      <span class="filter-label" id="modelFilterLabel">Model</span>
      <SelectMenu
        options={modelMenuOptions}
        value={modelFilter}
        onSelect={(value) => { modelFilter = value; loadRequests(0); }}
        panelId="logs-model-filter-menu"
        panelLabel="Model filter"
        labelledBy="modelFilterLabel"
        searchPlaceholder="Search models…"
        emptyText="No models match."
        panelMinWidth={280}
      />
    </div>
    <div class="filter-field">
      <span class="filter-label" id="endpointFilterLabel">Endpoint</span>
      <SelectMenu
        options={endpointMenuOptions}
        value={endpointFilter}
        onSelect={(value) => { endpointFilter = value; loadRequests(0); }}
        panelId="logs-endpoint-filter-menu"
        panelLabel="Endpoint filter"
        labelledBy="endpointFilterLabel"
        searchPlaceholder="Search endpoints…"
        emptyText="No endpoints match."
        panelMinWidth={260}
      />
    </div>
    <div class="filter-field">
      <span class="filter-label" id="statusFilterLabel">Status</span>
      <SelectMenu
        options={statusMenuOptions}
        value={statusFilter}
        onSelect={(value) => { statusFilter = value; loadRequests(0); }}
        panelId="logs-status-filter-menu"
        panelLabel="Status filter"
        labelledBy="statusFilterLabel"
      />
    </div>
    <div class="filter-field">
      <span class="filter-label" id="timeFilterLabel">Time range</span>
      <SelectMenu
        options={timeMenuOptions}
        value={timeFilter}
        onSelect={(value) => { timeFilter = value; loadRequests(0); }}
        panelId="logs-time-filter-menu"
        panelLabel="Time range filter"
        labelledBy="timeFilterLabel"
        panelMinWidth={200}
      />
    </div>
  </div>
  <div class="toolbar-actions">
    <button class="btn btn-secondary" type="button" onclick={resetFilters}><i class="fa-solid fa-filter-circle-xmark"></i> Reset</button>
    <button class="btn btn-primary" type="button" onclick={() => loadRequests(0)}><i class="fa-solid fa-rotate"></i> Refresh</button>
  </div>
</section>

<section class="logs-card">
  <div class="card-header">
    <div class="card-title"><i class="fa-solid fa-clock-rotate-left"></i> Completed requests</div>
    <span class="count-pill">{total.toLocaleString()} {total === 1 ? "request" : "requests"}</span>
  </div>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Time</th><th>Name</th><th>Model</th><th>Endpoint</th><th class="numeric-cell">Input</th><th class="numeric-cell">Output</th><th class="numeric-cell">Cache W</th><th class="numeric-cell">Cache R</th><th class="numeric-cell">Duration</th><th class="numeric-cell">Cost</th><th>Status</th></tr></thead>
      <tbody>
        {#if loading}
          {#each Array(6) as _}
            <tr class="skeleton" aria-hidden="true">
              {#each Array(11) as __}
                <td><span class="skeleton-block skeleton-line"></span></td>
              {/each}
            </tr>
          {/each}
        {:else if listError}
          <tr><td colspan="11" class="table-state table-state-error"><span role="alert">{listError}</span></td></tr>
        {:else if requests.length === 0}
          <tr><td colspan="11" class="table-state">No requests match these filters.</td></tr>
        {:else}
          {#each requests as req (req.id)}
            <tr tabindex="0" style="cursor:pointer;" onclick={() => openDetail(req.id)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(req.id); } }}>
              <td class="timestamp">{fmtTime(req.timestamp)}</td>
              <td class="primary-cell">{req.name || req.apiKey || "Unknown"}</td>
              <td class="secondary-cell">{req.model || "Unknown"}</td>
              <td class="secondary-cell">{req.endpointName ?? "—"}</td>
              <td class="numeric-cell">{Number(req.inputTokens || 0).toLocaleString()}</td>
              <td class="numeric-cell">{Number(req.outputTokens || 0).toLocaleString()}</td>
              <td class="numeric-cell">{Number(req.cacheWriteTokens || 0).toLocaleString()}</td>
              <td class="numeric-cell">{Number(req.cacheReadTokens || 0).toLocaleString()}</td>
              <td class="numeric-cell">{Number(req.duration || 0).toFixed(2)}s</td>
              <td class="numeric-cell">${Number(req.estimatedCost || 0).toFixed(6)}</td>
              <td><span class="status-badge {["success","failed"].includes(req.status) ? req.status : "unknown"}">{req.status}</span></td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
  <div class="pagination">
    <span role="status" aria-live="polite">{total === 0 ? "Showing 0 requests" : `Showing ${start}–${end} of ${total.toLocaleString()}`}</span>
    <div class="pagination-actions">
      <button class="btn btn-secondary" type="button" disabled={loading || offset === 0} onclick={() => loadRequests(Math.max(0, offset - limit))}><i class="fa-solid fa-chevron-left"></i> Previous</button>
      <button class="btn btn-secondary" type="button" disabled={loading || offset + limit >= total} onclick={() => loadRequests(offset + limit)}>Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>
  </div>
</section>

<!-- Detail drawer -->
<div class="detail-backdrop" class:open={detailOpen} onclick={(e) => { if (e.target === e.currentTarget) closeDetail(); }} onkeydown={(e) => { if (e.key === "Escape") closeDetail(); }} role="dialog" aria-modal="true" aria-label="Request detail" tabindex="-1">
  <article class="detail-panel">
    <header class="detail-header">
      <div class="detail-heading">
        <h2>{detail ? `Request #${detail.id}` : "Loading…"}</h2>
        <p>{detail?.requestId ?? detail?.model ?? ""}</p>
      </div>
      <button class="icon-button" type="button" onclick={closeDetail} aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <div class="detail-body">

    {#if detailLoading}
      <div class="loading"><div class="loading-spinner"></div><span>Loading…</span></div>
    {:else if detailError}
      <div class="page-error">{detailError}</div>
    {:else if detail}
      {@const r = detail}
      {@const routing = r.routing ?? {}}
      {@const outcome = r.outcome ?? {}}
      {@const billing = r.billing ?? {}}
      {@const rates = billing.pricing_per_million ?? {}}
      {@const costs = billing.costs ?? {}}

      <div class="detail-section">
        <h3>Request</h3>
        <div class="detail-grid">
          {#each [["Request ID", r.requestId], ["Timestamp", fmtTime(r.timestamp)], ["Caller", r.name], ["Caller key", r.apiKey], ["Client IP", r.request?.clientIp], ["Protocol", r.request?.protocol], ["Method and path", [r.request?.method, r.request?.path].filter(Boolean).join(" ")], ["Streaming", r.request?.streaming == null ? null : r.request.streaming ? "Yes" : "No"]] as [label, value]}
            <div class="detail-field"><span class="detail-label">{label}</span><span class="detail-value">{value ?? "Not available"}</span></div>
          {/each}
        </div>
      </div>

      <div class="detail-section">
        <h3>Routing</h3>
        <div class="detail-grid">
          {#each [["Requested model", routing.requestedModel], ["Target model", routing.targetModel], ["Upstream model", routing.upstreamModel], ["Endpoint", routing.endpointName], ["API format", routing.apiFormat], ["Upstream URL", routing.upstreamUrl], ["Upstream key", routing.maskedUpstreamKey], ["Attempts", routing.attemptCount]] as [label, value]}
            <div class="detail-field"><span class="detail-label">{label}</span><span class="detail-value">{value ?? "Not available"}</span></div>
          {/each}
        </div>
        <pre class="detail-pre">{routing.attempts ? JSON.stringify(routing.attempts, null, 2) : "Not available"}</pre>
      </div>

      <div class="detail-section">
        <h3>Outcome</h3>
        <div class="detail-grid">
          {#each [["Status", r.status], ["Proxy status", outcome.proxyStatus], ["Upstream status", outcome.upstreamStatus], ["Duration", `${Number(r.duration || 0).toFixed(3)}s`], ["Error", outcome.error]] as [label, value]}
            <div class="detail-field"><span class="detail-label">{label}</span><span class="detail-value">{value ?? "Not available"}</span></div>
          {/each}
        </div>
      </div>

      <div class="detail-section">
        <h3>Billing</h3>
        <div class="detail-grid">
          {#each [["Cost source", r.costSource === "recorded" ? "Recorded cost" : "Current-price estimate"], ["Accounting version", billing.accounting_version], ["Input tokens", billing.input_tokens], ["Output tokens", billing.output_tokens], ["Cache write tokens", billing.cache_write_tokens], ["Cache read tokens", billing.cache_read_tokens], ["Input rate / 1M", rates.input], ["Output rate / 1M", rates.output], ["Cache write rate / 1M", rates.cache_write], ["Cache read rate / 1M", rates.cache_read], ["Total cost", money(costs.total)]] as [label, value]}
            <div class="detail-field"><span class="detail-label">{label}</span><span class="detail-value">{value ?? "Not available"}</span></div>
          {/each}
        </div>
        <pre class="detail-pre">{[
          `Input: ${billing.input_tokens || 0} × ${rates.input ?? "current rate"} / 1,000,000 = ${money(costs.input)}`,
          `Output: ${billing.output_tokens || 0} × ${rates.output ?? "current rate"} / 1,000,000 = ${money(costs.output)}`,
          `Cache write: ${billing.cache_write_tokens || 0} × ${rates.cache_write ?? "current rate"} / 1,000,000 = ${money(costs.cache_write)}`,
          `Cache read: ${billing.cache_read_tokens || 0} × ${rates.cache_read ?? "current rate"} / 1,000,000 = ${money(costs.cache_read)}`,
          `Total: ${money(costs.total)}`,
        ].join("\n")}</pre>
      </div>

      {#if r.relatedError}
        <div class="detail-section">
          <h3>Related Error</h3>
          <p style="font-size:13px;">{r.relatedError.errorMessage || r.relatedError.errorType || "Stored upstream error"}</p>
          <a href="/admin/errors?error={r.relatedError.id}" style="font-size:13px;color:var(--primary-dark);">View error →</a>
        </div>
      {/if}
    {/if}
    </div>
  </article>
</div>

<style>
  .toolbar { display: flex; align-items: end; justify-content: space-between; gap: 20px; padding: 18px; margin-bottom: 24px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .filters { display: grid; grid-template-columns: repeat(5, minmax(140px, 220px)); gap: 12px; flex: 1; }
  .filter-field { display: flex; flex-direction: column; gap: 7px; }
  .filter-label { color: var(--text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
  .toolbar-actions { display: flex; gap: 10px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; padding: 10px 15px; border: 1px solid transparent; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 650; }
  .btn-primary { border-color: var(--primary-dark); background: var(--primary-dark); color: white; }
  .btn-secondary { border-color: var(--border-color); background: var(--bg-secondary); color: var(--primary-dark); }
  .btn:disabled { cursor: not-allowed; opacity: .45; }
  .logs-card { overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .card-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 19px 22px; border-bottom: 1px solid var(--border-color); }
  .card-title { display: flex; align-items: center; gap: 10px; color: var(--text-primary); font-family: Georgia, "Times New Roman", serif; font-size: 17px; font-weight: 500; }
  .card-title i { color: var(--primary); }
  .count-pill { padding: 5px 10px; border-radius: 999px; background: var(--primary-light); color: var(--primary-dark); font-size: 12px; font-weight: 700; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; min-width: 1280px; border-collapse: collapse; }
  th { padding: 13px 14px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 11px; font-weight: 700; letter-spacing: .5px; text-align: left; text-transform: uppercase; white-space: nowrap; }
  td { padding: 14px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 13px; }
  tbody tr { cursor: pointer; transition: background .15s ease; }
  tbody tr:hover, tbody tr:focus { background: var(--bg-tertiary); outline: none; }
  tbody tr:last-child td { border-bottom: none; }
  .table-state { padding: 32px; color: var(--text-secondary); text-align: center; }
  .table-state-error { color: var(--danger); }
  .primary-cell { max-width: 190px; overflow: hidden; color: var(--text-primary); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .secondary-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .numeric-cell, .timestamp { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .timestamp { color: var(--text-tertiary); }
  .status-badge { display: inline-flex; padding: 5px 8px; border-radius: 7px; font-size: 12px; font-weight: 700; text-transform: capitalize; }
  .status-badge.success { background: var(--success-alpha-01); color: var(--success); }
  .status-badge.failed { background: var(--danger-alpha-01); color: var(--danger); }
  .status-badge.unknown { background: var(--bg-tertiary); color: var(--text-secondary); }
  .pagination { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 20px; border-top: 1px solid var(--border-color); color: var(--text-secondary); font-size: 13px; }
  .pagination-actions { display: flex; gap: 8px; }
  .detail-backdrop { position: fixed; z-index: 1000; inset: 0; display: none; align-items: center; justify-content: center; padding: 28px; background: rgba(24,17,31,.58); backdrop-filter: blur(3px); }
  .detail-backdrop.open { display: flex; }
  .detail-panel { display: flex; flex-direction: column; width: min(1080px,100%); max-height: calc(100vh - 56px); overflow: hidden; border: 1px solid var(--border-color); border-radius: 11px; background: var(--card-bg); box-shadow: 0 24px 70px rgba(25,15,35,.24); }
  .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px 24px; border-bottom: 1px solid var(--border-color); }
  .detail-heading h2 { margin-bottom: 6px; color: var(--text-primary); font-family: Georgia, "Times New Roman", serif; font-size: 20px; font-weight: 500; }
  .detail-heading p { color: var(--text-secondary); font-size: 13px; }
  .icon-button { width: 36px; height: 36px; flex: 0 0 auto; border: 1px solid var(--border-color); border-radius: 9px; background: var(--bg-tertiary); color: var(--text-secondary); cursor: pointer; }
  .detail-body { overflow-y: auto; padding: 24px; }
  .detail-section + .detail-section { margin-top: 24px; }
  .detail-section h3 { margin-bottom: 10px; color: var(--text-primary); font-size: 14px; }
  .detail-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; }
  .detail-field { min-width: 0; padding: 13px 14px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); }
  .detail-label { display: block; margin-bottom: 6px; color: var(--text-tertiary); font-size: 10px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; }
  .detail-value { display: block; overflow-wrap: anywhere; color: var(--text-primary); font-size: 13px; font-weight: 550; }
  .detail-pre { width: 100%; max-height: 300px; overflow: auto; margin-top: 8px; padding: 15px; border: 1px solid var(--border-color); border-radius: 10px; background: #19151e; color: #eee8f3; font: 12px/1.55 "SF Mono", Monaco, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  @media (max-width: 1100px) { .toolbar { align-items: stretch; flex-direction: column; } .detail-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }
  @media (max-width: 700px) { .filters,.detail-grid { grid-template-columns: 1fr; } .toolbar-actions .btn,.pagination-actions .btn { flex: 1; } .detail-backdrop { padding: 10px; } .detail-panel { max-height: calc(100vh - 20px); } .pagination { align-items: stretch; flex-direction: column; } }
</style>
