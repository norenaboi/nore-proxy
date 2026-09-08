<script lang="ts">
  import { onMount } from "svelte";
  import { HttpError, requestPublicJson } from "$frontend/lib/api/public";

  interface RangeSummary {
    requests: number; successes: number; failures: number; success_rate: number;
    input_tokens: number; output_tokens: number;
    cache_write_tokens: number; cache_read_tokens: number;
    input_cost: number; output_cost: number;
    cache_write_cost: number; cache_read_cost: number;
    estimated_cost: number;
  }

  interface AccountKey {
    name: string; api_key: string; active: boolean;
    usage_today: number; rpd: number; rpm: number; max_context_size: number;
  }

  interface AccountSummary {
    key: AccountKey;
    ranges: Record<string, RangeSummary>;
  }

  interface AccountRequest {
    id: number; timestamp: number; model: string; status: string;
    inputTokens: number; outputTokens: number;
    cacheWriteTokens: number; cacheReadTokens: number;
    duration: number; estimatedCost: number;
  }

  // Window length in seconds, null being all time — the same windows the server
  // aggregates, so a tab selects both a summary and a history filter.
  const ranges = [
    { id: "24h", label: "Last 24 hours", seconds: 86400 },
    { id: "7d", label: "Last 7 days", seconds: 604800 },
    { id: "30d", label: "Last 30 days", seconds: 2592000 },
    { id: "total", label: "All time", seconds: null },
  ] as const;

  type RangeId = (typeof ranges)[number]["id"];

  const statuses = [
    { id: "", label: "All" },
    { id: "success", label: "Successful" },
    { id: "failed", label: "Failed" },
  ] as const;

  const limit = 50;

  let summary = $state<AccountSummary | null>(null);
  let summaryError = $state("");
  let loadingSummary = $state(true);

  let requests = $state<AccountRequest[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let loadingRequests = $state(true);
  let requestsError = $state("");
  let generation = 0;

  let range = $state<RangeId>("24h");
  let statusFilter = $state("");

  const rangeLabel = $derived(ranges.find((entry) => entry.id === range)?.label ?? "");
  const rangeSummary = $derived(summary?.ranges?.[range] ?? null);
  const page = $derived(Math.floor(offset / limit) + 1);
  const pageCount = $derived(Math.max(1, Math.ceil(total / limit)));

  // An expired or revoked session is not an error the page can recover from.
  function handleFailure(error: unknown): string {
    if (error instanceof HttpError && error.status === 401) {
      window.location.href = "/login";
      return "";
    }
    return error instanceof Error ? error.message : "Something went wrong. Please try again.";
  }

  function historyQuery(requestedOffset: number): string {
    const params = new URLSearchParams({ limit: String(limit), offset: String(requestedOffset) });
    if (statusFilter) params.set("status", statusFilter);
    const seconds = ranges.find((entry) => entry.id === range)?.seconds ?? null;
    if (seconds !== null) params.set("from", String(Math.floor(Date.now() / 1000) - seconds));
    return `/api/account/requests?${params}`;
  }

  async function loadSummary(): Promise<void> {
    try {
      summary = await requestPublicJson<AccountSummary>("/api/account/summary");
      summaryError = "";
    } catch (error) {
      summaryError = handleFailure(error);
    } finally {
      loadingSummary = false;
    }
  }

  // New traffic keeps arriving, so a page that was in range when it was
  // requested can fall past the end; step back to the last populated page. A
  // filter change can also land mid-flight, so only the newest load wins.
  async function loadRequests(requestedOffset = offset): Promise<void> {
    const current = ++generation;
    loadingRequests = true;
    requestsError = "";
    try {
      let data = await requestPublicJson<{ requests: AccountRequest[]; total: number }>(
        historyQuery(requestedOffset),
      );
      if (current !== generation) return;
      let nextOffset = requestedOffset;
      const nextTotal = data.total ?? 0;
      if (nextOffset >= nextTotal && nextOffset > 0) {
        nextOffset = Math.max(0, Math.floor(Math.max(nextTotal - 1, 0) / limit) * limit);
        data = await requestPublicJson<{ requests: AccountRequest[]; total: number }>(
          historyQuery(nextOffset),
        );
        if (current !== generation) return;
      }
      offset = nextOffset;
      total = data.total ?? 0;
      requests = data.requests ?? [];
    } catch (error) {
      if (current === generation) requestsError = handleFailure(error);
    } finally {
      if (current === generation) loadingRequests = false;
    }
  }

  function selectRange(next: RangeId): void {
    if (next === range) return;
    range = next;
    void loadRequests(0);
  }

  function selectStatus(next: string): void {
    if (next === statusFilter) return;
    statusFilter = next;
    void loadRequests(0);
  }

  function goToPage(nextPage: number): void {
    const target = Math.min(Math.max(nextPage, 1), pageCount);
    void loadRequests((target - 1) * limit);
  }

  async function signOut(): Promise<void> {
    try {
      await fetch("/api/account/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      window.location.href = "/login";
    }
  }

  function fmt(value: number): string { return Number(value || 0).toLocaleString(); }
  function money(value: number, digits = 2): string { return `$${Number(value || 0).toFixed(digits)}`; }
  function when(seconds: number): string {
    const date = new Date(seconds * 1000);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  }

  onMount(() => {
    void loadSummary();
    void loadRequests(0);
    // Headline numbers refresh on their own; the history table does not, so a
    // page being read is never reshuffled underneath the reader.
    const interval = setInterval(() => { if (!document.hidden) void loadSummary(); }, 60000);
    return () => clearInterval(interval);
  });
</script>

<div class="account-main">
  <header class="account-head">
    <div>
      <p class="eyebrow">Account</p>
      <h1>{summary?.key.name ?? "Your usage"}</h1>
      {#if summary}
        <p class="key-line">
          <code>{summary.key.api_key}</code>
          <span class:active={summary.key.active} class:inactive={!summary.key.active} class="key-status">
            {summary.key.active ? "Active" : "Inactive"}
          </span>
        </p>
      {/if}
    </div>
    <button class="sign-out" type="button" onclick={signOut}>Sign out</button>
  </header>

  {#if summaryError}
    <div class="account-error" role="alert">{summaryError}</div>
  {/if}

  <div class="range-tabs" role="group" aria-label="Reporting period">
    {#each ranges as entry}
      <button
        class="chip"
        class:active={range === entry.id}
        type="button"
        aria-pressed={range === entry.id}
        onclick={() => selectRange(entry.id)}
      >{entry.label}</button>
    {/each}
  </div>

  {#if loadingSummary}
    <div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><p>Loading your usage…</p></div>
  {:else if summary && rangeSummary}
    {@const rd = rangeSummary}
    <section class="account-summary panel" aria-label="Traffic summary">
      <article>
        <span>Requests</span>
        <strong>{fmt(rd.requests)}</strong>
        <small>{rangeLabel}</small>
      </article>
      <article>
        <span>Success rate</span>
        <strong>{Number(rd.success_rate || 0).toFixed(1)}%</strong>
        <small>{fmt(rd.successes)} successful · {fmt(rd.failures)} failed</small>
      </article>
      <article>
        <span>Estimated cost</span>
        <strong>{money(rd.estimated_cost)}</strong>
        <small>Model-aware estimate</small>
      </article>
    </section>

    <section class="account-ledger panel" aria-label="Token totals">
      <article><span>Input tokens</span><strong>{fmt(rd.input_tokens)}</strong><small>{money(rd.input_cost, 4)}</small></article>
      <article><span>Output tokens</span><strong>{fmt(rd.output_tokens)}</strong><small>{money(rd.output_cost, 4)}</small></article>
      <article><span>Cache write</span><strong>{fmt(rd.cache_write_tokens)}</strong><small>{money(rd.cache_write_cost, 4)}</small></article>
      <article><span>Cache read</span><strong>{fmt(rd.cache_read_tokens)}</strong><small>{money(rd.cache_read_cost, 4)}</small></article>
    </section>

    <section class="limits-card panel" aria-label="Key limits">
      <div><span>Requests today</span><strong>{fmt(summary.key.usage_today)} / {fmt(summary.key.rpd)}</strong></div>
      <div><span>Requests per minute</span><strong>{fmt(summary.key.rpm)}</strong></div>
      <div>
        <span>Max context</span>
        <strong>{summary.key.max_context_size > 0 ? `${fmt(summary.key.max_context_size)} tokens` : "Unlimited"}</strong>
      </div>
    </section>
  {/if}

  <section class="history-card panel">
    <header class="history-head">
      <div>
        <p class="eyebrow">History</p>
        <h2>Your requests</h2>
      </div>
      <div class="history-filters" role="group" aria-label="Request status">
        {#each statuses as option}
          <button
            class="chip"
            class:active={statusFilter === option.id}
            type="button"
            aria-pressed={statusFilter === option.id}
            onclick={() => selectStatus(option.id)}
          >{option.label}</button>
        {/each}
      </div>
    </header>

    {#if requestsError}
      <div class="account-error inset" role="alert">{requestsError}</div>
    {:else if loadingRequests && requests.length === 0}
      <div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><p>Loading requests…</p></div>
    {:else}
      <div class="history-scroll" aria-busy={loadingRequests}>
        <table>
          <caption class="visually-hidden">Your requests for the selected period</caption>
          <thead>
            <tr>
              <th>Time</th>
              <th>Model</th>
              <th>Status</th>
              <th class="numeric">Input</th>
              <th class="numeric">Output</th>
              <th class="numeric">Cache W</th>
              <th class="numeric">Cache R</th>
              <th class="numeric">Duration</th>
              <th class="numeric">Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each requests as request (request.id)}
              <tr>
                <td>{when(request.timestamp)}</td>
                <td>{request.model}</td>
                <td>
                  <span class:ok={request.status === "success"} class:bad={request.status === "failed"} class="row-status">
                    {request.status}
                  </span>
                </td>
                <td class="numeric">{fmt(request.inputTokens)}</td>
                <td class="numeric">{fmt(request.outputTokens)}</td>
                <td class="numeric">{fmt(request.cacheWriteTokens)}</td>
                <td class="numeric">{fmt(request.cacheReadTokens)}</td>
                <td class="numeric">{Number(request.duration || 0).toFixed(2)}s</td>
                <td class="numeric">{money(request.estimatedCost, 6)}</td>
              </tr>
            {:else}
              <tr><td class="table-state" colspan="9">No requests recorded for this period.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <footer class="pager">
        <span class="pager-meta">{fmt(total)} requests · page {fmt(page)} of {fmt(pageCount)}</span>
        <span class="pager-controls">
          <button type="button" disabled={page <= 1 || loadingRequests} onclick={() => goToPage(page - 1)}>← Previous</button>
          <button type="button" disabled={page >= pageCount || loadingRequests} onclick={() => goToPage(page + 1)}>Next →</button>
        </span>
      </footer>
    {/if}
  </section>
</div>

<style>
  .account-main { max-width: 1080px; margin: 0 auto; width: 100%; }

  .account-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 30px;
    margin-bottom: 22px;
  }

  .account-head h1 { margin: 0; font: 500 38px/1.08 Georgia, serif; letter-spacing: -0.025em; }

  .key-line { display: flex; align-items: center; gap: 10px; margin: 12px 0 0; }
  .key-line code {
    padding: 3px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--surface);
    font-size: 12px;
  }
  .key-status { font-size: 12px; font-weight: 700; }
  .key-status.active { color: var(--success); }
  .key-status.inactive { color: var(--danger); }

  .sign-out {
    flex-shrink: 0;
    padding: 9px 16px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    font: inherit;
    cursor: pointer;
    transition: 0.14s;
  }
  .sign-out:hover { border-color: var(--accent-ink); color: var(--accent-ink); }

  .range-tabs, .history-filters { display: flex; flex-wrap: wrap; gap: 8px; }
  .range-tabs { margin-bottom: 20px; }

  .account-error {
    margin: 0 0 20px;
    padding: 14px 16px;
    border: 1px solid var(--danger-line);
    border-radius: 8px;
    background: var(--danger-soft);
    color: var(--danger);
  }
  .account-error.inset { margin: 20px; }

  .account-summary, .account-ledger {
    display: grid;
    overflow: hidden;
    margin-bottom: 16px;
  }
  .account-summary { grid-template-columns: repeat(3, 1fr); }
  .account-ledger { grid-template-columns: repeat(4, 1fr); }
  .account-summary article, .account-ledger article { padding: 20px 24px; border-right: 1px solid var(--line); }
  .account-summary article:last-child, .account-ledger article:last-child { border-right: 0; }
  .account-summary span, .account-ledger span { color: var(--muted); font-size: 12px; }
  .account-summary strong {
    display: block;
    margin: 10px 0 4px;
    font: 500 32px/1 Georgia, serif;
    font-variant-numeric: tabular-nums;
  }
  .account-ledger strong {
    display: block;
    margin: 8px 0 4px;
    font: 500 21px/1.2 Georgia, serif;
    font-variant-numeric: tabular-nums;
  }
  .account-summary small, .account-ledger small { color: var(--muted); font-size: 12px; }

  .limits-card {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    overflow: hidden;
    margin-bottom: 26px;
  }
  .limits-card div { padding: 16px 24px; border-right: 1px solid var(--line); }
  .limits-card div:last-child { border-right: 0; }
  .limits-card span { display: block; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .limits-card strong { display: block; margin-top: 6px; font-variant-numeric: tabular-nums; }

  .history-card { overflow: hidden; }
  .history-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
    padding: 20px 24px;
    border-bottom: 1px solid var(--line);
  }
  .history-head h2 { margin: 0; font: 500 24px/1.2 Georgia, serif; }

  .history-scroll { overflow-x: auto; }
  table { width: 100%; min-width: 860px; border-collapse: collapse; }
  th, td { padding: 12px 14px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .numeric { text-align: right; font-variant-numeric: tabular-nums; }
  .row-status { font-weight: 600; }
  .row-status.ok { color: var(--success); }
  .row-status.bad { color: var(--danger); }
  .table-state { padding: 40px 14px; color: var(--muted); text-align: center; white-space: normal; }

  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 24px;
  }
  .pager-meta { color: var(--muted); font-size: 12px; }
  .pager-controls { display: flex; gap: 8px; }
  .pager-controls button {
    padding: 7px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    cursor: pointer;
    transition: 0.14s;
  }
  .pager-controls button:hover:not(:disabled) { border-color: var(--accent-ink); color: var(--accent-ink); }
  .pager-controls button:disabled { opacity: .45; cursor: not-allowed; }

  .loading { padding: 56px 20px; color: var(--muted); text-align: center; }
  .loading p { margin: 10px 0 0; }

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

  @media (max-width: 860px) {
    .account-summary { grid-template-columns: 1fr; }
    .account-ledger, .limits-card { grid-template-columns: 1fr 1fr; }
    .account-summary article, .account-ledger article, .limits-card div { border-right: 0; border-bottom: 1px solid var(--line); }
    .account-summary article:last-child, .account-ledger article:last-child, .limits-card div:last-child { border-bottom: 0; }
  }

  @media (max-width: 650px) {
    .account-head { display: grid; }
    .sign-out { justify-self: start; }
    .account-ledger, .limits-card { grid-template-columns: 1fr; }
    .history-head { display: grid; }
  }
</style>
