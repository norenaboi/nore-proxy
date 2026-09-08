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

  let endpoints = $state<ProviderStats[]>([]);
  let loading = $state(true);
  let errorMsg = $state("");
  let selectedProvider = $state("");
  let providerQuery = $state("");
  let sortCol = $state<SortCol>("total_tokens");
  let sortDir = $state<"asc" | "desc">("desc");

  // Requests whose endpoint was never recorded fold into a synthetic "Unknown"
  // provider on the server. It names no endpoint anyone can act on, so it is
  // left out of the list rather than shown as a provider.
  const providers = $derived(endpoints.filter((provider) => provider.name.trim().toLowerCase() !== "unknown"));
  const visibleProviders = $derived.by(() => {
    const needle = providerQuery.trim().toLowerCase();
    return needle ? providers.filter((provider) => provider.name.toLowerCase().includes(needle)) : providers;
  });

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
    endpoints = response.endpoints;
    if (!providers.some((provider) => provider.name === selectedProvider)) selectedProvider = providers[0]?.name ?? "";
  }

  onMount(() => {
    void load().catch((error) => {
      errorMsg = error instanceof Error ? error.message : "Failed to load";
    }).finally(() => { loading = false; });
  });
</script>

{#if loading}
  <section class="stats-layout fit-fill skeleton" aria-hidden="true">
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
  <section class="stats-layout fit-fill">
    <aside class="provider-panel" aria-labelledby="providers-heading">
      <div class="panel-header"><h2 id="providers-heading"><i class="fa-solid fa-diagram-project"></i> Providers</h2></div>
      <div class="provider-search-row">
        <label class="provider-search">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
          <input type="search" placeholder="Search providers…" aria-label="Search providers" autocomplete="off" bind:value={providerQuery} />
          {#if providerQuery}<button type="button" aria-label="Clear provider search" onclick={() => { providerQuery = ""; }}><i class="fa-solid fa-xmark"></i></button>{/if}
        </label>
      </div>
      <!-- The shell holds the page at viewport height, so the provider list
           scrolls here rather than the document. -->
      <div class="provider-list">
        {#each visibleProviders as provider (provider.name)}
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
        {:else}
          <p class="list-state">No providers match your search.</p>
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
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="table-scroll" role="region" tabindex="0" aria-label="Model stats for the selected provider">
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
            <thead><tr>{#each ([['name','Model'],['requests','Requests'],['input_tokens','Input'],['output_tokens','Output'],['cache_tokens','Cache'],['total_tokens','Total Tokens'],['cost','Cost'],['errors','Errors']] as [SortCol,string][]) as [col,label]}<th><button class:active={sortCol === col} type="button" onclick={() => sort(col)}>{label}<span aria-hidden="true">{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ⇅'}</span></button></th>{/each}</tr></thead>
            <tbody>{#each sortedModels as model (model.name)}<tr><td class="model-name">{model.name}</td><td>{model.requests.toLocaleString()}</td><td>{formatNumber(model.input_tokens)}</td><td>{formatNumber(model.output_tokens)}</td><td title="Write: {formatNumber(model.cache_write_tokens)}, Read: {formatNumber(model.cache_read_tokens)}">{formatNumber(model.cache_tokens)}</td><td>{formatNumber(model.total_tokens)}</td><td>${model.cost.toFixed(2)}</td><td class="errors" class:zero={model.errors === 0}>{model.errors.toLocaleString()}</td></tr>{/each}</tbody>
          </table>
        </div>
      {/if}
    </section>
  </section>
{/if}

<style>
  /* Equal-height panel pair. `min-height: 0` on the grid and its children is
     what lets the scroll regions inside them shrink instead of growing the
     page past the height the shell allows. */
  .stats-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); align-items: stretch; gap: 20px; min-height: 0; }
  .provider-panel, .models-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .panel-header { display: flex; flex: 0 0 auto; min-height: 65px; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--border-color); }
  .panel-header h2 { display: flex; min-width: 0; align-items: center; gap: 10px; margin: 0; color: var(--text-primary); font: 500 18px/1.25 Georgia, "Times New Roman", serif; overflow-wrap: anywhere; }
  .panel-header i { flex-shrink: 0; color: var(--primary-dark); }
  .panel-count { flex-shrink: 0; color: var(--text-secondary); font-size: 12px; }
  .provider-search-row { flex: 0 0 auto; padding: 10px; border-bottom: 1px solid var(--border-color); }
  .provider-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-secondary); transition: border-color .2s ease, box-shadow .2s ease; }
  .provider-search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-alpha-012); }
  .provider-search input { width: 100%; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font-size: 13px; }
  .provider-search button { display: inline-flex; width: 22px; height: 22px; flex-shrink: 0; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); cursor: pointer; }
  .provider-search button:hover { background: var(--bg-secondary); color: var(--text-primary); }
  .provider-list { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding: 8px; overflow-y: auto; }
  .list-state { margin: 0; padding: 22px 12px; color: var(--text-secondary); font-size: 13px; text-align: center; }
  .provider-item { display: grid; width: 100%; min-height: 54px; gap: 4px; padding: 10px 12px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
  .provider-item:hover { background: var(--bg-secondary); }
  .provider-item.selected { border-color: var(--primary-alpha-035); background: var(--primary-alpha-012); }
  .provider-item:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .provider-name { font-size: 14px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
  .model-count { color: var(--text-secondary); font-size: 12px; }
  .table-scroll { width: 100%; max-width: 100%; flex: 1 1 auto; min-height: 0; overflow: auto; }
  table { width: 100%; min-width: 0; table-layout: fixed; border-collapse: collapse; }
  /* Sized so every heading fits at the panel's usual width: an overflowing
     heading in a right-aligned column would ellipsize at its start, which reads
     as a typo rather than as truncation. */
  col.col-model { width: 30%; }
  col.col-requests { width: 11%; }
  col.col-input, col.col-output, col.col-cache, col.col-cost { width: 9%; }
  col.col-total { width: 13%; }
  /* The last column carries the row's right gutter as well as its own padding. */
  col.col-errors { width: 10%; }
  /* The header row stays put while the body scrolls. `border-collapse: collapse`
     hands the cell border to the table, which does not travel with a sticky
     cell, so the rule is repainted as an inset shadow. */
  th { position: sticky; top: 0; z-index: 1; overflow: hidden; padding: 12px 12px; border-bottom: 0; background: var(--bg-secondary); box-shadow: inset 0 -1px 0 var(--border-color); color: var(--text-secondary); text-align: left; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
  th button { display: inline-flex; max-width: 100%; align-items: center; overflow: hidden; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; letter-spacing: inherit; text-overflow: ellipsis; text-transform: inherit; white-space: nowrap; cursor: pointer; }
  /* The label's trailing space is collapsed away inside the flex button, so the
     gap before the sort indicator is set here. */
  th button span { flex-shrink: 0; margin-left: 5px; opacity: .35; } th button.active span { opacity: 1; }
  td { overflow: hidden; padding: 14px 12px; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font: 600 13px monospace; font-variant-numeric: tabular-nums; white-space: nowrap; text-overflow: ellipsis; }
  /* Every column but the model is a number, so they hang off a common right
     edge and each value sits under its own heading instead of drifting toward
     the next one. */
  th:not(:first-child), td:not(:first-child) { text-align: right; }
  /* The row is flush to the panel on both sides otherwise; these inset the two
     end columns to the same gutter the panel header uses. */
  th:first-child, td:first-child { padding-left: 20px; }
  th:last-child, td:last-child { padding-right: 20px; }
  tbody tr:last-child td { border-bottom: 0; } tbody tr:hover { background: var(--bg-secondary); }
  .model-name { color: var(--text-primary); } .errors { color: var(--danger); } .errors.zero { color: var(--text-tertiary); }
  .empty-state { padding: 48px 24px; text-align: center; } .page-empty { border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .skeleton-panel { min-height: 390px; } .skeleton-heading { width: 110px; height: 18px; } .skeleton-heading.wide { width: 180px; }
  .provider-skeleton-list { display: grid; gap: 8px; padding: 8px; } .provider-skeleton { display: grid; gap: 7px; padding: 12px; }
  .skeleton-name { width: 72%; height: 14px; } .skeleton-count { width: 42%; height: 11px; }
  @media (max-width: 1024px) { .stats-layout { grid-template-columns: minmax(0, 1fr); } .provider-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); } }
  @media (max-width: 640px) { .provider-list { grid-template-columns: 1fr; } .panel-header { align-items: flex-start; flex-direction: column; gap: 6px; padding: 16px; } th, td { padding: 12px 10px; } th:first-child, td:first-child { padding-left: 16px; } th:last-child, td:last-child { padding-right: 16px; } }
  .provider-panel, .models-panel { box-shadow: 0 6px 18px rgba(38, 26, 48, .045); transition: border-color .2s ease, box-shadow .2s ease; }
  .provider-panel:hover, .models-panel:hover { border-color: var(--primary-alpha-035); box-shadow: 0 12px 28px rgba(38, 26, 48, .09); }
  .panel-header { background: linear-gradient(110deg, var(--card-bg), var(--bg-secondary)); }
  .panel-header i { transition: transform .2s ease, color .2s ease; }
  .provider-panel:hover .panel-header i, .models-panel:hover .panel-header i { color: var(--primary); transform: scale(1.08); }
  .panel-count { padding: 5px 9px; border: 1px solid var(--border-color); border-radius: 999px; background: var(--card-bg); font-variant-numeric: tabular-nums; }
  .provider-list { gap: 4px; }
  .provider-item { position: relative; flex: 0 0 auto; padding-left: 16px; transition: background .18s ease, border-color .18s ease, transform .18s ease, box-shadow .18s ease; }
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
