<script lang="ts">
  import { onMount } from "svelte";
  import { requestPublicJson } from "$frontend/lib/api/public";
  import { formatModelName, getProviderIcon, type Provider } from "$frontend/lib/models/catalog";
  import {
    groupStatusModels,
    providerCounts,
    statusTotals,
    worstStatus,
    type StatusFilter,
  } from "$frontend/lib/status";
  import type {
    PublicUptimeBucket,
    PublicUptimeResponse,
    PublicUptimeSummary,
    UptimeStatus,
  } from "$contracts/uptime";

  const WINDOWS = [
    { label: "24 hours", hours: 24, bucket: 3600 },
    { label: "7 days", hours: 24 * 7, bucket: 86400 },
    { label: "30 days", hours: 24 * 30, bucket: 86400 },
  ];
  const STATUS_LABEL: Record<UptimeStatus, string> = {
    operational: "Operational",
    minor: "Minor issues",
    degraded: "Degraded",
    major: "Major outage",
    unknown: "No data",
  };
  const BANNER_COPY: Record<UptimeStatus, string> = {
    operational: "All monitored models are serving requests normally.",
    minor: "A small share of requests is failing on some models.",
    degraded: "Some models are degraded and may fail intermittently.",
    major: "At least one model is failing a large share of requests.",
    unknown: "Waiting for the first monitoring samples.",
  };
  const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "operational", label: "Operational" },
    { value: "degraded", label: "Degraded" },
    { value: "down", label: "Down" },
  ];
  const MAX_BULLETS = 32;
  const PLACEHOLDER_TITLE = "No traffic";

  let windowHours = $state(24);
  let bucketSeconds = $state(3600);
  let data = $state<PublicUptimeResponse | null>(null);
  let loading = $state(true);
  let errorMessage = $state("");
  let searchQuery = $state("");
  let statusFilter = $state<StatusFilter>("all");
  let activeProviders = $state<Provider[]>([]);

  const models = $derived(data?.models ?? []);
  const totals = $derived(statusTotals(models));
  const counts = $derived(providerCounts(models));
  const overallStatus = $derived(worstStatus(models.map((model) => model.status)));
  const groups = $derived(
    groupStatusModels(models, {
      query: searchQuery,
      filter: statusFilter,
      providers: new Set(activeProviders),
    }),
  );
  const shownCount = $derived(groups.reduce((sum, group) => sum + group.models.length, 0));

  function toggleProvider(provider: Provider): void {
    activeProviders = activeProviders.includes(provider)
      ? activeProviders.filter((value) => value !== provider)
      : [...activeProviders, provider];
  }

  function hideBrokenImage(event: Event): void {
    (event.currentTarget as HTMLImageElement).hidden = true;
  }

  function formatRate(value: number): string {
    return `${Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)).toFixed(2)}%`;
  }

  function formatLatency(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "—";
    return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  }

  function formatBucketTime(ts: number): string {
    const date = new Date(ts * 1000);
    return bucketSeconds >= 86400
      ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)
      : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric" }).format(date);
  }

  function formatUpdated(ts: number | undefined): string {
    if (!ts) return "—";
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ts * 1000));
  }

  /**
   * Fill the selected window so quiet intervals render as gray placeholders.
   * Without this a model with sparse traffic would compress its few measured
   * buckets side by side and read as a continuous outage.
   */
  function history(model: PublicUptimeSummary): PublicUptimeBucket[] {
    const end = Math.floor((data?.generated_at ?? Date.now() / 1000) / bucketSeconds) * bucketSeconds;
    const count = Math.min(MAX_BULLETS, Math.ceil((windowHours * 3600) / bucketSeconds));
    const measured = new Map(model.series.map((bucket) => [bucket.ts, bucket]));
    return Array.from({ length: count }, (_, index) => {
      const ts = end - (count - index - 1) * bucketSeconds;
      return measured.get(ts) ?? { ts, success_rate: 0, avg_latency_ms: 0, status: "unknown" };
    });
  }

  function bucketTitle(bucket: PublicUptimeBucket): string {
    if (bucket.status === "unknown") return `${formatBucketTime(bucket.ts)} · ${PLACEHOLDER_TITLE}`;
    return `${formatBucketTime(bucket.ts)} · ${STATUS_LABEL[bucket.status]} · ${formatRate(bucket.success_rate)}`;
  }

  function selectWindow(option: { hours: number; bucket: number }): void {
    if (windowHours === option.hours && bucketSeconds === option.bucket) return;
    windowHours = option.hours;
    bucketSeconds = option.bucket;
    void load();
  }

  async function load(): Promise<void> {
    errorMessage = "";
    try {
      data = await requestPublicJson<PublicUptimeResponse>(
        `/api/public-uptime?hours=${windowHours}&bucket=${bucketSeconds}`,
        { cache: "no-store" },
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Failed to load status.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  });
</script>

<header class="status-head">
  <a class="status-brand" href="/">
    <img class="status-mark" src="/favicon.ico" alt="" />
    <strong>Nore Proxy</strong>
  </a>
  <span class="live-badge"><span class="live-dot" aria-hidden="true"></span>Live status</span>
  <h1>System Status</h1>
  <p class="status-sub">Real-time availability and performance for every model. Updated every minute.</p>
</header>

{#if loading}
  <div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><p>Loading status…</p></div>
{:else if errorMessage}
  <div class="route-error panel" role="alert">
    <strong>Status is temporarily unavailable.</strong>
    <span>{errorMessage}</span>
  </div>
{:else}
  <section class="banner panel status-{data?.available ? overallStatus : 'unknown'}" aria-live="polite">
    <span class="banner-dot" aria-hidden="true"></span>
    <div>
      <strong>{data?.available ? STATUS_LABEL[overallStatus] : "Status data unavailable"}</strong>
      <span>
        {data?.available
          ? BANNER_COPY[overallStatus]
          : "The monitoring layer is unavailable. The proxy itself may still be serving requests normally."}
      </span>
    </div>
    <span class="banner-time">Updated <time>{formatUpdated(data?.generated_at)}</time></span>
  </section>

  <div class="summary">
    <div class="summary-card panel"><span class="summary-label">Total models</span><strong>{totals.total}</strong></div>
    <div class="summary-card panel"><span class="summary-label">Operational</span><strong class="status-operational">{totals.operational}</strong></div>
    <div class="summary-card panel"><span class="summary-label">Degraded</span><strong class="status-degraded">{totals.degraded}</strong></div>
    <div class="summary-card panel"><span class="summary-label">Down / no data</span><strong class="status-major">{totals.down}</strong></div>
  </div>

  <div class="toolbar">
    <input
      bind:value={searchQuery}
      class="search-input"
      type="search"
      placeholder="Search models or providers…"
      autocomplete="off"
      aria-label="Search models"
    />

    <div class="toolbar-row">
      {#if counts.size > 1}
        <div class="chips" role="group" aria-label="Filter by provider">
          {#each [...counts] as [provider, count] (provider)}
            <button
              class:active={activeProviders.includes(provider)}
              class="chip"
              type="button"
              aria-pressed={activeProviders.includes(provider)}
              onclick={() => toggleProvider(provider)}
            >
              <img src={getProviderIcon(provider)} class="chip-icon" alt="" loading="lazy" onerror={hideBrokenImage} />
              {provider} <span class="count">{count}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="segmented" role="group" aria-label="Filter by status">
        {#each STATUS_FILTERS as option (option.value)}
          <button
            type="button"
            aria-pressed={statusFilter === option.value}
            onclick={() => (statusFilter = option.value)}
          >{option.label}</button>
        {/each}
      </div>

      <div class="segmented" role="group" aria-label="History window">
        {#each WINDOWS as option (option.hours)}
          <button
            type="button"
            aria-pressed={windowHours === option.hours}
            onclick={() => selectWindow(option)}
          >{option.label}</button>
        {/each}
      </div>
    </div>
  </div>

  {#if !data?.available}
    <div class="empty panel">
      <strong>No status history is available.</strong>
      <span>Check back shortly for the first monitoring data.</span>
    </div>
  {:else if groups.length === 0}
    <div class="empty panel">
      <strong>No models match these filters.</strong>
      <span>Clear the search or status filter to see the full list.</span>
    </div>
  {:else}
    <p class="result-meta" aria-live="polite">{shownCount} of {totals.total} models</p>

    {#each groups as group (group.provider)}
      <section class="provider-group">
        <header class="provider-head">
          <img src={getProviderIcon(group.provider)} class="provider-icon" alt="" loading="lazy" onerror={hideBrokenImage} />
          <h2>{group.provider}</h2>
          <span class="provider-count">{group.models.length} model{group.models.length === 1 ? "" : "s"}</span>
          <span class="provider-status status-{group.status}">{STATUS_LABEL[group.status]}</span>
        </header>

        <div class="model-grid">
          {#each group.models as model (model.model_name)}
            <article class="model-card panel">
              <div class="card-top">
                <span class="status-marker status-{model.status}" aria-hidden="true"></span>
                <div class="card-id">
                  <span class="model-name" title={model.model_name}>{formatModelName(model.model_name)}</span>
                  <span class="status-label status-{model.status}">{STATUS_LABEL[model.status]}</span>
                </div>
              </div>

              <div class="card-metrics">
                <div class="metric">
                  <span class="metric-label">Uptime</span>
                  <span class="metric-value">{formatRate(model.success_rate)}</span>
                </div>
                <div class="metric">
                  <span class="metric-label">Avg latency</span>
                  <span class="metric-value">{formatLatency(model.avg_latency_ms)}</span>
                </div>
              </div>

              <div class="history" aria-label={`Recent uptime history for ${model.model_name}`}>
                {#each history(model) as bucket (bucket.ts)}
                  <span
                    class="history-bullet status-{bucket.status}"
                    title={bucketTitle(bucket)}
                    aria-label={bucketTitle(bucket)}
                  ></span>
                {/each}
              </div>
            </article>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
{/if}

<footer class="status-foot">
  <span>Nore Proxy status</span>
  <a href="/">← Back to Nore Proxy</a>
</footer>

<style>
  .status-head {
    display: grid;
    justify-items: center;
    padding: 18px 0 34px;
    text-align: center;
  }
  .status-brand { display: inline-flex; align-items: center; gap: 9px; margin-bottom: 26px; text-decoration: none; }
  .status-brand strong { font: 600 17px Georgia, "Times New Roman", serif; }
  .status-mark { width: 32px; height: 32px; border-radius: 8px; object-fit: contain; }
  .live-badge {
    display: inline-flex; align-items: center; gap: 7px; margin-bottom: 14px; padding: 5px 10px;
    border: 1px solid var(--success-line); border-radius: 999px; background: var(--success-soft);
    color: var(--success); font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
  }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); }
  .status-head h1 { font-size: clamp(38px, 6vw, 58px); }
  .status-sub { max-width: 660px; margin: 14px 0 0; color: var(--muted); font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }

  .panel { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  .banner {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px;
    padding: 17px 19px; border-left: 4px solid var(--muted);
  }
  .banner > div { display: grid; gap: 2px; }
  .banner strong { font-size: 15px; }
  .banner > div span { color: var(--muted); font-size: 12.5px; }
  .banner-dot, .status-marker { flex: 0 0 auto; border-radius: 50%; background: var(--muted); }
  .banner-dot { width: 11px; height: 11px; }
  .banner-time { color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
  .banner-time time { border-bottom: 1px dashed var(--line-strong); color: var(--ink-soft); }
  .banner.status-operational { border-left-color: var(--success); }
  .banner.status-operational .banner-dot { background: var(--success); }
  .banner.status-minor, .banner.status-degraded { border-left-color: var(--warning); }
  .banner.status-minor .banner-dot, .banner.status-degraded .banner-dot { background: var(--warning); }
  .banner.status-major { border-left-color: var(--danger); }
  .banner.status-major .banner-dot { background: var(--danger); }

  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 14px 0 22px; }
  .summary-card { display: grid; gap: 5px; padding: 15px 17px; }
  .summary-label { color: var(--muted); font-size: 9.5px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  .summary-card strong { font: 600 24px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }

  .toolbar { gap: 12px; margin-bottom: 25px; }
  .search-input { max-width: none; padding: 11px 14px; }
  .toolbar-row { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
  .chips { flex: 1 1 380px; }
  .chip { min-height: 34px; }
  .segmented { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); }
  .segmented button {
    min-height: 28px; padding: 4px 9px; border: 0; border-radius: 6px; background: transparent;
    color: var(--muted); font-size: 11.5px; white-space: nowrap; cursor: pointer;
  }
  .segmented button:hover { color: var(--accent-ink); }
  .segmented button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); font-weight: 700; }
  .result-meta { margin: 0 0 18px; }

  .provider-group { margin-bottom: 30px; }
  .provider-head { display: flex; align-items: center; gap: 10px; margin-bottom: 11px; }
  .provider-icon { width: 25px; height: 25px; border-radius: 6px; object-fit: contain; }
  .provider-head h2 { margin: 0; font: 600 19px Georgia, "Times New Roman", serif; }
  .provider-count { color: var(--muted); font-size: 11px; }
  .provider-status { margin-left: auto; font-size: 11px; font-weight: 700; }
  .model-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
  .model-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px 18px; padding: 16px; }
  .card-top { display: flex; align-items: center; min-width: 0; gap: 10px; }
  .status-marker { width: 9px; height: 9px; }
  .status-marker.status-operational { background: var(--success); }
  .status-marker.status-minor, .status-marker.status-degraded { background: var(--warning); }
  .status-marker.status-major { background: var(--danger); }
  .card-id { min-width: 0; display: grid; }
  .model-name { overflow: hidden; color: var(--ink); font-size: 13.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .status-label { font-size: 10.5px; }
  .status-operational { color: var(--success); }
  .status-minor, .status-degraded { color: var(--warning); }
  .status-major { color: var(--danger); }
  .status-unknown { color: var(--muted); }
  .card-metrics { display: flex; align-items: center; gap: 20px; }
  .metric { display: grid; gap: 1px; min-width: 72px; text-align: right; }
  .metric-label { color: var(--muted); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .metric-value { color: var(--ink-soft); font: 600 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .history { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(32, minmax(2px, 1fr)); gap: 3px; min-height: 10px; }
  .history-bullet { min-width: 2px; height: 10px; border-radius: 2px; background: var(--line-strong); opacity: .55; }
  .history-bullet.status-operational { background: var(--success); opacity: 1; }
  .history-bullet.status-minor, .history-bullet.status-degraded { background: var(--warning); opacity: 1; }
  .history-bullet.status-major { background: var(--danger); opacity: 1; }

  .empty, .route-error { display: grid; gap: 4px; padding: 32px 20px; color: var(--muted); text-align: center; }
  .empty strong, .route-error strong { color: var(--ink); }
  .loading { padding: 72px 20px; }
  .status-foot { display: flex; justify-content: space-between; gap: 20px; margin-top: 45px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
  .status-foot a { color: var(--accent-ink); text-decoration: none; }

  @media (max-width: 820px) {
    .summary { grid-template-columns: repeat(2, 1fr); }
    .model-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 600px) {
    .status-head { padding-top: 8px; }
    .status-brand { margin-bottom: 20px; }
    .banner { grid-template-columns: auto 1fr; }
    .banner-time { grid-column: 2; }
    .toolbar-row { display: grid; }
    .chips { flex-basis: auto; }
    .segmented { max-width: 100%; overflow-x: auto; }
    .model-card { grid-template-columns: 1fr; }
    .card-metrics { justify-content: flex-start; padding-top: 10px; border-top: 1px solid var(--line); }
    .metric { text-align: left; }
    .history { grid-column: 1; }
  }
  @media (max-width: 390px) {
    .summary { gap: 8px; }
    .summary-card { padding: 13px; }
    .provider-status { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .live-dot { box-shadow: none; } }
</style>
