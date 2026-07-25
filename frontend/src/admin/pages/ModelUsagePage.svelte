<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson, formatNumber } from "$frontend/lib/api/admin";

  interface ModelUsage {
    model: string; requests: number; input_tokens: number; output_tokens: number;
    cache_write_tokens: number; cache_read_tokens: number; total_tokens: number;
    cost: number; errors: number; cache_tokens: number;
  }

  type SortCol = "model" | "requests" | "input_tokens" | "output_tokens" | "cache_tokens" | "total_tokens" | "cost" | "errors";

  let data = $state<ModelUsage[]>([]);
  let loading = $state(true);
  let errorMsg = $state("");
  let sortCol = $state<SortCol>("total_tokens");
  let sortDir = $state<"asc" | "desc">("desc");

  const sorted = $derived([...data].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    if (sortCol === "model") return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
  }));

  function sort(col: SortCol) {
    if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortCol = col; sortDir = "desc"; }
  }

  function rankClass(i: number) { return i === 0 ? "top-1" : i === 1 ? "top-2" : i === 2 ? "top-3" : "other"; }

  onMount(async () => {
    try {
      const d = await requestAdminJson<{ models: ModelUsage[] }>("/api/model-usage");
      data = d.models.map((m) => ({ ...m, cost: m.cost || 0, cache_tokens: m.cache_write_tokens + m.cache_read_tokens }));
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to load";
    } finally {
      loading = false;
    }
  });
</script>

{#if loading}
  <div class="loading"><div class="loading-spinner"></div><span>Loading model usage…</span></div>
{:else if errorMsg}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else}
  <section class="models-table-card">
    <div class="table-header"><h2><i class="fa-solid fa-chart-bar"></i> Models by Usage</h2></div>
    <div class="table-scroll">
      <table>
        <thead><tr><th class="rank-column">Rank</th>{#each ([["model","Model"],["requests","Requests"],["input_tokens","Input Tokens"],["output_tokens","Output Tokens"],["cache_tokens","Cache Tokens"],["total_tokens","Total Tokens"],["cost","Cost"],["errors","Errors"]] as [string,string][]) as [col, label]}<th class="sortable {sortCol === col ? `sorted-${sortDir}` : ''}" onclick={() => sort(col as SortCol)}>{label}</th>{/each}</tr></thead>
        <tbody>
          {#if sorted.length === 0}
            <tr><td colspan="9"><div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No model usage data available</p></div></td></tr>
          {:else}
            {#each sorted as row, i}
              <tr>
                <td><span class="rank-badge {rankClass(i)}">{i + 1}</span></td>
                <td><span class="model-name">{row.model}</span></td>
                <td><span class="metric-value requests">{row.requests.toLocaleString()}</span></td>
                <td><span class="metric-value tokens">{formatNumber(row.input_tokens)}</span></td>
                <td><span class="metric-value tokens">{formatNumber(row.output_tokens)}</span></td>
                <td title="Write: {formatNumber(row.cache_write_tokens)}, Read: {formatNumber(row.cache_read_tokens)}"><span class="metric-value tokens">{formatNumber(row.cache_tokens)}</span></td>
                <td><span class="metric-value tokens">{formatNumber(row.total_tokens)}</span></td>
                <td><span class="metric-value">${row.cost.toFixed(2)}</span></td>
                <td><span class="metric-value errors">{row.errors.toLocaleString()}</span></td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<style>
  .models-table-card { overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: none; }
  .table-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid var(--border-color); }
  .table-header h2 { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--text-primary); font: 500 18px/1.2 Georgia, "Times New Roman", serif; }
  .table-header i { color: var(--primary-dark); }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; min-width: 880px; border-collapse: collapse; }
  th { padding: 14px 20px; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-secondary); text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  th.sortable { cursor: pointer; user-select: none; } th.sortable::after { content: " ⇅"; opacity: .3; } th.sorted-asc::after { content: " ↑"; opacity: 1; } th.sorted-desc::after { content: " ↓"; opacity: 1; }
  .rank-column { width: 60px; }
  td { padding: 16px 20px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 14px; } tbody tr:last-child td { border-bottom: 0; } tbody tr:hover { background: var(--bg-secondary); }
  .rank-badge { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; font-size: 14px; font-weight: 600; }
  .rank-badge.top-1 { background: linear-gradient(135deg, #ffd700, #ffed4e); color: #000; } .rank-badge.top-2 { background: linear-gradient(135deg, #c0c0c0, #e8e8e8); color: #000; } .rank-badge.top-3 { background: linear-gradient(135deg, #cd7f32, #e8a87c); color: #000; } .rank-badge.other { background: var(--bg-secondary); color: var(--text-secondary); }
  .model-name { color: var(--text-primary); font-size: 14px; font-weight: 600; }
  .metric-value { font: 600 14px monospace; font-variant-numeric: tabular-nums; } .metric-value.requests { color: var(--primary); } .metric-value.tokens { color: var(--success); } .metric-value.errors { color: var(--danger); }
  .empty-state { padding: 48px 24px; }
  @media (max-width: 768px) { th, td { padding: 12px 16px; } }
</style>
