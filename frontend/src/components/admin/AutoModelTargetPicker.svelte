<script lang="ts">
  import { tick } from "svelte";
  import { filterModelNames } from "$frontend/admin/modelForm";
  import {
    formatPrice,
    getProviderIcon,
    type CatalogModel,
    type Provider,
  } from "$frontend/lib/models/catalog";

  let {
    options,
    selectedId,
    onSelect,
  }: {
    options: CatalogModel[];
    selectedId: string;
    onSelect: (modelName: string) => void;
  } = $props();

  let open = $state(false);
  let searchQuery = $state("");
  let activeFilters = $state(new Set<Provider>());
  let wrapper: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let searchBox: HTMLInputElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();
  let panelStyle = $state("");

  const PANEL_WIDTH = 500;
  const VIEWPORT_GUTTER = 12;
  const PANEL_GAP = 6;
  const PANEL_ID = "auto-model-target-picker-panel";

  const providerCounts = $derived(
    options.reduce(
      (counts, model) => counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1),
      new Map<Provider, number>(),
    ),
  );
  const providers = $derived([...providerCounts.keys()].sort());
  const visibleOptions = $derived.by(() => {
    const filteredIds = new Set(filterModelNames(options.map((option) => option.id), searchQuery));
    return options.filter(
      (option) => filteredIds.has(option.id) && (activeFilters.size === 0 || activeFilters.has(option.provider)),
    );
  });

  function positionPanel(): void {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const containerRect = wrapper?.getBoundingClientRect();
    const parentWidth = containerRect?.width ?? rect.width;
    const width = Math.min(PANEL_WIDTH, parentWidth, window.innerWidth - VIEWPORT_GUTTER * 2);
    const preferredLeft = containerRect?.left ?? rect.left;
    const left = Math.min(Math.max(preferredLeft, VIEWPORT_GUTTER), window.innerWidth - width - VIEWPORT_GUTTER);
    const roomBelow = window.innerHeight - rect.bottom - PANEL_GAP - VIEWPORT_GUTTER;
    const roomAbove = rect.top - PANEL_GAP - VIEWPORT_GUTTER;
    const placeBelow = roomBelow >= 260 || roomBelow >= roomAbove;
    const room = Math.max(96, placeBelow ? roomBelow : roomAbove);
    const verticalPosition = placeBelow
      ? `top: ${rect.bottom + PANEL_GAP}px;`
      : `bottom: ${window.innerHeight - rect.top + PANEL_GAP}px;`;
    panelStyle = `${verticalPosition} left: ${left}px; width: ${width}px; --picker-room: ${room}px;`;
  }

  function toggle(): void {
    open = !open;
    if (!open) return;
    searchQuery = "";
    activeFilters = new Set();
    positionPanel();
    void tick().then(() => {
      positionPanel();
      searchBox?.focus();
    });
  }

  function close(): void {
    if (!open) return;
    open = false;
    trigger?.focus();
  }

  function choose(modelName: string): void {
    onSelect(modelName);
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
      if (wrapper?.contains(target) || panel?.contains(target)) return;
      close();
    };
    const reposition = (): void => positionPanel();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", reposition);
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

<div bind:this={wrapper} class="target-dropdown">
  <button
    bind:this={trigger}
    class="trigger"
    type="button"
    disabled={options.length === 0}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={PANEL_ID}
    onclick={toggle}
  >
    <span class:placeholder={!selectedId} class="trigger-id">
      {selectedId || (options.length === 0 ? "No enabled concrete models available" : "Select a concrete model")}
    </span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div bind:this={panel} class="panel" id={PANEL_ID} role="dialog" aria-label="Select a concrete model" style={panelStyle}>
      <div class:has-value={searchQuery.length > 0} class="search-wrap">
        <i class="fa-solid fa-magnifying-glass search-icon" aria-hidden="true"></i>
        <input bind:this={searchBox} bind:value={searchQuery} class="search-input" type="search" placeholder="Search models…" autocomplete="off" aria-label="Search concrete models" />
        <button class="search-clear" type="button" onclick={() => (searchQuery = "")}>Clear</button>
      </div>

      {#if providers.length > 1}
        <div class="chips" aria-label="Filter by provider">
          {#each providers as provider}
            <button
              class:active={activeFilters.has(provider)}
              class="chip"
              type="button"
              aria-label={`Filter by ${provider} (${providerCounts.get(provider)} models)`}
              title={`${provider} · ${providerCounts.get(provider)} models`}
              aria-pressed={activeFilters.has(provider)}
              onclick={() => toggleFilter(provider)}
            >
              <img src={getProviderIcon(provider)} class="icon" alt="" loading="lazy" onerror={hideBrokenImage} />
              <span class="count" aria-hidden="true">{providerCounts.get(provider)}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="rows" aria-label="Available concrete models">
        {#if visibleOptions.length === 0}
          <p class="empty">No models match.</p>
        {:else}
          {#each visibleOptions as option (option.id)}
            <button class:selected={option.id === selectedId} class="row" type="button" aria-pressed={option.id === selectedId} onclick={() => choose(option.id)}>
              <img src={getProviderIcon(option.provider)} class="icon" alt="" loading="lazy" onerror={hideBrokenImage} />
              <span class="row-id">{option.id}</span>
              <span class="row-price">{formatPrice(option.pricing.input)} / {formatPrice(option.pricing.output)}</span>
              {#if option.id === selectedId}<i class="fa-solid fa-check check" aria-hidden="true"></i>{/if}
            </button>
          {/each}
        {/if}
      </div>
      <p class="panel-note">Input / output price per million tokens.</p>
    </div>
  {/if}
</div>

<style>
  .target-dropdown { position: relative; min-width: 0; flex: 1; }
  .trigger { display: flex; width: 100%; min-height: 38px; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); text-align: left; cursor: pointer; }
  .trigger:hover:not(:disabled) { border-color: var(--primary-dark); }
  .trigger:disabled { opacity: .6; cursor: not-allowed; }
  .trigger-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: "Courier New", monospace; font-size: 12px; }
  .trigger-id.placeholder { color: var(--text-tertiary); font-family: inherit; }
  .caret { flex-shrink: 0; color: var(--text-secondary); font-size: 10px; }
  .panel { position: fixed; z-index: 520; display: grid; max-height: var(--picker-room); gap: 9px; padding: 12px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: 0 14px 36px rgba(36, 27, 45, .2); }
  .search-wrap { position: relative; flex-shrink: 0; }
  .search-icon { position: absolute; top: 50%; left: 12px; color: var(--text-secondary); font-size: 12px; pointer-events: none; transform: translateY(-50%); }
  .search-input { width: 100%; padding: 9px 58px 9px 34px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); }
  .search-clear { position: absolute; top: 50%; right: 6px; display: none; padding: 4px 9px; border: 0; border-radius: 6px; background: var(--primary-alpha-012); color: var(--primary-dark); font-size: 11px; font-weight: 600; cursor: pointer; transform: translateY(-50%); }
  .search-wrap.has-value .search-clear { display: block; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { position: relative; display: inline-flex; width: 42px; height: 42px; align-items: center; justify-content: center; padding: 6px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); color: var(--text-secondary); cursor: pointer; }
  .chip:hover { border-color: var(--primary-dark); color: var(--primary-dark); }
  .chip.active { border-color: var(--primary-dark); background: var(--primary-alpha-012); color: var(--primary-dark); box-shadow: 0 0 0 2px var(--primary-alpha-01); }
  .chip .count { position: absolute; right: -5px; bottom: -5px; display: inline-flex; min-width: 17px; height: 17px; align-items: center; justify-content: center; padding: 0 3px; border: 2px solid var(--card-bg); border-radius: 999px; background: var(--primary-dark); color: var(--card-bg); font: 700 9px/1 ui-monospace, monospace; }
  .icon { width: 24px; height: 24px; flex-shrink: 0; border-radius: 5px; object-fit: contain; }
  .chip .icon { width: 27px; height: 27px; }
  .rows { display: grid; min-height: 0; max-height: min(320px, calc(var(--picker-room) - 112px)); overflow-y: auto; gap: 2px; }
  .row { display: grid; width: 100%; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 9px; padding: 8px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
  .row-id { min-width: 0; overflow: hidden; overflow-wrap: anywhere; font-family: "Courier New", monospace; font-size: 12px; }
  .row-price { color: var(--text-secondary); font: 400 10.5px "Courier New", monospace; white-space: nowrap; }
  .check { color: var(--primary-dark); }
  .row:hover { background: var(--primary-alpha-01); }
  .row.selected { background: var(--primary-alpha-012); color: var(--primary-dark); font-weight: 600; }
  .empty, .panel-note { margin: 0; color: var(--text-secondary); font-size: 11.5px; }
  .empty { padding: 18px 6px; text-align: center; }
  @media (max-width: 480px) { .target-dropdown { flex-basis: 100%; } .row-price { display: none; } }
  @media (prefers-reduced-motion: reduce) { .trigger, .row { transition: none; } }
</style>
