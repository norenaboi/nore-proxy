<script lang="ts" module>
  export interface PickerOption {
    /** The value handed back on select. */
    id: string;
    /** Primary text of the row and, when selected, of the trigger. */
    label: string;
    /** Small pill after the label — an endpoint's version key, say. */
    badge?: string;
    /** Right-aligned secondary text. */
    meta?: string;
    /** Key of the filter chip this row belongs to. */
    filter?: string;
    /** Extra text the search box matches, beyond the label and id. */
    search?: string;
  }

  export interface PickerFilter {
    key: string;
    label: string;
    count: number;
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { bindPanelListeners, panelGeometryStyle } from "$frontend/lib/admin/pickerPanel";

  /**
   * Single-select dropdown with a search box and a row of filter chips, sharing
   * the chrome of AutoModelTargetPicker so the model editor's pickers read as
   * one control repeated rather than three different ones.
   *
   * The panel is fixed-positioned so it escapes the modal's scrolling body.
   * Callers supply the icons through snippets, which is what lets the same
   * component carry provider logos in one place and modality glyphs in another.
   */
  let {
    options,
    value = "",
    onSelect,
    filters = [],
    disabled = false,
    placeholder = "Select an option",
    searchPlaceholder = "Search…",
    emptyText = "No options match.",
    panelLabel = "Options",
    note = "",
    panelId,
    labelledBy = "",
    icon,
    filterIcon,
  }: {
    options: PickerOption[];
    value?: string;
    onSelect: (id: string) => void;
    filters?: PickerFilter[];
    disabled?: boolean;
    placeholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    panelLabel?: string;
    note?: string;
    panelId: string;
    /** Id of the field label, so the trigger reports the field it stands for. */
    labelledBy?: string;
    icon?: Snippet<[PickerOption]>;
    filterIcon?: Snippet<[PickerFilter]>;
  } = $props();

  let open = $state(false);
  let searchQuery = $state("");
  let activeFilter = $state<string | null>(null);
  let wrapper: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let searchBox: HTMLInputElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();
  let panelStyle = $state("");

  const selected = $derived(options.find((option) => option.id === value));

  const visibleOptions = $derived.by(() => {
    const needle = searchQuery.trim().toLowerCase();
    return options.filter((option) => {
      if (activeFilter !== null && option.filter !== activeFilter) return false;
      if (!needle) return true;
      return [option.id, option.label, option.badge, option.meta, option.search].some(
        (field) => String(field ?? "").toLowerCase().includes(needle),
      );
    });
  });

  function positionPanel(): void {
    if (!trigger) return;
    panelStyle = panelGeometryStyle({ trigger, wrapper });
  }

  function toggle(): void {
    open = !open;
    if (!open) return;
    searchQuery = "";
    activeFilter = null;
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

  function choose(id: string): void {
    onSelect(id);
    close();
  }

  // The chips are single-select: picking one replaces whatever was active, and
  // picking the active one again clears back to every option.
  function toggleFilter(key: string): void {
    activeFilter = activeFilter === key ? null : key;
  }

  $effect(() => {
    if (!open) return;
    return bindPanelListeners({
      contains: () => [wrapper, panel],
      close,
      reposition: positionPanel,
    });
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

<div bind:this={wrapper} class="picker">
  <button
    bind:this={trigger}
    class="trigger"
    type="button"
    disabled={disabled || options.length === 0}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={panelId}
    aria-labelledby={labelledBy ? `${labelledBy} ${panelId}-value` : undefined}
    onclick={toggle}
  >
    {#if selected && icon}
      <span class="trigger-icon">{@render icon(selected)}</span>
    {/if}
    <span class:placeholder={!selected} class="trigger-id" id={`${panelId}-value`}>{selected?.label ?? placeholder}</span>
    {#if selected?.badge}<span class="trigger-badge">{selected.badge}</span>{/if}
    <span class="caret" aria-hidden="true">▾</span>
  </button>

  {#if open}
    <div bind:this={panel} class="panel" id={panelId} role="dialog" aria-label={panelLabel} style={panelStyle}>
      <div class:has-value={searchQuery.length > 0} class="search-wrap">
        <i class="fa-solid fa-magnifying-glass search-icon" aria-hidden="true"></i>
        <input
          bind:this={searchBox}
          bind:value={searchQuery}
          class="search-input"
          type="search"
          placeholder={searchPlaceholder}
          autocomplete="off"
          aria-label={searchPlaceholder}
        />
        <button class="search-clear" type="button" onclick={() => (searchQuery = "")}>Clear</button>
      </div>

      {#if filters.length > 1}
        <div class="chips" aria-label={`Filter ${panelLabel.toLowerCase()}`}>
          {#each filters as filter (filter.key)}
            <button
              class:active={activeFilter === filter.key}
              class="chip"
              type="button"
              aria-label={`${filter.label} (${filter.count})`}
              title={`${filter.label} · ${filter.count}`}
              aria-pressed={activeFilter === filter.key}
              onclick={() => toggleFilter(filter.key)}
            >
              {#if filterIcon}{@render filterIcon(filter)}{:else}<span class="chip-text">{filter.label}</span>{/if}
              <span class="count" aria-hidden="true">{filter.count}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="rows" aria-label={panelLabel}>
        {#if visibleOptions.length === 0}
          <p class="empty">{emptyText}</p>
        {:else}
          {#each visibleOptions as option (option.id)}
            <button
              class:selected={option.id === value}
              class="row"
              type="button"
              aria-pressed={option.id === value}
              onclick={() => choose(option.id)}
            >
              <!-- The icon cell is always emitted: the row is a grid, so an
                   absent first child would shift the label out of its own
                   truncating column. -->
              <span class="row-icon">{#if icon}{@render icon(option)}{/if}</span>
              <span class="row-id">{option.label}</span>
              {#if option.badge}<span class="row-badge">{option.badge}</span>{/if}
              {#if option.meta}<span class="row-meta">{option.meta}</span>{/if}
              {#if option.id === value}<i class="fa-solid fa-check check" aria-hidden="true"></i>{/if}
            </button>
          {/each}
        {/if}
      </div>

      {#if note}<p class="panel-note">{note}</p>{/if}
    </div>
  {/if}
</div>

<style>
  /* Chrome copied from AutoModelTargetPicker so the model editor's three
     dropdowns are visually one control. */
  .picker { position: relative; min-width: 0; flex: 1; }
  .trigger { display: flex; width: 100%; min-height: 38px; align-items: center; gap: 9px; padding: 8px 12px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); text-align: left; cursor: pointer; }
  .trigger:hover:not(:disabled) { border-color: var(--primary-dark); }
  .trigger:disabled { opacity: .6; cursor: not-allowed; }
  .trigger-icon { display: inline-flex; flex-shrink: 0; color: var(--primary-dark); }
  .trigger-id { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: "Courier New", monospace; font-size: 12px; }
  .trigger-id.placeholder { color: var(--text-tertiary); font-family: inherit; }
  .trigger-badge, .row-badge { flex-shrink: 0; padding: 1px 6px; border-radius: 5px; background: var(--primary-alpha-012); color: var(--primary-dark); font: 600 10px/1.6 "Courier New", monospace; }
  .caret { flex-shrink: 0; color: var(--text-secondary); font-size: 10px; }
  .panel { position: fixed; z-index: 520; display: grid; max-height: var(--picker-room); gap: 9px; padding: 12px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); box-shadow: 0 14px 36px rgba(36, 27, 45, .2); }
  .search-wrap { position: relative; flex-shrink: 0; }
  .search-icon { position: absolute; top: 50%; left: 12px; color: var(--text-secondary); font-size: 12px; pointer-events: none; transform: translateY(-50%); }
  .search-input { width: 100%; box-sizing: border-box; padding: 9px 58px 9px 34px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); }
  .search-clear { position: absolute; top: 50%; right: 6px; display: none; padding: 4px 9px; border: 0; border-radius: 6px; background: var(--primary-alpha-012); color: var(--primary-dark); font-size: 11px; font-weight: 600; cursor: pointer; transform: translateY(-50%); }
  .search-wrap.has-value .search-clear { display: block; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { position: relative; display: inline-flex; width: 42px; height: 42px; align-items: center; justify-content: center; padding: 6px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); color: var(--text-secondary); cursor: pointer; }
  .chip:hover { border-color: var(--primary-dark); color: var(--primary-dark); }
  .chip.active { border-color: var(--primary-dark); background: var(--primary-alpha-012); color: var(--primary-dark); box-shadow: 0 0 0 2px var(--primary-alpha-01); }
  .chip-text { font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .chip .count { position: absolute; right: -5px; bottom: -5px; display: inline-flex; min-width: 17px; height: 17px; align-items: center; justify-content: center; padding: 0 3px; border: 2px solid var(--card-bg); border-radius: 999px; background: var(--primary-dark); color: var(--card-bg); font: 700 9px/1 ui-monospace, monospace; }
  .rows { display: grid; min-height: 0; max-height: min(320px, calc(var(--picker-room) - 148px)); overflow-y: auto; gap: 2px; }
  .row { display: grid; width: 100%; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: 9px; padding: 8px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
  .row-icon { display: inline-flex; flex-shrink: 0; }
  .row-id { min-width: 0; overflow: hidden; overflow-wrap: anywhere; font-family: "Courier New", monospace; font-size: 12px; }
  .row-meta { color: var(--text-secondary); font: 400 10.5px "Courier New", monospace; white-space: nowrap; }
  .check { color: var(--primary-dark); }
  .row:hover { background: var(--primary-alpha-01); }
  .row.selected { background: var(--primary-alpha-012); color: var(--primary-dark); font-weight: 600; }
  .empty, .panel-note { margin: 0; color: var(--text-secondary); font-size: 11.5px; }
  .empty { padding: 18px 6px; text-align: center; }
  @media (max-width: 480px) { .row-meta { display: none; } }
</style>
