<script lang="ts">
  import { onMount } from "svelte";
  import type { PublicModelsResponse } from "$contracts/models";
  import { requestPublicJson } from "$frontend/lib/api/public";
  import {
    clearModelCache,
    formatModelName,
    formatPrice,
    getProviderIcon,
    normalizeModels,
    readModelCache,
    writeModelCache,
    type CatalogModel,
    type Provider,
  } from "$frontend/lib/models/catalog";

  let models: CatalogModel[] = [];
  let searchQuery = "";
  let activeFilters = new Set<Provider>();
  let loading = true;
  let errorMessage = "";
  let copied = false;
  let searchInput: HTMLInputElement;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  $: providerCounts = models.reduce(
    (counts, model) => counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1),
    new Map<Provider, number>(),
  );
  $: providers = [...providerCounts.keys()].sort();
  $: normalizedQuery = searchQuery.trim().toLowerCase();
  $: filteredModels = models.filter(
    (model) =>
      (activeFilters.size === 0 || activeFilters.has(model.provider)) &&
      (!normalizedQuery ||
        model.id.toLowerCase().includes(normalizedQuery) ||
        model.provider.toLowerCase().includes(normalizedQuery)),
  );

  function toggleFilter(provider: Provider): void {
    const next = new Set(activeFilters);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    activeFilters = next;
  }

  function clearSearch(): void {
    searchQuery = "";
    searchInput.focus();
  }

  function hideBrokenImage(event: Event): void {
    (event.currentTarget as HTMLImageElement).hidden = true;
  }

  async function copyModel(modelId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(modelId);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      errorMessage = "Could not copy the model identifier.";
    }
  }

  function handleShortcut(event: KeyboardEvent): void {
    if (event.key === "/" && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    }
  }

  function handleCardClick(event: MouseEvent, modelId: string): void {
    if ((event.target as HTMLElement).closest("button")) return;
    void copyModel(modelId);
  }

  function handleCardKeydown(event: KeyboardEvent, modelId: string): void {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    void copyModel(modelId);
  }

  function handleCopyClick(event: MouseEvent, modelId: string): void {
    event.stopPropagation();
    void copyModel(modelId);
  }

  onMount(() => {
    const controller = new AbortController();
    const cachedModels = readModelCache(localStorage);
    if (cachedModels) {
      models = cachedModels;
      loading = false;
    }

    window.addEventListener("keydown", handleShortcut);

    void requestPublicJson<PublicModelsResponse>("/v1/models", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        const freshModels = normalizeModels(response);
        if (freshModels.length === 0) {
          models = [];
          errorMessage = "No models are currently available.";
          try {
            clearModelCache(localStorage);
          } catch {
            // The empty server response remains authoritative in memory.
          }
          return;
        }
        models = freshModels;
        errorMessage = "";
        try {
          writeModelCache(localStorage, freshModels);
        } catch {
          // The catalog remains usable when storage is unavailable.
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !cachedModels) {
          errorMessage = error instanceof Error ? error.message : "Failed to load models.";
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });

    return () => {
      controller.abort();
      window.removeEventListener("keydown", handleShortcut);
      if (copyTimer) clearTimeout(copyTimer);
    };
  });
</script>

<header class="catalog-head">
  <div>
    <p class="eyebrow">Model catalog</p>
    <h1>Available models</h1>
    <p class="lead">Search the catalog, filter by provider, and copy any exact identifier.</p>
  </div>
  <a class="back-link" href="/">← Overview</a>
</header>

<div class="toolbar">
  <div class:has-value={searchQuery.length > 0} class="search-wrap">
    <span class="search-icon" aria-hidden="true">⌕</span>
    <input
      bind:this={searchInput}
      bind:value={searchQuery}
      class="search-input"
      type="search"
      placeholder="Search models… ( / )"
      autocomplete="off"
      aria-label="Search models"
    />
    <button class="search-clear" type="button" onclick={clearSearch}>Clear</button>
  </div>
  <div class="chips" aria-label="Filter by provider">
    {#each providers as provider}
      <button
        class:active={activeFilters.has(provider)}
        class="chip"
        type="button"
        aria-pressed={activeFilters.has(provider)}
        onclick={() => toggleFilter(provider)}
      >
        <img src={getProviderIcon(provider)} class="chip-icon" alt="" loading="lazy" onerror={hideBrokenImage} />
        {provider} <span class="count">{providerCounts.get(provider)}</span>
      </button>
    {/each}
  </div>
</div>

<p class="result-meta" aria-live="polite">{filteredModels.length} of {models.length} models</p>

<div class="model-grid">
  {#if loading}
    <div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><p>Loading models…</p></div>
  {:else if errorMessage && models.length === 0}
    <div class="no-results" role="alert"><p>{errorMessage}</p></div>
  {:else if filteredModels.length === 0}
    <div class="no-results">
      <p>No models match {normalizedQuery ? searchQuery.trim() : "your filters"}.</p>
    </div>
  {:else}
    {#each filteredModels as model (model.id)}
      <div
        class="model-card panel"
        tabindex="0"
        role="button"
        aria-label={`Copy ${model.id}`}
        onclick={(event) => handleCardClick(event, model.id)}
        onkeydown={(event) => handleCardKeydown(event, model.id)}
      >
        <div class="card-top">
          <img src={getProviderIcon(model.provider)} class="model-icon" alt="" loading="lazy" onerror={hideBrokenImage} />
          <div class="card-id">
            <span class="model-name" title={model.id}>{formatModelName(model.id)}</span>
            <span class="provider">{model.provider}</span>
          </div>
        </div>
        <button class="card-copy" type="button" aria-label={`Copy ${model.id}`} onclick={(event) => handleCopyClick(event, model.id)}>Copy</button>
        <div class="price-grid">
          {#each [["Input", model.pricing.input], ["Output", model.pricing.output], ["Cache Write", model.pricing.cache_write], ["Cache Read", model.pricing.cache_read]] as [label, value]}
            <div class="price-item">
              <span class="label">{label}</span>
              <span class="value">{formatPrice(Number(value))} <small>/M</small></span>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>

<div class:show={copied} class="copy-notification" role="status" aria-live="polite">Copied to clipboard</div>

<style>
  .catalog-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 32px;
    margin-bottom: 26px;
  }

  .catalog-head .lead { max-width: 760px; margin-bottom: 0; }
  .back-link { white-space: nowrap; }

  .toolbar { display: grid; gap: 14px; margin-bottom: 24px; }
  .search-wrap { position: relative; max-width: 440px; }
  .search-icon {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted);
    font-size: 13px;
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 11px 64px 11px 38px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    color: var(--ink);
  }

  .search-input::placeholder { color: var(--muted); }
  .search-clear {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: none;
    padding: 4px 9px;
    border: 0;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .search-wrap.has-value .search-clear { display: block; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    font-size: 12.5px;
    cursor: pointer;
    transition: 0.12s;
  }

  .chip:hover { border-color: var(--accent-ink); color: var(--accent-ink); }
  .chip.active { border-color: var(--accent-ink); background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
  .chip .count { font-size: 11px; opacity: 0.75; }
  .chip-icon { width: 16px; height: 16px; border-radius: 4px; object-fit: contain; }
  .result-meta { margin: 0 0 14px; color: var(--muted); font-size: 12px; }

  .model-grid {
    display: grid;
    gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  }

  .model-card {
    position: relative;
    display: grid;
    gap: 14px;
    align-content: start;
    padding: 18px;
    cursor: pointer;
    transition: 0.14s;
  }

  .model-card:hover { border-color: var(--accent-ink); box-shadow: var(--shadow-sm); }
  .card-top { display: flex; align-items: center; gap: 11px; min-width: 0; padding-right: 0; }
  .model-icon { width: 34px; height: 34px; flex-shrink: 0; border-radius: 8px; object-fit: contain; }
  .card-id { min-width: 0; }
  .model-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 14.5px; }
  .provider { color: var(--muted); font-size: 12px; }

  .card-copy {
    position: absolute;
    top: 14px;
    right: 14px;
    padding: 5px 9px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--surface);
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
    opacity: 0;
    transition: 0.12s;
  }

  .model-card:hover .card-copy,
  .card-copy:focus-visible { opacity: 1; }
  .card-copy:hover { border-color: var(--accent-ink); color: var(--accent-ink); }

  .price-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
  .price-item { display: grid; gap: 1px; }
  .price-item .label { color: var(--muted); font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .price-item .value { font: 600 15px ui-monospace, monospace; }
  .price-item .value small { color: var(--muted); font-size: 10px; font-weight: 400; }
  .loading, .no-results { grid-column: 1 / -1; padding: 60px 20px; text-align: center; }
  .copy-notification { bottom: 28px; padding: 10px 18px; }

  @media (max-width: 850px) { .catalog-head { display: grid; } }
  @media (max-width: 700px) {
    .model-grid { grid-template-columns: 1fr; }
    .model-card .card-copy { opacity: 1; }
  }
</style>
