<script lang="ts">
  import { tick } from "svelte";
  import { formatPrice, getProviderIcon, type CatalogModel, type Provider } from "$frontend/lib/models/catalog";

  let {
    models,
    selectedId,
    loading,
    errorMessage,
    onSelect,
  }: {
    models: CatalogModel[];
    selectedId: string;
    loading: boolean;
    errorMessage: string;
    onSelect: (modelId: string) => void;
  } = $props();

  let open = $state(false);
  let searchQuery = $state("");
  let activeFilters = $state(new Set<Provider>());
  let wrapper: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let searchBox: HTMLInputElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();
  let panelStyle = $state("");

  const PANEL_WIDTH = 430;
  const VIEWPORT_GUTTER = 12;

  /**
   * The chat column clips its overflow, so the panel is positioned in the
   * viewport instead of inside the column and kept clear of both edges.
   */
  function positionPanel(): void {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const left = Math.min(Math.max(rect.left, VIEWPORT_GUTTER), window.innerWidth - width - VIEWPORT_GUTTER);
    panelStyle = `top: ${rect.bottom + 6}px; left: ${left}px; width: ${width}px;`;
  }

  const providerCounts = $derived(
    models.reduce(
      (counts, model) => counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1),
      new Map<Provider, number>(),
    ),
  );
  const providers = $derived([...providerCounts.keys()].sort());
  const normalizedQuery = $derived(searchQuery.trim().toLowerCase());
  const visibleModels = $derived(
    models.filter(
      (model) =>
        (activeFilters.size === 0 || activeFilters.has(model.provider)) &&
        (!normalizedQuery ||
          model.id.toLowerCase().includes(normalizedQuery) ||
          model.provider.toLowerCase().includes(normalizedQuery)),
    ),
  );
  const selectedModel = $derived(models.find((model) => model.id === selectedId));

  function toggle(): void {
    open = !open;
    if (!open) return;
    // Filters are transient: every opening starts from the full catalog.
    searchQuery = "";
    activeFilters = new Set();
    positionPanel();
    void tick().then(() => searchBox?.focus());
  }

  function close(): void {
    if (!open) return;
    open = false;
    trigger?.focus();
  }

  function choose(modelId: string): void {
    onSelect(modelId);
    close();
  }

  function toggleFilter(provider: Provider): void {
    const next = new Set(activeFilters);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    activeFilters = next;
  }

  function hideBrokenImage(event: Event): void {
    (event.currentTarget as HTMLImageElement).hidden = true;
  }

  $effect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (wrapper?.contains(target)) return;
      if (panel?.contains(target)) return;
      close();
    };
    const reposition = (): void => positionPanel();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", reposition);
    // The panel is viewport-positioned, so any scroll behind it must move it.
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close();
    }
  }}
/>

<div bind:this={wrapper} class="dropdown">
  <button
    bind:this={trigger}
    class="trigger"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={toggle}
  >
    {#if selectedModel}
      <img src={getProviderIcon(selectedModel.provider)} class="icon" alt="" loading="lazy" onerror={hideBrokenImage} />
      <span class="trigger-id">{selectedModel.id}</span>
    {:else}
      <span class="trigger-id placeholder">{loading ? "Loading models…" : "Select a model"}</span>
    {/if}
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div bind:this={panel} class="panel" style={panelStyle}>
      <div class:has-value={searchQuery.length > 0} class="search-wrap">
        <span class="search-icon" aria-hidden="true">⌕</span>
        <input
          bind:this={searchBox}
          bind:value={searchQuery}
          class="search-input"
          type="search"
          placeholder="Search models…"
          autocomplete="off"
          aria-label="Search models"
        />
        <button class="search-clear" type="button" onclick={() => (searchQuery = "")}>Clear</button>
      </div>

      {#if providers.length > 1}
        <div class="chips" aria-label="Filter by provider">
          {#each providers as provider}
            <button
              class:active={activeFilters.has(provider)}
              class="chip"
              type="button"
              aria-pressed={activeFilters.has(provider)}
              onclick={() => toggleFilter(provider)}
            >
              <img src={getProviderIcon(provider)} class="icon" alt="" loading="lazy" onerror={hideBrokenImage} />
              {provider} <span class="count">{providerCounts.get(provider)}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if errorMessage}
        <p class="panel-error" role="alert">{errorMessage}</p>
      {/if}

      <div class="rows" aria-label="Available models">
        {#if loading && models.length === 0}
          <p class="empty">Loading models…</p>
        {:else if visibleModels.length === 0}
          <p class="empty">No models match.</p>
        {:else}
          {#each visibleModels as model (model.id)}
            <button
              class:selected={model.id === selectedId}
              class="row"
              type="button"
              aria-pressed={model.id === selectedId}
              onclick={() => choose(model.id)}
            >
              <img src={getProviderIcon(model.provider)} class="icon" alt="" loading="lazy" onerror={hideBrokenImage} />
              <span class="row-id">{model.id}</span>
              <span class="row-price">{formatPrice(model.pricing.input)} / {formatPrice(model.pricing.output)}</span>
            </button>
          {/each}
        {/if}
      </div>
      <p class="panel-note">Input / output price per million tokens.</p>
    </div>
  {/if}
</div>

<style>
  .dropdown { position: relative; min-width: 0; }

  .trigger {
    display: flex;
    align-items: center;
    gap: 9px;
    max-width: 100%;
    min-height: 38px;
    padding: 7px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink);
    cursor: pointer;
  }

  .trigger:hover { border-color: var(--accent-ink); }

  .trigger-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 600 13px ui-monospace, monospace;
  }

  .placeholder { color: var(--muted); font-weight: 400; font-family: inherit; }
  .caret { color: var(--muted); font-size: 10px; }
  .icon { width: 18px; height: 18px; flex-shrink: 0; border-radius: 4px; object-fit: contain; }

  .panel {
    /* Fixed, with top/left/width set inline, because the chat column clips its
       overflow and would otherwise cut the panel off. */
    position: fixed;
    z-index: 60;
    display: grid;
    gap: 9px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 14px 36px rgba(36, 27, 45, 0.14);
  }

  .search-wrap { position: relative; }

  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--muted);
    font-size: 13px;
    pointer-events: none;
  }

  .search-input {
    width: 100%;
    padding: 9px 58px 9px 34px;
    border: 1px solid var(--line);
    border-radius: 8px;
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

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    font-size: 11.5px;
    cursor: pointer;
    transition: 0.12s;
  }

  .chip:hover { border-color: var(--accent-ink); color: var(--accent-ink); }
  .chip.active { border-color: var(--accent-ink); background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
  .chip .count { font-size: 10.5px; opacity: 0.75; }
  .chip .icon { width: 15px; height: 15px; }

  .rows {
    max-height: min(320px, 44vh);
    overflow-y: auto;
    display: grid;
    gap: 2px;
  }

  .row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 9px;
    align-items: center;
    padding: 7px 9px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row:hover { background: var(--accent-soft); }
  .row.selected { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
  .row .icon { width: 16px; height: 16px; }

  .row-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
  }

  .row-price {
    color: var(--muted);
    font: 400 10.5px ui-monospace, monospace;
    white-space: nowrap;
  }

  .empty, .panel-note { margin: 0; color: var(--muted); font-size: 11.5px; }
  .empty { padding: 16px 4px; text-align: center; }

  .panel-error {
    margin: 0;
    padding: 9px 11px;
    border: 1px solid rgba(164, 63, 85, 0.25);
    border-radius: 8px;
    background: rgba(164, 63, 85, 0.08);
    color: #a43f55;
    font-size: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .chip { transition: none; }
  }
</style>
