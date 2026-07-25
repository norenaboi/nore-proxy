<script lang="ts">
  import { onMount } from "svelte";
  import { requestPublicJson } from "$frontend/lib/api/public";

  interface Summary {
    total_api_keys?: number;
    successful?: number;
    daily_requests?: number;
    all_time_successful?: number;
    all_time_requests?: number;
    uptime?: number;
  }

  let summary = $state<Summary>({});
  let loading = false;

  function percentage(successful = 0, requests = 0): string {
    return requests > 0 ? `${((successful / requests) * 100).toFixed(1)}%` : "—";
  }

  function formatDuration(seconds = 0): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  async function refresh(): Promise<void> {
    if (loading || document.hidden) return;
    loading = true;
    try {
      summary = await requestPublicJson<Summary>("/api/summary", { cache: "no-store" });
    } catch {
      // Keep the service facts unavailable when the summary endpoint cannot be reached.
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });
</script>

<section class="intro">
  <div>
    <p class="eyebrow">Unified model access</p>
    <h1>One API for all the models you need.</h1>
    <p class="lead">A compact proxy for routing requests, tracking usage, and keeping model access in one place.</p>
  </div>
  <dl class="live-facts">
    <div><dt>Service</dt><dd><i></i>Available</dd></div>
    <div><dt>Uptime · 24h</dt><dd>{percentage(summary.successful, summary.daily_requests)}</dd></div>
    <div><dt>Uptime · all time</dt><dd>{percentage(summary.all_time_successful, summary.all_time_requests)}</dd></div>
    <div><dt>Runtime</dt><dd>{summary.uptime == null ? "—" : formatDuration(summary.uptime)}</dd></div>
    <div><dt>Users</dt><dd>{summary.total_api_keys?.toLocaleString() ?? "—"}</dd></div>
  </dl>
</section>

<section class="service-strip panel" id="connect">
  <div><span>Interface</span><strong>OpenAI</strong></div>
  <div><span>Base path</span><strong>/v1/chat/completions</strong></div>
  <div><span>Authentication</span><strong>Bearer API key</strong></div>
  <div><span>Interface</span><strong>Anthropic</strong></div>
  <div><span>Base path</span><strong>/v1/messages</strong></div>
  <div><span>Authentication</span><strong>Bearer API key</strong></div>
</section>

<section class="destinations">
  <a class="panel" href="/usage">
    <span>Account</span>
    <div><strong>Review API key usage</strong><p>Inspect quota, request totals, token volume, and key status.</p></div>
    <b>View usage →</b>
  </a>
  <a class="panel" href="/models">
    <span>Catalog</span>
    <div><strong>Browse available models</strong><p>Filter providers, compare pricing, and copy exact model identifiers.</p></div>
    <b>View models →</b>
  </a>
</section>

<style>
  .intro {
    display: grid;
    grid-template-columns: 1.35fr 0.65fr;
    gap: 80px;
    align-items: end;
    margin-bottom: 0;
  }

  .intro h1 { max-width: 700px; }
  .intro .lead { max-width: 720px; }

  .live-facts {
    margin: 0;
    border-top: 1px solid var(--line);
  }

  .live-facts div {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }

  .live-facts dt { color: var(--muted); }
  .live-facts dd { margin: 0; font-weight: 700; }
  .live-facts i {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 7px;
    border-radius: 50%;
    background: var(--success);
  }

  :global(.public-main) .service-strip {
    display: grid;
    grid-template-columns: 0.8fr 1.2fr 1fr;
    margin: 48px 0 18px;
    overflow: hidden;
  }

  .service-strip div {
    display: grid;
    gap: 5px;
    padding: 19px 22px;
    border-right: 1px solid var(--line);
    border-bottom: 0;
  }

  .service-strip div:nth-child(3n) { border-right: 0; }
  .service-strip div:nth-child(n + 4) { border-top: 1px solid var(--line); }

  .service-strip span,
  .destinations > a > span {
    color: var(--muted);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .destinations {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .destinations a {
    display: grid;
    grid-template-columns: 100px 1fr auto;
    align-items: center;
    gap: 28px;
    padding: 23px 25px;
    text-decoration: none;
    transition: border 0.2s, transform 0.2s;
  }

  .destinations a:hover {
    border-color: var(--accent-ink);
    box-shadow: none;
    transform: translateX(2px);
  }

  .destinations strong {
    display: block;
    margin-bottom: 4px;
    font: 500 24px Georgia, serif;
  }

  .destinations p { margin: 0; color: var(--muted); }
  .destinations b { color: var(--accent-ink); font-size: inherit; white-space: nowrap; }

  @media (max-width: 760px) {
    .intro { grid-template-columns: 1fr; gap: 34px; }
    :global(.public-main) .service-strip { grid-template-columns: 1fr; }
    .service-strip div,
    .service-strip div:nth-child(3n),
    .service-strip div:nth-child(n + 4) {
      border-top: 0;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
    .service-strip div:last-child { border-bottom: 0; }
    .destinations a { grid-template-columns: 1fr; }
  }
</style>
