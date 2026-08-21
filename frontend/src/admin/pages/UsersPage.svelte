<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson, formatNumber } from "$frontend/lib/api/admin";

  interface User { id: string; name: string; api_key: string; }
  interface UserDetail {
    name: string; api_key: string;
    total_requests: number; daily_requests: number;
    total_input_tokens: number; total_output_tokens: number;
    total_cache_write_tokens: number; total_cache_read_tokens: number;
    daily_input_tokens: number; daily_output_tokens: number;
    daily_cache_write_tokens: number; daily_cache_read_tokens: number;
    total_cost: number; daily_cost: number;
    total_input_cost: number; total_output_cost: number;
    total_cache_write_cost: number; total_cache_read_cost: number;
    daily_input_cost: number; daily_output_cost: number;
    daily_cache_write_cost: number; daily_cache_read_cost: number;
    recent_requests: Array<{
      timestamp: number; model: string; input_tokens: number; output_tokens: number;
      cache_write_tokens: number; cache_read_tokens: number; total_tokens: number;
      duration: number; cost: number;
    }>;
  }

  let users = $state<User[]>([]);
  let detail = $state<UserDetail | null>(null);
  let query = $state("");
  let loading = $state(true);
  let errorMsg = $state("");

  const visible = $derived(query
    ? users.filter((u) => [u.name, u.api_key].some((v) => v.toLowerCase().includes(query.toLowerCase())))
    : users);

  async function loadUsers() {
    try {
      const d = await requestAdminJson<{ users: User[] }>("/api/users");
      users = d.users;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load API keys";
    } finally {
      loading = false;
    }
  }

  async function showDetail(keyId: string) {
    try {
      detail = await requestAdminJson<UserDetail>(`/api/users/${encodeURIComponent(keyId)}`);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load API key stats";
    }
  }

  function fmtTime(ts: number) { const d = new Date(ts * 1000); return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`; }

  onMount(loadUsers);
</script>

{#if detail}
  <div class="detail-header">
    <div>
      <h1>{detail.name}</h1>
      <div class="user-key detail-key">{detail.api_key}</div>
    </div>
    <button class="back-btn" type="button" onclick={() => detail = null}><i class="fa-solid fa-arrow-left"></i> Back to API Key Stats</button>
  </div>

  <div class="summary-cards">
    {#each [
      ["Total Requests", detail.total_requests.toLocaleString(), ""],
      ["Total Input Tokens", formatNumber(detail.total_input_tokens), `$${detail.total_input_cost.toFixed(4)}`],
      ["Total Output Tokens", formatNumber(detail.total_output_tokens), `$${detail.total_output_cost.toFixed(4)}`],
      ["Total Estimated Cost", `$${detail.total_cost.toFixed(2)}`, ""],
      ["Daily Requests", detail.daily_requests.toLocaleString(), ""],
      ["Daily Input Tokens", formatNumber(detail.daily_input_tokens), `$${detail.daily_input_cost.toFixed(4)}`],
      ["Daily Output Tokens", formatNumber(detail.daily_output_tokens), `$${detail.daily_output_cost.toFixed(4)}`],
      ["Daily Estimated Cost", `$${detail.daily_cost.toFixed(2)}`, ""],
      ["Total Cache Write", formatNumber(detail.total_cache_write_tokens || 0), `$${(detail.total_cache_write_cost || 0).toFixed(4)}`],
      ["Total Cache Read", formatNumber(detail.total_cache_read_tokens || 0), `$${(detail.total_cache_read_cost || 0).toFixed(4)}`],
      ["Daily Cache Write", formatNumber(detail.daily_cache_write_tokens || 0), `$${(detail.daily_cache_write_cost || 0).toFixed(4)}`],
      ["Daily Cache Read", formatNumber(detail.daily_cache_read_tokens || 0), `$${(detail.daily_cache_read_cost || 0).toFixed(4)}`],
    ] as metric}
      <div class="summary-card"><h3>{metric[0]}</h3><div class="value">{metric[1]}</div>{#if metric[2]}<div class="cost-caption">{metric[2]}</div>{/if}</div>
    {/each}
  </div>

  <section class="table-card">
    <div class="table-header"><h2><i class="fa-solid fa-clock-rotate-left"></i> Recent Requests</h2></div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Time</th><th>Model</th><th>Input Tokens</th><th>Output Tokens</th><th>Cache Write</th><th>Cache Read</th><th>Total Tokens</th><th>Duration</th><th>Est. Cost</th></tr></thead>
        <tbody>
          {#if detail.recent_requests.length === 0}
            <tr><td colspan="9"><div class="empty-state compact"><i class="fa-solid fa-clock-rotate-left"></i><p>No recent requests</p></div></td></tr>
          {:else}
            {#each detail.recent_requests as req}
              <tr>
                <td><span class="timestamp">{fmtTime(req.timestamp)}</span></td>
                <td><span class="model-badge">{req.model}</span></td>
                <td><span class="token-value input">{req.input_tokens.toLocaleString()}</span></td>
                <td><span class="token-value output">{req.output_tokens.toLocaleString()}</span></td>
                <td><span class="token-value">{(req.cache_write_tokens || 0).toLocaleString()}</span></td>
                <td><span class="token-value">{(req.cache_read_tokens || 0).toLocaleString()}</span></td>
                <td><span class="token-value">{req.total_tokens.toLocaleString()}</span></td>
                <td>{req.duration.toFixed(2)}s</td><td>${(req.cost || 0).toFixed(4)}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </section>
{:else}
  <div class="users-toolbar">
    <label class="user-search" for="user-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="user-search" type="search" placeholder="Search by name or API key" autocomplete="off" bind:value={query} /></label>
    <span class="search-count" aria-live="polite">{query ? `${visible.length} of ${users.length} API keys` : `${users.length} API keys`}</span>
  </div>

  {#if loading}
    <div class="users-grid skeleton" aria-hidden="true">
      {#each Array(6) as _}
        <div class="user-card">
          <div class="user-header">
            <span class="skeleton-block skeleton-avatar"></span>
            <div class="skeleton-copy">
              <span class="skeleton-block skeleton-name"></span>
              <span class="skeleton-block skeleton-key"></span>
            </div>
          </div>
        </div>
      {/each}
    </div>
    <span class="sr-only" role="status">Loading API key stats…</span>
  {:else if errorMsg}
    <div class="page-error" role="alert">{errorMsg}</div>
  {:else if visible.length === 0}
    <div class="empty-state"><i class="fa-solid {query ? 'fa-magnifying-glass' : 'fa-key'}"></i><p>{query ? "No API keys match your search" : "No API keys found"}</p></div>
  {:else}
    <div class="users-grid">
      {#each visible as user}
        <button class="user-card" type="button" onclick={() => showDetail(user.id)}>
          <div class="user-header"><div class="user-avatar">{user.name.charAt(0).toUpperCase()}</div><div class="user-info"><h3>{user.name}</h3><div class="user-key">{user.api_key}</div></div></div>
        </button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .users-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
  .user-search { display: flex; align-items: center; gap: 10px; width: min(520px, 100%); padding: 0 13px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-tertiary); }
  .user-search:focus-within { outline: 3px solid var(--focus); outline-offset: 2px; }
  .user-search input { width: 100%; padding: 11px 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); }
  .search-count { flex: 0 0 auto; color: var(--text-secondary); font-size: 12px; }
  .users-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; margin-bottom: 32px; }
  .user-card { padding: 24px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: none; cursor: pointer; text-align: left; transition: border-color .2s ease; }
  .user-card:hover { border-color: var(--primary); }
  .user-header { display: flex; align-items: center; gap: 16px; }
  .user-avatar { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 48px; height: 48px; border-radius: 50%; background: var(--gradient-primary); color: white; font-size: 20px; font-weight: 600; }
  .user-info h3 { margin: 0 0 4px; color: var(--text-primary); font-size: 18px; }
  .user-key { color: var(--text-secondary); font: 13px/1.4 monospace; overflow-wrap: anywhere; }
  .skeleton-avatar { flex-shrink: 0; width: 48px; height: 48px; border-radius: 50%; }
  .skeleton-copy { display: flex; flex: 1; flex-direction: column; gap: 9px; }
  .skeleton-name { width: min(150px, 70%); height: 18px; }
  .skeleton-key { width: min(220px, 90%); height: 13px; }
  .detail-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 32px; padding-bottom: 18px; border-bottom: 1px solid var(--border-color); }
  .detail-header h1 { margin: 0; color: var(--text-primary); font: 500 clamp(30px, 4vw, 44px)/1.08 Georgia, "Times New Roman", serif; }
  .detail-header h1::before { content: "API key stats"; display: block; margin-bottom: 8px; color: var(--primary-dark); font: 800 10px/1.2 Inter, sans-serif; letter-spacing: .12em; text-transform: uppercase; }
  .detail-key { margin-top: 8px; }
  .back-btn { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--primary-dark); cursor: pointer; font: 14px inherit; }
  .summary-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin-bottom: 24px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .summary-card { min-height: 128px; padding: 22px; border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); background: var(--card-bg); }
  .summary-card:nth-child(4n) { border-right: 0; } .summary-card:nth-last-child(-n + 4) { border-bottom: 0; }
  .summary-card h3 { margin: 0 0 8px; color: var(--text-secondary); font-size: 13px; letter-spacing: .05em; text-transform: uppercase; }
  .summary-card .value { color: var(--text-primary); font: 500 28px/1 Georgia, "Times New Roman", serif; font-variant-numeric: tabular-nums; }
  .cost-caption { margin-top: 7px; color: var(--text-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
  .table-card { overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .table-header { padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .table-header h2 { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--text-primary); font: 500 18px Georgia, "Times New Roman", serif; }
  .table-header h2 i { color: var(--primary-dark); }
  .table-scroll { overflow-x: auto; } table { width: 100%; min-width: 1000px; border-collapse: collapse; }
  th { padding: 14px 20px; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-secondary); text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  td { padding: 16px 20px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 14px; } tbody tr:last-child td { border-bottom: 0; } tbody tr:hover { background: var(--bg-secondary); }
  .model-badge { display: inline-block; padding: 4px 12px; border-radius: 6px; background: var(--violet-lighter); color: var(--violet); font-size: 12px; font-weight: 500; }
  .timestamp { color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
  .token-value { font: 600 14px monospace; font-variant-numeric: tabular-nums; } .token-value.input { color: var(--primary); } .token-value.output { color: var(--success); }
  .empty-state.compact { padding: 32px; }
  @media (max-width: 1050px) { .summary-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .summary-card:nth-child(4n) { border-right: 1px solid var(--border-color); } .summary-card:nth-child(2n) { border-right: 0; } .summary-card:nth-last-child(-n + 4) { border-bottom: 1px solid var(--border-color); } .summary-card:nth-last-child(-n + 2) { border-bottom: 0; } }
  @media (max-width: 768px) { .users-toolbar, .detail-header { align-items: stretch; flex-direction: column; } .users-grid { grid-template-columns: 1fr; } .back-btn { align-self: flex-start; } }
  @media (max-width: 520px) { .summary-cards { grid-template-columns: 1fr; } .summary-card, .summary-card:nth-child(2n), .summary-card:nth-child(4n) { border-right: 0; border-bottom: 1px solid var(--border-color); } .summary-card:last-child { border-bottom: 0; } }
</style>
