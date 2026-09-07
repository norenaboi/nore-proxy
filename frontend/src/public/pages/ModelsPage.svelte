<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { ModelModality, PublicModelsResponse } from "$contracts/models";
  import ModalityToggle from "$frontend/components/ModalityToggle.svelte";
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

  type SortMode = "name" | "price" | "type";

  const SORT_OPTIONS: ReadonlyArray<{ value: SortMode; label: string; hint: string }> = [
    { value: "name", label: "Name", hint: "A → Z" },
    { value: "price", label: "Price", hint: "Low → high" },
    { value: "type", label: "Type", hint: "By provider" },
  ];

  let models: CatalogModel[] = [];
  let searchQuery = "";
  let activeProvider: Provider | null = null;
  let sortMode: SortMode = "name";
  let sortOpen = false;
  let modalityFilter: ModelModality | null = null;
  let loading = true;
  let errorMessage = "";
  let copied = false;
  let searchInput: HTMLInputElement;
  let sortWrapper: HTMLDivElement;
  let sortTrigger: HTMLButtonElement;
  let sortOptionButtons: HTMLButtonElement[] = [];
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  $: providerCounts = models.reduce(
    (counts, model) => counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1),
    new Map<Provider, number>(),
  );
  $: providers = [...providerCounts.keys()].sort();
  $: modalityCounts = models.reduce(
    (counts, model) => {
      counts[model.modality] = (counts[model.modality] ?? 0) + 1;
      return counts;
    },
    { text: 0, image: 0, embedding: 0 } as Record<ModelModality, number>,
  );
  $: normalizedQuery = searchQuery.trim().toLowerCase();
  $: filteredModels = models
    .filter(
      (model) =>
        (activeProvider === null || model.provider === activeProvider) &&
        (modalityFilter === null || model.modality === modalityFilter) &&
        (!normalizedQuery ||
          model.id.toLowerCase().includes(normalizedQuery) ||
          model.provider.toLowerCase().includes(normalizedQuery)),
    )
    .sort((left, right) => compareModels(left, right, sortMode));

  // Price sorts on input plus output, the two rates every request pays; the
  // cache rates only apply to models that support caching, so folding them in
  // would rank a cheap uncached model below an expensive cached one.
  function compareModels(left: CatalogModel, right: CatalogModel, mode: SortMode): number {
    if (mode === "price") {
      const total = (model: CatalogModel) => model.pricing.input + model.pricing.output;
      const byPrice = total(left) - total(right);
      if (byPrice !== 0) return byPrice;
    } else if (mode === "type") {
      const byProvider = left.provider.localeCompare(right.provider);
      if (byProvider !== 0) return byProvider;
    }
    return left.id.localeCompare(right.id);
  }

  // The provider chips are single-select: picking one replaces whatever was
  // active, and picking the active one again clears back to every provider.
  function toggleFilter(provider: Provider): void {
    activeProvider = activeProvider === provider ? null : provider;
  }

  $: activeSort = SORT_OPTIONS.find((option) => option.value === sortMode) ?? SORT_OPTIONS[0];

  /**
   * The sort menu is a listbox rather than a <select> because a native option
   * list cannot be styled. That trade means the keyboard contract is ours to
   * honour: the arrows move between options and wrap, Escape and Tab close, and
   * focus lands on the current choice when the menu opens.
   */
  function openSort(focusIndex: number): void {
    sortOpen = true;
    void tick().then(() => sortOptionButtons[focusIndex]?.focus());
  }

  function closeSort({ restoreFocus = false } = {}): void {
    if (!sortOpen) return;
    sortOpen = false;
    if (restoreFocus) sortTrigger?.focus();
  }

  function toggleSort(): void {
    if (sortOpen) closeSort({ restoreFocus: true });
    else openSort(Math.max(SORT_OPTIONS.findIndex((option) => option.value === sortMode), 0));
  }

  function chooseSort(value: SortMode): void {
    sortMode = value;
    closeSort({ restoreFocus: true });
  }

  function handleSortTriggerKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openSort(event.key === "ArrowDown" ? 0 : SORT_OPTIONS.length - 1);
  }

  function handleSortOptionKeydown(event: KeyboardEvent, index: number): void {
    const last = SORT_OPTIONS.length - 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      sortOptionButtons[index === last ? 0 : index + 1]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      sortOptionButtons[index === 0 ? last : index - 1]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      sortOptionButtons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      sortOptionButtons[last]?.focus();
    } else if (event.key === "Tab") {
      closeSort();
    }
  }

  function handleDocumentPointerDown(event: PointerEvent): void {
    if (!sortOpen || sortWrapper?.contains(event.target as Node)) return;
    closeSort();
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
    if (event.key === "Escape" && sortOpen) {
      closeSort({ restoreFocus: true });
      return;
    }
    // The "/" shortcut yields while the sort menu is open, so typing inside an
    // open menu never yanks focus out to the search field.
    if (event.key === "/" && !sortOpen && document.activeElement !== searchInput) {
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
    document.addEventListener("pointerdown", handleDocumentPointerDown);

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
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      if (copyTimer) clearTimeout(copyTimer);
    };
  });
</script>

<header class="catalog-head">
  <div>
    <p class="eyebrow">Model catalog</p>
    <h1>Available models</h1>
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
  <div class="chips-row">
    <div class="chips" aria-label="Filter by provider">
      {#each providers as provider}
        <button
          class:active={activeProvider === provider}
          class="chip"
          type="button"
          aria-pressed={activeProvider === provider}
          onclick={() => toggleFilter(provider)}
        >
          <img src={getProviderIcon(provider)} class="chip-icon" alt="" loading="lazy" onerror={hideBrokenImage} />
          {provider} <span class="count">{providerCounts.get(provider)}</span>
        </button>
      {/each}
    </div>
    <div class="chips-end">
      <div bind:this={sortWrapper} class="sort-control">
        <button
          bind:this={sortTrigger}
          class:open={sortOpen}
          class="sort-trigger"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={sortOpen}
          aria-label={`Sort models by ${activeSort.label}`}
          onclick={toggleSort}
          onkeydown={handleSortTriggerKeydown}
        >
          <span class="sort-label">Sort</span>
          <span class="sort-value">{activeSort.label}</span>
          <svg class="sort-caret" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m5.8 8.2 4.2 4.2 4.2-4.2" />
          </svg>
        </button>
        {#if sortOpen}
          <div class="sort-menu" role="listbox" aria-label="Sort models" tabindex="-1">
            {#each SORT_OPTIONS as option, index (option.value)}
              <button
                bind:this={sortOptionButtons[index]}
                class:selected={sortMode === option.value}
                class="sort-option"
                type="button"
                role="option"
                aria-selected={sortMode === option.value}
                onclick={() => chooseSort(option.value)}
                onkeydown={(event) => handleSortOptionKeydown(event, index)}
              >
                <span class="sort-option-icon" aria-hidden="true">
                  {#if option.value === "name"}
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                      <path d="M4.4 5.6h11.2M4.4 10h7.4M4.4 14.4h4" />
                    </svg>
                  {:else if option.value === "price"}
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M10 3.6v12.8" />
                      <path d="M13 6.9a2.7 2.7 0 0 0-2.6-1.6H9.2a2.3 2.3 0 0 0-.3 4.6h2.2a2.3 2.3 0 0 1-.3 4.6H9.6A2.7 2.7 0 0 1 7 12.9" />
                    </svg>
                  {:else}
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">
                      <rect x="3.9" y="3.9" width="5.4" height="5.4" rx="1.5" />
                      <rect x="10.7" y="3.9" width="5.4" height="5.4" rx="1.5" />
                      <rect x="3.9" y="10.7" width="5.4" height="5.4" rx="1.5" />
                      <rect x="10.7" y="10.7" width="5.4" height="5.4" rx="1.5" />
                    </svg>
                  {/if}
                </span>
                <span class="sort-option-label">{option.label}</span>
                <span class="sort-option-hint">{option.hint}</span>
                <svg class="sort-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m4.6 10.4 3.5 3.5 7.3-7.8" />
                </svg>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <ModalityToggle
        value={modalityFilter}
        onChange={(next) => (modalityFilter = next)}
        counts={modalityCounts}
        idPrefix="models-page-modality"
      />
      <p class="result-meta" aria-live="polite">{filteredModels.length} of {models.length} models</p>
    </div>
  </div>
</div>

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
  .chips-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chips-end { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-left: auto; flex-shrink: 0; }
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
  .result-meta { margin: 0; color: var(--muted); font-size: 12px; white-space: nowrap; }

  /* Sits between the provider chips and the modality toggle, and borrows the
     chip's pill shape so the three controls read as one filter row. The option
     list is a listbox rather than a <select> because browsers do not let a
     native option list carry this styling. */
  .sort-control { position: relative; flex-shrink: 0; }

  .sort-trigger {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    padding: 5px 10px 5px 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    cursor: pointer;
    transition: 0.12s;
  }

  .sort-trigger:hover { border-color: var(--accent-ink); }
  .sort-trigger:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px; }
  .sort-trigger.open { border-color: var(--accent-ink); background: var(--accent-soft); }
  .sort-label { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .sort-value { font-size: 12.5px; font-weight: 600; }
  .sort-trigger.open .sort-value { color: var(--accent-ink); }

  .sort-caret {
    width: 13px;
    height: 13px;
    color: var(--muted);
    transition: transform 0.18s ease;
  }

  .sort-trigger.open .sort-caret { color: var(--accent-ink); transform: rotate(180deg); }

  .sort-menu {
    position: absolute;
    top: calc(100% + 7px);
    right: 0;
    z-index: 40;
    display: grid;
    gap: 2px;
    min-width: 208px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: var(--shadow-md);
    animation: sort-menu-in 0.16s ease;
  }

  @keyframes sort-menu-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .sort-option {
    display: grid;
    /* The check column keeps its width whether or not the row is the current
       choice, so selecting a different option never reflows the menu. */
    grid-template-columns: auto minmax(0, 1fr) auto 14px;
    align-items: center;
    gap: 9px;
    padding: 7px 9px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .sort-option:hover { background: var(--accent-soft); color: var(--accent-ink); }
  .sort-option:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: -2px; }
  .sort-option.selected { background: var(--accent-soft); color: var(--accent-ink); }
  .sort-option-icon { display: inline-flex; color: var(--muted); }
  .sort-option-icon :global(svg) { width: 16px; height: 16px; display: block; }
  .sort-option:hover .sort-option-icon,
  .sort-option.selected .sort-option-icon { color: inherit; }
  .sort-option-label { font-size: 13px; font-weight: 600; }
  .sort-option-hint { color: var(--muted); font-size: 10.5px; white-space: nowrap; }
  .sort-option:hover .sort-option-hint,
  .sort-option.selected .sort-option-hint { color: inherit; opacity: 0.75; }
  .sort-check { width: 14px; height: 14px; opacity: 0; }
  .sort-option.selected .sort-check { opacity: 1; }

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

  @media (prefers-reduced-motion: reduce) {
    .sort-menu { animation: none; }
    .sort-caret, .sort-option { transition: none; }
  }

  @media (max-width: 850px) { .catalog-head { display: grid; } }
  @media (max-width: 700px) {
    .model-grid { grid-template-columns: 1fr; }
    .model-card .card-copy { opacity: 1; }
    .chips-end { margin-left: 0; width: 100%; justify-content: space-between; }
  }
</style>
