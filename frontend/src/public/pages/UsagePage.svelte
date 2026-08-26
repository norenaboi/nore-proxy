<script lang="ts">
  interface Usage {
    name: string;
    total_requests: number;
    daily_requests: number;
    rate_limit: number;
    total_input_tokens: number;
    total_output_tokens: number;
    daily_input_tokens: number;
    daily_output_tokens: number;
    active: boolean;
  }

  let apiKey = $state("");
  let usage = $state<Usage | null>(null);
  let loading = $state(false);
  let errorMessage = $state("");

  async function checkUsage(event?: SubmitEvent): Promise<void> {
    event?.preventDefault();
    if (loading) return;
    usage = null;
    errorMessage = "";
    const key = apiKey.trim();
    if (!key) {
      errorMessage = "Error: Can't find API Key";
      return;
    }

    loading = true;
    try {
      const response = await fetch("/api/usage", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
      });
      const body = await response.json().catch(() => ({})) as { usage?: Usage; detail?: string };
      if (!response.ok) {
        if (response.status === 429) throw new Error(body.detail || "Too many requests. Please wait and try again.");
        throw new Error(body.detail || "Error: Request Denied");
      }
      if (!body.usage) throw new Error("Usage data was unavailable.");
      usage = body.usage;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Network error. Please try again.";
    } finally {
      loading = false;
    }
  }
</script>

<div class="usage-main">
<header class="usage-head">
  <div>
    <p class="eyebrow">Account usage</p>
    <h1>Review an API key.</h1>
  </div>
  <a class="back-link" href="/">← Overview</a>
</header>

<form class="input-group panel" onsubmit={checkUsage}>
  <label for="apiKey">API key</label>
  <div class="key-entry">
    <input id="apiKey" type="password" bind:value={apiKey} autocomplete="off" placeholder="sk-…" />
    <button class="usage-button" type="submit" disabled={loading}>{loading ? "Loading…" : "Reveal usage"}</button>
  </div>
</form>

{#if loading}
  <div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><p>Loading…</p></div>
{/if}
{#if errorMessage}
  <div class="usage-error" role="alert">{errorMessage}</div>
{/if}
{#if usage}
  <section class="stats-section panel">
    <div class="stats-header"><p class="eyebrow">Key summary</p><h2>Usage Statistics</h2></div>
    {#each [
      ["Name", usage.name],
      ["Daily Quota (RPD)", `${usage.daily_requests.toLocaleString()} / ${usage.rate_limit.toLocaleString()}`],
      ["Total Requests", usage.total_requests.toLocaleString()],
      ["Input Tokens (24h)", usage.daily_input_tokens.toLocaleString()],
      ["Output Tokens (24h)", usage.daily_output_tokens.toLocaleString()],
      ["Input Tokens (Total)", usage.total_input_tokens.toLocaleString()],
      ["Output Tokens (Total)", usage.total_output_tokens.toLocaleString()],
    ] as stat}
      <div class="stat-row"><span class="stat-label">{stat[0]}</span><span class="stat-value">{stat[1]}</span></div>
    {/each}
    <div class="stat-row"><span class="stat-label">Status</span><span class:active={usage.active} class:inactive={!usage.active} class="stat-value">{usage.active ? "Active" : "Inactive"}</span></div>
  </section>
{/if}
</div>

<style>
  .usage-main { max-width: 900px; margin: 0 auto; }

  .usage-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 30px;
    margin-bottom: 34px;
  }

  .input-group {
    display: block;
    padding: 24px;
    margin-bottom: 18px;
  }

  .input-group label {
    display: block;
    margin-bottom: 8px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: normal;
    text-transform: none;
  }

  .key-entry {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
  }

  .key-entry input {
    min-height: 44px;
    padding: 10px 13px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
  }

  .usage-button {
    min-height: 44px;
    padding: 9px 18px;
    border: 1px solid var(--accent-ink);
    border-radius: 8px;
    background: var(--accent-ink);
    color: var(--on-accent);
    font-weight: 700;
    cursor: pointer;
  }

  .usage-button:disabled { opacity: 0.55; cursor: wait; }

  .loading {
    padding: 24px;
    text-align: center;
  }

  .spinner {
    width: 34px;
    height: 34px;
    margin: 0 auto 10px;
  }

  .usage-error {
    margin: 18px 0;
    padding: 14px 16px;
    border: 1px solid var(--danger-line);
    border-radius: 8px;
    background: var(--danger-soft);
    color: var(--danger);
  }

  .stats-section { overflow: hidden; }
  .stats-header { padding: 22px; border-bottom: 1px solid var(--line); }
  .stats-header h2 { margin: 0; font: 500 25px/1.2 Georgia, serif; }

  .stat-row {
    display: flex;
    justify-content: space-between;
    gap: 30px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--line);
  }

  .stat-row:last-child { border: 0; }
  .stat-label { color: var(--muted); }
  .stat-value { font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat-value.active { color: var(--success); }
  .stat-value.inactive { color: var(--danger); }

  @media (max-width: 650px) {
    .usage-head { display: grid; }
    .key-entry { grid-template-columns: 1fr; }
    .stat-row { align-items: flex-start; }
  }
</style>
