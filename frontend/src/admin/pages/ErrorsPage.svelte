<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson } from "$frontend/lib/api/admin";

  interface ErrorItem {
    id: number; timestamp: string; statusCode: number | null; model: string;
    upstreamModel: string; endpointName: string; errorType: string;
    errorCode: string; errorMessage: string;
  }

  interface ErrorDetail {
    id: number; timestamp: string; requestId: string; statusCode: number | null;
    apiFormat: string; maskedApiKey: string; model: string; upstreamModel: string;
    autoModel: string; targetModel: string; endpointName: string; endpointKey: string;
    upstreamUrl: string; errorType: string; errorCode: string; errorMessage: string;
    stackTrace: string; routingAttempts: unknown; requestHeaders: unknown; responseBody: unknown;
  }

  let errors = $state<ErrorItem[]>([]);
  let detail = $state<ErrorDetail | null>(null);
  let detailOpen = $state(false);
  let detailLoading = $state(false);
  let detailError = $state("");
  let loading = $state(false);
  let listError = $state("");
  let total = $state(0);
  let offset = $state(0);
  const limit = 25;

  let modelFilter = $state("");
  let endpointFilter = $state("");
  let statusFilter = $state("");
  let keyFilter = $state("");
  let modelOptions = $state<string[]>([]);
  let endpointOptions = $state<string[]>([]);
  let statusOptions = $state<number[]>([]);
  let keyOptions = $state<string[]>([]);
  let previousBodyOverflow: string | null = null;

  function buildUrl(requestedOffset = offset) {
    const p = new URLSearchParams({ limit: String(limit), offset: String(requestedOffset) });
    if (modelFilter) p.set("model", modelFilter);
    if (endpointFilter) p.set("endpoint", endpointFilter);
    if (statusFilter) p.set("status", statusFilter);
    if (keyFilter) p.set("key", keyFilter);
    return `/api/errors?${p}`;
  }

  async function loadFilters() {
    const d = await requestAdminJson<{ models: string[]; endpoints: string[]; statuses: number[]; keys: string[] }>("/api/errors/filters");
    modelOptions = d.models ?? [];
    endpointOptions = d.endpoints ?? [];
    statusOptions = d.statuses ?? [];
    keyOptions = d.keys ?? [];
  }

  async function loadErrors(requestedOffset = offset) {
    if (loading) return;
    loading = true;
    listError = "";
    try {
      let d = await requestAdminJson<{ errors: ErrorItem[]; total: number }>(buildUrl(requestedOffset));
      let nextOffset = requestedOffset;
      const nextTotal = d.total ?? 0;
      if (nextOffset >= nextTotal && nextOffset > 0) {
        nextOffset = Math.max(0, Math.floor(Math.max(nextTotal - 1, 0) / limit) * limit);
        d = await requestAdminJson<{ errors: ErrorItem[]; total: number }>(buildUrl(nextOffset));
      }
      offset = nextOffset;
      total = d.total ?? 0;
      errors = d.errors ?? [];
    } catch (e) {
      listError = e instanceof Error ? e.message : "Could not load stored errors.";
    } finally {
      loading = false;
    }
  }

  function applyFilters() { void loadErrors(0); }

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
      const d = await requestAdminJson<{ error: ErrorDetail }>(`/api/errors/${id}`);
      detail = d.error;
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

  function statusClass(code: number | null) {
    if (!code) return "unknown";
    if (code >= 500) return "failed";
    if (code >= 400) return "error";
    return "unknown";
  }

  function fmtTime(ts: string) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
  }

  function setJson(v: unknown) {
    return v == null ? "Not available" : JSON.stringify(v, null, 2);
  }

  async function clearErrors() {
    if (total === 0) return;
    if (!confirm(`Permanently delete ${total.toLocaleString()} stored ${total === 1 ? "error" : "errors"}?`)) return;
    await requestAdminJson("/api/errors", { method: "DELETE" });
    offset = 0;
    await Promise.all([loadFilters(), loadErrors()]);
  }

  onMount(() => {
    let disposed = false;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && detailOpen) closeDetail(); };
    document.addEventListener("keydown", onKey);

    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const deepKey = params.get("key");
      const deepError = params.get("error");
      try {
        await loadFilters();
      } catch (e) {
        if (!disposed) listError = e instanceof Error ? e.message : "Could not load error filters.";
      }
      if (disposed) return;
      if (deepKey) keyFilter = deepKey;
      await loadErrors();
      if (!disposed && deepError && /^\d+$/.test(deepError)) void openDetail(Number(deepError));
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

<section class="toolbar" aria-label="Error filters">
  <div class="filters">
    <div class="filter-field"><label for="modelFilter">Model</label><select id="modelFilter" bind:value={modelFilter} onchange={applyFilters}><option value="">All models</option>{#each modelOptions as m}<option value={m}>{m}</option>{/each}</select></div>
    <div class="filter-field"><label for="endpointFilter">Endpoint</label><select id="endpointFilter" bind:value={endpointFilter} onchange={applyFilters}><option value="">All endpoints</option>{#each endpointOptions as e}<option value={e}>{e}</option>{/each}</select></div>
    <div class="filter-field"><label for="statusFilter">HTTP status</label><select id="statusFilter" bind:value={statusFilter} onchange={applyFilters}><option value="">All statuses</option>{#each statusOptions as s}<option value={String(s)}>HTTP {s}</option>{/each}</select></div>
    <div class="filter-field"><label for="keyFilter">API key</label><select id="keyFilter" bind:value={keyFilter} onchange={applyFilters}><option value="">All keys</option>{#each keyOptions as k}<option value={k}>{k}</option>{/each}</select></div>
  </div>
  <div class="toolbar-actions">
    <button class="btn btn-primary" type="button" onclick={applyFilters}><i class="fa-solid fa-filter"></i> Apply</button>
    <button class="btn btn-secondary" type="button" onclick={() => Promise.all([loadFilters(), loadErrors()])}><i class="fa-solid fa-rotate"></i> Refresh</button>
    <button class="btn btn-danger" type="button" onclick={clearErrors} disabled={total === 0}><i class="fa-solid fa-trash"></i> Clear all</button>
  </div>
</section>

<section class="errors-card">
  <div class="card-header"><div class="card-title"><i class="fa-solid fa-triangle-exclamation"></i> Upstream failures</div><span class="count-pill">{total.toLocaleString()} {total === 1 ? "error" : "errors"}</span></div>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Time</th><th>Status</th><th>Model</th><th>Upstream</th><th>Endpoint</th><th>Type</th><th>Message</th></tr></thead>
      <tbody>
        {#if loading}
          <tr><td colspan="7" class="table-state">Loading…</td></tr>
        {:else if listError}
          <tr><td colspan="7" class="table-state table-state-error"><span role="alert">{listError}</span></td></tr>
        {:else if errors.length === 0}
          <tr><td colspan="7" class="table-state">No stored errors match these filters.</td></tr>
        {:else}
          {#each errors as err}
            <tr tabindex="0" style="cursor:pointer;" onclick={() => openDetail(err.id)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(err.id); } }}>
              <td class="timestamp">{fmtTime(err.timestamp)}</td>
              <td><span class="status-badge {statusClass(err.statusCode)}">{err.statusCode ?? "N/A"}</span></td>
              <td class="primary-cell">{err.model ?? "—"}</td>
              <td class="secondary-cell">{err.upstreamModel ?? "—"}</td>
              <td class="secondary-cell">{err.endpointName ?? "—"}</td>
              <td><span class="type-label">{err.errorType || err.errorCode || "Error"}</span></td>
              <td class="message-cell">{err.errorMessage ?? "—"}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
  <div class="pagination">
    <span>{total === 0 ? "Showing 0 errors" : `Showing ${start}–${end} of ${total.toLocaleString()}`}</span>
    <div class="pagination-actions">
      <button class="btn btn-secondary" type="button" disabled={loading || offset === 0} onclick={() => loadErrors(Math.max(0, offset - limit))}><i class="fa-solid fa-chevron-left"></i> Previous</button>
      <button class="btn btn-secondary" type="button" disabled={loading || offset + limit >= total} onclick={() => loadErrors(offset + limit)}>Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>
  </div>
</section>

<!-- Detail drawer -->
<div class="detail-backdrop" class:open={detailOpen} onclick={(e) => { if (e.target === e.currentTarget) closeDetail(); }} onkeydown={(e) => { if (e.key === "Escape") closeDetail(); }} role="dialog" aria-modal="true" aria-label="Error detail" tabindex="-1">
  <article class="detail-panel">
    <header class="detail-header">
      <div class="detail-heading">
        <h2>{detail ? `${detail.errorType || "Error"} · #${detail.id}` : "Loading…"}</h2>
        <p>{detail?.errorCode || detail?.errorMessage || ""}</p>
      </div>
      <button class="icon-button" type="button" onclick={closeDetail} aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <div class="detail-body">

    {#if detailLoading}
      <div class="loading"><div class="loading-spinner"></div><span>Loading…</span></div>
    {:else if detailError}
      <div class="page-error">{detailError}</div>
    {:else if detail}
      {@const d = detail}
      <div class="detail-grid">
        {#each [["Timestamp", fmtTime(d.timestamp)], ["Request ID", d.requestId], ["HTTP status", d.statusCode ? `HTTP ${d.statusCode}` : "No response"], ["API format", d.apiFormat], ["API key (masked)", d.maskedApiKey], ["Requested model", d.model], ["Upstream model", d.upstreamModel], ["Auto model", d.autoModel], ["Target model", d.targetModel], ["Endpoint", [d.endpointName, d.endpointKey].filter(Boolean).join(" · ")], ["Upstream URL", d.upstreamUrl]] as [label, value]}
          <div class="detail-field"><span class="detail-label">{label}</span><span class="detail-value">{value || "Not available"}</span></div>
        {/each}
      </div>
      {#each [["Error message", d.errorMessage || "Not available", "fa-circle-exclamation"], ["Routing attempts", setJson(d.routingAttempts), "fa-route"], ["Request headers", setJson(d.requestHeaders), "fa-heading"], ["Response body", setJson(d.responseBody), "fa-arrow-down"], ["Stack trace", d.stackTrace || "Not available", "fa-code"]] as [label, value, icon]}
        <section class="detail-section"><h3><i class="fa-solid {icon}"></i> {label}</h3><pre class:error-message-block={label === "Error message"} class="code-block">{value}</pre></section>
      {/each}
    {/if}
    </div>
  </article>
</div>

<style>
  .toolbar { display:flex; align-items:end; justify-content:space-between; gap:20px; padding:18px; margin-bottom:24px; border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg); }
  .filters { display:grid; grid-template-columns:repeat(4,minmax(160px,220px)); gap:12px; flex:1; }
  .filter-field { display:flex; flex-direction:column; gap:7px; }
  .filter-field label { color:var(--text-secondary); font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; }
  .filter-field select { width:100%; min-height:42px; padding:9px 36px 9px 12px; border:1px solid var(--input-border); border-radius:8px; outline:none; background:var(--input-bg); color:var(--text-primary); font-family:inherit; }
  .filter-field select:focus { border-color:var(--primary); box-shadow:0 0 0 3px var(--primary-alpha-01); }
  .toolbar-actions { display:flex; gap:10px; flex-wrap:wrap; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:38px; padding:10px 15px; border:1px solid transparent; border-radius:8px; cursor:pointer; font-family:inherit; font-size:13px; font-weight:650; }
  .btn-primary { border-color:var(--primary-dark); background:var(--primary-dark); color:white; }
  .btn-secondary { border-color:var(--border-color); background:var(--bg-secondary); color:var(--primary-dark); }
  .btn-danger { border-color:var(--danger); background:var(--danger); color:white; }
  .btn:disabled { cursor:not-allowed; opacity:.45; }
  .errors-card { overflow:hidden; border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg); }
  .card-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:19px 22px; border-bottom:1px solid var(--border-color); }
  .card-title { display:flex; align-items:center; gap:10px; color:var(--text-primary); font-family:Georgia,"Times New Roman",serif; font-size:17px; font-weight:500; }
  .card-title i { color:var(--danger); }
  .count-pill { display:inline-flex; align-items:center; min-height:28px; padding:5px 10px; border-radius:999px; background:var(--primary-light); color:var(--primary-dark); font-size:12px; font-weight:700; }
  .table-scroll { overflow-x:auto; }
  table { width:100%; min-width:1050px; border-collapse:collapse; }
  th { padding:13px 16px; border-bottom:1px solid var(--border-color); color:var(--text-secondary); font-size:11px; font-weight:700; letter-spacing:.55px; text-align:left; text-transform:uppercase; white-space:nowrap; }
  td { padding:15px 16px; border-bottom:1px solid var(--border-color); color:var(--text-secondary); font-size:13px; vertical-align:middle; }
  tbody tr { cursor:pointer; transition:background .15s ease; }
  tbody tr:hover, tbody tr:focus { background:var(--bg-tertiary); outline:none; }
  tbody tr:last-child td { border-bottom:none; }
  .table-state { padding:32px; color:var(--text-secondary); text-align:center; }
  .table-state-error { color:var(--danger); }
  .timestamp { color:var(--text-tertiary); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .status-badge { display:inline-flex; align-items:center; justify-content:center; min-width:48px; padding:5px 8px; border-radius:7px; font:700 12px "SF Mono",Monaco,Consolas,monospace; }
  .status-badge.failed { background:var(--danger-alpha-01); color:var(--danger); }
  .status-badge.error { background:rgba(245,158,11,.12); color:var(--warning); }
  .status-badge.unknown { background:var(--primary-alpha-01); color:var(--primary-dark); }
  .primary-cell { max-width:190px; overflow:hidden; color:var(--text-primary); font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
  .secondary-cell { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .message-cell { max-width:340px; overflow:hidden; color:var(--text-primary); text-overflow:ellipsis; white-space:nowrap; }
  .type-label { display:inline-flex; padding:4px 8px; border:1px solid var(--border-color); border-radius:7px; background:var(--bg-tertiary); color:var(--text-secondary); font:11px "SF Mono",Monaco,Consolas,monospace; }
  .pagination { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:16px 20px; border-top:1px solid var(--border-color); color:var(--text-secondary); font-size:13px; }
  .pagination-actions { display:flex; gap:8px; }
  .detail-backdrop { position:fixed; z-index:1000; inset:0; display:none; align-items:center; justify-content:center; padding:28px; background:rgba(24,17,31,.58); backdrop-filter:blur(3px); }
  .detail-backdrop.open { display:flex; }
  .detail-panel { display:flex; flex-direction:column; width:min(1040px,100%); max-height:calc(100vh - 56px); overflow:hidden; border:1px solid var(--border-color); border-radius:11px; background:var(--card-bg); box-shadow:0 24px 70px rgba(25,15,35,.24); }
  .detail-header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding:22px 24px; border-bottom:1px solid var(--border-color); }
  .detail-heading { min-width:0; }
  .detail-heading h2 { margin-bottom:6px; color:var(--text-primary); font-family:Georgia,"Times New Roman",serif; font-size:20px; font-weight:500; }
  .detail-heading p { overflow:hidden; color:var(--text-secondary); font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
  .icon-button { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; flex:0 0 auto; border:1px solid var(--border-color); border-radius:9px; background:var(--bg-tertiary); color:var(--text-secondary); cursor:pointer; }
  .detail-body { overflow-y:auto; padding:24px; }
  .detail-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:20px; }
  .detail-field { min-width:0; padding:13px 14px; border:1px solid var(--border-color); border-radius:8px; background:var(--bg-secondary); }
  .detail-label { display:block; margin-bottom:6px; color:var(--text-tertiary); font-size:10px; font-weight:700; letter-spacing:.55px; text-transform:uppercase; }
  .detail-value { display:block; overflow-wrap:anywhere; color:var(--text-primary); font-size:13px; font-weight:550; }
  .detail-section { margin-top:16px; }
  .detail-section h3 { display:flex; align-items:center; gap:8px; margin-bottom:9px; color:var(--text-primary); font-size:13px; }
  .detail-section h3 i { color:var(--primary); }
  .code-block { width:100%; max-height:300px; overflow:auto; padding:15px; border:1px solid var(--border-color); border-radius:10px; background:#19151e; color:#eee8f3; font:12px/1.55 "SF Mono",Monaco,Consolas,monospace; white-space:pre-wrap; word-break:break-word; }
  .error-message-block { border-left:3px solid var(--danger); }
  @media (max-width:1100px) { .toolbar { align-items:stretch; flex-direction:column; } .toolbar-actions { justify-content:flex-end; } .detail-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:700px) { .filters,.detail-grid { grid-template-columns:1fr; } .toolbar-actions .btn,.pagination-actions .btn { flex:1; } .detail-backdrop { padding:10px; } .detail-panel { max-height:calc(100vh - 20px); } .pagination { align-items:stretch; flex-direction:column; } }
</style>
