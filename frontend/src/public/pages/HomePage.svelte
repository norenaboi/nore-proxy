<script lang="ts">
  import { onMount } from "svelte";
  import { requestPublicJson } from "$frontend/lib/api/public";

  interface Summary {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_api_keys?: number;
    total_models?: number;
  }

  let summary = $state<Summary>({});
  let loading = false;

  function roundedMetric(value: number | undefined, unit: number, suffix = ""): string {
    if (value == null || !Number.isFinite(value)) return "—";
    return `${(Math.ceil(value / unit) * unit).toLocaleString()}${suffix}+`;
  }

  function roundedTokens(value: number | undefined): string {
    if (value == null || !Number.isFinite(value)) return "—";
    if (value > 900_000_000_000) return `${Math.ceil(value / 1_000_000_000_000)}T+`;
    if (value > 900_000_000) return `${Math.ceil(value / 1_000_000_000)}B+`;
    return `${Math.ceil(value / 1_000_000)}M+`;
  }

  const usedTokens = $derived(
    summary.total_input_tokens == null || summary.total_output_tokens == null
      ? undefined
      : summary.total_input_tokens + summary.total_output_tokens,
  );

  async function refresh(): Promise<void> {
    if (loading || document.hidden) return;
    loading = true;
    try {
      summary = await requestPublicJson<Summary>("/api/summary", { cache: "no-store" });
    } catch {
      // Keep the public totals unavailable when the summary endpoint cannot be reached.
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

<section class="home-hero">
  <h1><strong>One API</strong><span>For All The Models You Need</span></h1>

  <div class="hero-actions">
    <a class="console-action" href="/account">Go to console <span aria-hidden="true">→</span></a>
    <a class="models-action" href="/models">Discover Models <span aria-hidden="true">→</span></a>
  </div>

  <dl class="headline-stats">
    <div>
      <dd>{roundedTokens(usedTokens)}</dd>
      <dt>Used Tokens</dt>
    </div>
    <div>
      <dd>{roundedMetric(summary.total_api_keys, 10)}</dd>
      <dt>Users</dt>
    </div>
    <div>
      <dd>{roundedMetric(summary.total_models, 10)}</dd>
      <dt>Models</dt>
    </div>
  </dl>
</section>

<style>
  .home-hero {
    display: grid;
    justify-items: center;
    width: min(1040px, 100%);
    margin: 0 auto;
    text-align: center;
  }

  .home-hero h1 {
    display: grid;
    max-width: none;
    font-family: Inter, ui-sans-serif, sans-serif;
    font-size: clamp(40px, 5vw, 62px);
    font-weight: 650;
    letter-spacing: -.045em;
    white-space: nowrap;
  }

  .home-hero h1 strong {
    font: inherit;
    margin-bottom: 5px;
    color: var(--accent-ink);
    font-size: 1.42em;
    font-weight: 800;
    letter-spacing: -.06em;
  }

  .home-hero h1 span { display: block; }

  .hero-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: min(560px, 100%);
    margin-top: 30px;
    gap: 12px;
  }

  .hero-actions a {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 46px;
    padding: 10px 18px;
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
    font-weight: 650;
    text-decoration: none;
    transition: border-color .14s, background .14s, color .14s;
  }

  .hero-actions a:hover { border-color: var(--accent-ink); background: var(--accent-soft); color: var(--accent-ink); }
  .hero-actions span { color: var(--accent-ink); }

  .headline-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    width: 100%;
    margin: clamp(54px, 7vh, 82px) 0 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }

  .headline-stats > div {
    display: flex;
    min-width: 0;
    min-height: 132px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 30px 24px;
    border-right: 1px solid var(--line);
  }

  .headline-stats > div:last-child { border-right: 0; }
  .headline-stats dd { margin: 0; color: var(--ink); font: 500 clamp(32px, 4vw, 48px)/1 Georgia, serif; letter-spacing: -.04em; }
  .headline-stats dt { margin-top: 12px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }

  @media (max-width: 760px) {
    .home-hero h1 { white-space: normal; }
    .hero-actions { grid-template-columns: 1fr; width: min(320px, 100%); margin-top: 28px; }
    .headline-stats { grid-template-columns: 1fr; margin-top: 48px; }
    .headline-stats > div { min-height: 112px; border-right: 0; border-bottom: 1px solid var(--line); }
    .headline-stats > div:last-child { border-bottom: 0; }
  }
</style>
