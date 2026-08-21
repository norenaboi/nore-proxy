<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson, formatNumber } from "$frontend/lib/api/admin";

  interface StatsRow {
    name: string; requests: number; input_tokens: number; output_tokens: number;
    cache_write_tokens: number; cache_read_tokens: number; total_tokens: number;
    cost: number; errors: number;
  }
  interface ProviderStats extends StatsRow { models: StatsRow[]; }
  type SortCol = "name" | "requests" | "input_tokens" | "output_tokens" | "cache_tokens" | "total_tokens" | "cost" | "errors";

  let providers = $state<ProviderStats[]>([]);
  let loading = $state(true);
  let errorMsg = $state("");
  let selectedProvider = $state("");
  let sortCol = $state<SortCol>("total_tokens");
  let sortDir = $state<"asc" | "desc">("desc");

  const selected = $derived(providers.find((provider) => provider.name === selectedProvider));
  const models = $derived((selected?.models ?? []).map((model) => ({
    ...model,
    cache_tokens: model.cache_write_tokens + model.cache_read_tokens,
  })));
  const sortedModels = $derived([...models].sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    if (sortCol === "name") return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    return sortDir === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
  }));

  function sort(col: SortCol) {
    if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortCol = col; sortDir = "desc"; }
  }

  async function load() {
    errorMsg = "";
    const response = await requestAdminJson<{ endpoints: ProviderStats[] }>("/api/endpoint-stats");
    providers = response.endpoints;
    if (!providers.some((provider) => provider.name === selectedProvider)) selectedProvider = providers[0]?.name ?? "";
  }

  onMount(() => {
    void load().catch((error) => {
      errorMsg = error instanceof Error ? error.message : "Failed to load";
    }).finally(() => { loading = false; });
  });
</script>

{#if loading}
  <section class="stats-layout skeleton" aria-hidden="true">
    <div class="provider-panel skeleton-panel">
      <div class="panel-header"><span class="skeleton-block skeleton-heading"></span></div>
      <div class="provider-skeleton-list">{#each Array(6) as _}<div class="provider-skeleton"><span class="skeleton-block skeleton-name"></span><span class="skeleton-block skeleton-count"></span></div>{/each}</div>
    </div>
    <div class="models-panel skeleton-panel">
      <div class="panel-header"><span class="skeleton-block skeleton-heading wide"></span></div>
      <div class="skeleton-rows">{#each Array(7) as _}<div class="skeleton-row"><span class="skeleton-block skeleton-cell wide"></span><span class="skeleton-block skeleton-cell"></span><span class="skeleton-block skeleton-cell"></span></div>{/each}</div>
    </div>
  </section>
  <span class="sr-only" role="status">Loading endpoint stats…</span>
{:else if errorMsg}
  <div class="page-error" role="alert">{errorMsg}</div>
{:else if providers.length === 0}
  <div class="empty-state page-empty"><i class="fa-solid fa-diagram-project"></i><p>No provider stats available</p></div>
{:else}
  <section class="stats-layout">
    <aside class="provider-panel" aria-labelledby="providers-heading">
      <div class="panel-header"><h2 id="providers-heading"><i class="fa-solid fa-diagram-project"></i> Providers</h2></div>
      <div class="provider-list">
        {#each providers as provider (provider.name)}
          <button
            class="provider-item"
            class:selected={selectedProvider === provider.name}
            type="button"
            aria-pressed={selectedProvider === provider.name}
            onclick={() => { selectedProvider = provider.name; }}
          >
            <span class="provider-name">{provider.name}</span>
            <span class="model-count">{provider.models.length} {provider.models.length === 1 ? "model" : "models"}</span>
          </button>
        {/each}
      </div>
    </aside>

    <section class="models-panel" aria-labelledby="models-heading">
      <div class="panel-header">
        <h2 id="models-heading"><i class="fa-solid fa-cubes"></i> Models for {selected?.name}</h2>
        <span class="panel-count">{selected?.models.length ?? 0} {(selected?.models.length ?? 0) === 1 ? "model" : "models"}</span>
      </div>
      {#if sortedModels.length === 0}
        <div class="empty-state"><i class="fa-solid fa-inbox"></i><p>No model stats available for this provider</p></div>
      {:else}
        <div class="table-scroll">
          <table>
            <colgroup>
              <col class="col-model" />
              <col class="col-requests" />
              <col class="col-input" />
              <col class="col-output" />
              <col class="col-cache" />
              <col class="col-total" />
              <col class="col-cost" />
              <col class="col-errors" />
            </colgroup>
            <thead><tr>{#each ([['name','Model'],['requests','Requests'],['input_tokens','Input Tokens'],['output_tokens','Output Tokens'],['cache_tokens','Cache Tokens'],['total_tokens','Total Tokens'],['cost','Cost'],['errors','Errors']] as [SortCol,string][]) as [col,label]}<th><button class:active={sortCol === col} type="button" onclick={() => sort(col)}>{label}<span aria-hidden="true">{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ⇅'}</span></button></th>{/each}</tr></thead>
            <tbody>{#each sortedModels as model (model.name)}<tr><td class="model-name">{model.name}</td><td>{model.requests.toLocaleString()}</td><td>{formatNumber(model.input_tokens)}</td><td>{formatNumber(model.output_tokens)}</td><td title="Write: {formatNumber(model.cache_write_tokens)}, Read: {formatNumber(model.cache_read_tokens)}">{formatNumber(model.cache_tokens)}</td><td>{formatNumber(model.total_tokens)}</td><td>${model.cost.toFixed(2)}</td><td class="errors">{model.errors.toLocaleString()}</td></tr>{/each}</tbody>
          </table>
        </div>
      {/if}
    </section>
  </section>
{/if}

<style>
  .stats-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); align-items: start; gap: 20px; }
  .provider-panel, .models-panel { min-width: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .panel-header { display: flex; min-height: 65px; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--border-color); }
  .panel-header h2 { display: flex; min-width: 0; align-items: center; gap: 10px; margin: 0; color: var(--text-primary); font: 500 18px/1.25 Georgia, "Times New Roman", serif; overflow-wrap: anywhere; }
  .panel-header i { flex-shrink: 0; color: var(--primary-dark); }
  .panel-count { flex-shrink: 0; color: var(--text-secondary); font-size: 12px; }
  .provider-list { display: flex; flex-direction: column; padding: 8px; }
  .provider-item { display: grid; width: 100%; min-height: 54px; gap: 4px; padding: 10px 12px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
  .provider-item:hover { background: var(--bg-secondary); }
  .provider-item.selected { border-color: var(--primary-alpha-035); background: var(--primary-alpha-012); }
  .provider-item:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .provider-name { font-size: 14px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
  .model-count { color: var(--text-secondary); font-size: 12px; }
  .table-scroll { width: 100%; max-width: 100%; overflow: hidden; }
  table { width: 100%; min-width: 0; table-layout: fixed; border-collapse: collapse; }
  col.col-model { width: 32%; }
  col.col-requests { width: 9%; }
  col.col-input, col.col-output, col.col-cache, col.col-total { width: 11%; }
  col.col-cost { width: 8%; }
  col.col-errors { width: 7%; }
  th { overflow: hidden; padding: 14px 10px; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-secondary); text-align: left; font-size: 11px; letter-spacing: .04em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
  th button { display: inline-flex; max-width: 100%; align-items: center; overflow: hidden; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; letter-spacing: inherit; text-overflow: ellipsis; text-transform: inherit; white-space: nowrap; cursor: pointer; }
  th button span { flex-shrink: 0; opacity: .35; } th button.active span { opacity: 1; }
  td { overflow: hidden; padding: 16px 10px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font: 600 13px monospace; font-variant-numeric: tabular-nums; white-space: nowrap; text-overflow: ellipsis; }
  tbody tr:last-child td { border-bottom: 0; } tbody tr:hover { background: var(--bg-secondary); }
  .model-name { color: var(--text-primary); } .errors { color: var(--danger); }
  .empty-state { padding: 48px 24px; text-align: center; } .page-empty { border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .skeleton-panel { min-height: 390px; } .skeleton-heading { width: 110px; height: 18px; } .skeleton-heading.wide { width: 180px; }
  .provider-skeleton-list { display: grid; gap: 8px; padding: 8px; } .provider-skeleton { display: grid; gap: 7px; padding: 12px; }
  .skeleton-name { width: 72%; height: 14px; } .skeleton-count { width: 42%; height: 11px; }
  @media (max-width: 1024px) { .stats-layout { grid-template-columns: minmax(0, 1fr); } .provider-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); } }
  @media (max-width: 640px) { .provider-list { grid-template-columns: 1fr; } .panel-header { align-items: flex-start; flex-direction: column; gap: 6px; padding: 16px; } th, td { padding: 12px 14px; } }
  .provider-panel, .models-panel { box-shadow: 0 6px 18px rgba(38, 26, 48, .045); transition: border-color .2s ease, box-shadow .2s ease; }
  .provider-panel:hover, .models-panel:hover { border-color: var(--primary-alpha-035); box-shadow: 0 12px 28px rgba(38, 26, 48, .09); }
  .panel-header { background: linear-gradient(110deg, var(--card-bg), var(--bg-secondary)); }
  .panel-header i { transition: transform .2s ease, color .2s ease; }
  .provider-panel:hover .panel-header i, .models-panel:hover .panel-header i { color: var(--primary); transform: scale(1.08); }
  .panel-count { padding: 5px 9px; border: 1px solid var(--border-color); border-radius: 999px; background: var(--card-bg); font-variant-numeric: tabular-nums; }
  .provider-list { gap: 4px; }
  .provider-item { position: relative; padding-left: 16px; transition: background .18s ease, border-color .18s ease, transform .18s ease, box-shadow .18s ease; }
  .provider-item::before { position: absolute; top: 9px; bottom: 9px; left: 6px; width: 3px; border-radius: 3px; background: transparent; content: ""; transition: background .18s ease; }
  .provider-item:hover { border-color: var(--border-color); background: var(--bg-secondary); box-shadow: 0 4px 12px rgba(38, 26, 48, .07); transform: translateX(3px); }
  .provider-item.selected { background: linear-gradient(100deg, var(--primary-alpha-012), var(--card-bg)); box-shadow: inset 3px 0 0 var(--primary), 0 4px 12px var(--primary-alpha-012); }
  .provider-item.selected::before { background: var(--primary); }
  .model-count { transition: color .18s ease; }
  .provider-item:hover .model-count, .provider-item.selected .model-count { color: var(--primary-dark); }
  th button { transition: color .18s ease; }
  th button:hover, th button:focus-visible, th button.active { color: var(--primary-dark); }
  th button:focus-visible { outline: 2px solid var(--primary); outline-offset: 4px; border-radius: 3px; }
  th button span { transition: opacity .18s ease, transform .18s ease; }
  th button:hover span, th button.active span { opacity: 1; transform: translateY(-1px); }
  tbody tr { transition: background .16s ease, box-shadow .16s ease; }
  tbody tr:hover { background: linear-gradient(90deg, var(--primary-alpha-012), transparent 72%); box-shadow: inset 3px 0 0 var(--primary-alpha-035); }
  tbody tr:hover .model-name { color: var(--primary-dark); }
  .model-name { transition: color .16s ease; }
  @media (prefers-reduced-motion: reduce) { .provider-panel, .models-panel, .provider-item, .provider-item::before, .provider-item .model-count, .panel-header i, th button, th button span, tbody tr, .model-name { transition: none; } .provider-item:hover { transform: none; } }
</style>
