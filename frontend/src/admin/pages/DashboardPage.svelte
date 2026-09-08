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

  let data = $state<DashboardData | null>(null);
  let loading = $state(true);
  let errorMsg = $state("");
  let range = $state<DashboardRange>("24h");
  let keyQuery = $state("");

  $effect(() => {
    const unsubscribe = dashboardRange.subscribe((value) => { range = value; });
    return unsubscribe;
  });

  const rangeLabels: Record<DashboardRange, string> = {
    "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", total: "All time",
  };

  const rangeData = $derived(data?.ranges?.[range] ?? null);
  const allKeys = $derived(rangeData?.api_keys ?? []);
  const visibleKeys = $derived.by(() => {
    const needle = keyQuery.trim().toLowerCase();
    return needle ? allKeys.filter((key) => (key.name ?? "").toLowerCase().includes(needle)) : allKeys;
  });

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

  function fmt(n: number) { return Number(n || 0).toLocaleString(); }
  function cost(n: number) { return `$${Number(n || 0).toFixed(4)}`; }

  onMount(() => {
    load();
    const interval = setInterval(load, 30000);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", vis);
    };
  });
</script>

{#if loading}
  <!-- Stands in for the loaded layout below: three summary cells, four token
       cells, then the single table card. -->
  <section class="summary-strip skeleton" aria-hidden="true">
    {#each Array(3) as _}
      <article>
        <div class="skeleton-metric">
          <span class="skeleton-block skeleton-metric-label"></span>
          <span class="skeleton-block skeleton-metric-value"></span>
          <span class="skeleton-block skeleton-metric-caption"></span>
        </div>
      </article>
    {/each}
  </section>
  <section class="token-ledger skeleton" aria-hidden="true">
    {#each Array(4) as _}
      <article>
        <div class="skeleton-metric">
          <span class="skeleton-block skeleton-metric-label"></span>
          <span class="skeleton-block skeleton-metric-value"></span>
          <span class="skeleton-block skeleton-metric-caption"></span>
        </div>
      </article>
    {/each}
  </section>
  <section class="table-card usage-table-card skeleton" aria-hidden="true">
    <div class="skeleton-head">
      <span class="skeleton-block skeleton-eyebrow"></span>
      <span class="skeleton-block skeleton-heading"></span>
    </div>
    <div class="skeleton-rows">
      {#each Array(6) as _}
        <div class="skeleton-row">
          <span class="skeleton-block skeleton-cell wide"></span>
          <span class="skeleton-block skeleton-cell"></span>
          <span class="skeleton-block skeleton-cell"></span>
          <span class="skeleton-block skeleton-cell narrow"></span>
        </div>
      {/each}
    </div>
  </section>
  <span class="sr-only" role="status">Loading dashboard data…</span>
{:else if errorMsg && !data}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else if data}
  {#if !rangeData}
    <div class="page-error" role="alert">Dashboard range data unavailable. Restart the server with the matching frontend and backend update.</div>
  {:else}
    {@const rd = rangeData}
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
      <article><span>Cache write</span><strong>{fmt(rd.summary.cache_write_tokens)}</strong><small>{cost(rd.summary.cache_write_cost)}</small></article>
      <article><span>Cache read</span><strong>{fmt(rd.summary.cache_read_tokens)}</strong><small>{cost(rd.summary.cache_read_cost)}</small></article>
    </section>

    <section class="table-card usage-table-card">
      <header class="table-header">
        <div><p class="eyebrow">API keys</p><h2>API Keys Usage</h2></div>
        <div class="table-tools">
          <label class="key-search" aria-label="Search API keys">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <input type="search" bind:value={keyQuery} placeholder="Search API keys…" autocomplete="off" />
            {#if keyQuery}
              <button type="button" aria-label="Clear search" onclick={() => keyQuery = ""}><i class="fa-solid fa-xmark"></i></button>
            {/if}
          </label>
          <span class="table-meta"><strong>{rangeLabels[range]}</strong> · {keyQuery ? `${fmt(visibleKeys.length)} of ${fmt(allKeys.length)}` : fmt(allKeys.length)} keys</span>
        </div>
      </header>
      <!-- The only scroll container on the dashboard: the shell holds the page at
           viewport height, so the key list scrolls here rather than the document. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="table-scroll" role="region" tabindex="0" aria-label="API key usage table">
        <table>
          <caption class="visually-hidden">API key usage for selected period</caption>
          <thead><tr><th>Name</th><th class="numeric-cell">Requests</th><th class="numeric-cell">Input</th><th class="numeric-cell">Output</th><th class="numeric-cell">Cache Write</th><th class="numeric-cell">Cache Read</th><th class="numeric-cell">Estimated Cost</th></tr></thead>
          <tbody>
            {#each visibleKeys as key}
              <tr>
                <td><strong>{key.name}</strong></td>
                <td class="numeric-cell">{fmt(key.requests)}</td>
                <td class="numeric-cell">{fmt(key.input_tokens)}</td>
                <td class="numeric-cell">{fmt(key.output_tokens)}</td>
                <td class="numeric-cell">{fmt(key.cache_write_tokens)}</td>
                <td class="numeric-cell">{fmt(key.cache_read_tokens)}</td>
                <td class="numeric-cell">${Number(key.estimated_cost || 0).toFixed(2)}</td>
              </tr>
            {:else}
              <tr><td class="table-state" colspan="7">{allKeys.length === 0 ? "No API key usage recorded for this period." : "No API keys match your search."}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
{/if}

<style>
  .summary-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    flex: 0 0 auto;
    margin-bottom: 16px;
    overflow: hidden;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--card-bg);
  }
  .summary-strip article {
    padding: 21px 26px;
    border-right: 1px solid var(--border-color);
  }
  .summary-strip article:last-child { border-right: 0; }
  .summary-strip span,
  .token-ledger span { color: var(--text-secondary); }
  .summary-strip strong {
    display: block;
    margin: 10px 0 4px;
    font: 500 34px/1 Georgia, serif;
    font-variant-numeric: tabular-nums;
  }
  .summary-strip small,
  .token-ledger small { color: var(--text-secondary); }
  .token-ledger {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    flex: 0 0 auto;
    margin-bottom: 20px;
    border-block: 1px solid var(--border-color);
  }
  .token-ledger article { padding: 16px 22px; }
  .token-ledger strong {
    display: block;
    margin: 6px 0;
    font: 500 21px/1.2 Georgia, serif;
    font-variant-numeric: tabular-nums;
  }
  /* Column flex so the table region below the header takes whatever height the
     shell has left, and `min-height: 0` so it may also give height back rather
     than pushing the card past the viewport. */
  .usage-table-card {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 180px;
    overflow: hidden;
  }
  .table-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex: 0 0 auto;
    gap: 20px;
    padding: 20px 26px;
    border-bottom: 1px solid var(--border-color);
  }
  .table-header h2 { font: 500 23px/1.2 Georgia, serif; }
  .table-tools { display: flex; align-items: center; gap: 14px; }
  .table-meta { color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
  .table-meta strong { color: var(--primary-dark); }
  .key-search {
    display: flex;
    align-items: center;
    gap: 9px;
    width: min(300px, 42vw);
    height: 38px;
    padding: 0 12px;
    border: 1px solid var(--input-border);
    border-radius: 9px;
    background: var(--input-bg);
    color: var(--text-secondary);
    transition: border-color .2s ease, box-shadow .2s ease;
  }
  .key-search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-alpha-012); }
  .key-search input {
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
  }
  .key-search button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .key-search button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .table-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .usage-table-card table { min-width: 820px; }
  /* The header row stays readable while the body scrolls. `border-collapse:
     collapse` hands the cell border to the table, which does not travel with a
     sticky cell, so the rule is repainted as an inset shadow. */
  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--card-bg);
    box-shadow: inset 0 -1px 0 var(--border-color);
  }
  th,
  td { padding: 12px 14px; white-space: nowrap; }
  .numeric-cell { text-align: right; font-variant-numeric: tabular-nums; }
  .table-state { padding: 40px 14px; color: var(--text-secondary); text-align: center; }
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
  @media (max-width: 720px) {
    .summary-strip { grid-template-columns: 1fr; }
    .summary-strip article { border-right: 0; border-bottom: 1px solid var(--border-color); }
    .summary-strip article:last-child { border-bottom: 0; }
    .token-ledger { grid-template-columns: 1fr 1fr; }
    .table-header { display: grid; justify-items: stretch; }
    .table-tools { flex-wrap: wrap; }
    .key-search { width: 100%; }
  }
  @media (max-width: 520px) {
    .token-ledger { grid-template-columns: 1fr; }
  }
</style>
