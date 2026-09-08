<script lang="ts" module>
  export interface SelectMenuOption {
    /** The value handed back on select. */
    value: string;
    /** Primary text of the row and, when selected, of the trigger. */
    label: string;
    /** Short qualifier after the label, rendered in parentheses. */
    note?: string;
    /** Right-aligned monospace text — an upstream path, say. */
    meta?: string;
    /** Key of the group this option is listed under. */
    group?: string;
  }

  export interface SelectMenuGroup {
    key: string;
    label: string;
    /** Small caption after the group label. */
    hint?: string;
    /** Colour of the group's left rail and glyph; falls back to the text tone. */
    accent?: string;
  }
</script>

<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { bindPanelListeners, panelGeometryStyle } from "$frontend/lib/admin/pickerPanel";

  /**
   * Single-select dropdown sharing the chrome of the endpoint editor's API
   * format listbox: an icon, the label, a right-hand meta column, and a
   * floating panel whose rows carry a check on the current choice. A search box
   * appears once the list is longer than `searchThreshold`, so the same control
   * serves a two-option filter and a list of every model seen in the logs.
   *
   * The panel is fixed-positioned, so it escapes the `overflow: hidden` of a
   * settings card and the scrolling body of a modal alike.
   *
   * The keyboard contract a <select> would have given is implemented here:
   * arrows wrap, Home/End jump to the ends, Escape and Tab close, and opening
   * puts focus on the current choice.
   */
  let {
    options,
    value,
    onSelect,
    groups = [],
    disabled = false,
    placeholder = "Select an option",
    panelId,
    panelLabel = "Options",
    labelledBy = "",
    panelMinWidth = 0,
    panelMaxWidth = 500,
    align = "start",
    groupLayout = "rows",
    compact = false,
    maxRows = 8,
    searchThreshold = 12,
    searchPlaceholder = "Search…",
    emptyText = "No options match.",
    icon,
    groupIcon,
  }: {
    options: SelectMenuOption[];
    value: string;
    onSelect: (value: string) => void;
    groups?: SelectMenuGroup[];
    disabled?: boolean;
    placeholder?: string;
    panelId: string;
    panelLabel?: string;
    /** Id of the field label, so the trigger reports the field it stands for. */
    labelledBy?: string;
    /** Narrowest the panel may become, when the field is narrower than its rows. */
    panelMinWidth?: number;
    /** Widest the panel may become; it never exceeds the viewport either. */
    panelMaxWidth?: number;
    align?: "start" | "end";
    /**
     * How the groups are laid out. "columns" stands them side by side as a
     * table of categories, which is what keeps a grouped list one screenful
     * instead of a scrolling stack. Narrow viewports fall back to rows.
     */
    groupLayout?: "rows" | "columns";
    /** Filter-bar density: a 38px field matching the surrounding controls. */
    compact?: boolean;
    /**
     * Rows visible before the list scrolls. This is a fixed cap, not a share of
     * the viewport: the panel keeps one height as the page scrolls under it,
     * and only shrinks when the window itself leaves less room than that.
     */
    maxRows?: number;
    /** Option count above which the panel grows a search box. */
    searchThreshold?: number;
    searchPlaceholder?: string;
    emptyText?: string;
    icon?: Snippet<[SelectMenuOption]>;
    groupIcon?: Snippet<[SelectMenuGroup]>;
  } = $props();

  let open = $state(false);
  let searchQuery = $state("");
  let wrapper: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let searchBox: HTMLInputElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();
  let panelStyle = $state("");

  const selected = $derived(options.find((option) => option.value === value));
  const showSearch = $derived(options.length > searchThreshold);

  const matches = $derived.by(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      [option.value, option.label, option.note, option.meta].some(
        (field) => String(field ?? "").toLowerCase().includes(needle),
      ),
    );
  });

  /**
   * The rendered sections, each row carrying its position in one flat sequence
   * so arrow keys walk the whole menu across group boundaries. Options whose
   * group matches no header are listed last, under no header.
   */
  const sections = $derived.by(() => {
    const rows: { group: SelectMenuGroup | null; items: { option: SelectMenuOption; index: number }[] }[] = [];
    let index = 0;
    const take = (group: SelectMenuGroup | null, members: SelectMenuOption[]) => {
      if (members.length === 0) return;
      rows.push({ group, items: members.map((option) => ({ option, index: index++ })) });
    };
    if (groups.length === 0) {
      take(null, matches);
      return rows;
    }
    const keys = new Set(groups.map((group) => group.key));
    for (const group of groups) take(group, matches.filter((option) => option.group === group.key));
    take(null, matches.filter((option) => !option.group || !keys.has(option.group)));
    return rows;
  });

  /**
   * The rendered row at a position, wrapping at both ends. Read from the DOM
   * rather than from bound references, so a row the search box has just
   * filtered out cannot be focused.
   */
  function optionAt(index: number): HTMLButtonElement | undefined {
    const rows = panel?.querySelectorAll<HTMLButtonElement>(".menu-option");
    if (!rows?.length) return undefined;
    return rows[((index % rows.length) + rows.length) % rows.length];
  }

  function positionPanel(): void {
    if (!trigger) return;
    panelStyle = panelGeometryStyle({
      trigger,
      wrapper,
      minWidth: panelMinWidth,
      maxWidth: panelMaxWidth,
      align,
    });
  }

  function openMenu(focusIndex: number): void {
    open = true;
    searchQuery = "";
    positionPanel();
    void tick().then(() => {
      positionPanel();
      // With a search box the caret starts there; without one, on the current
      // choice, which is where a <select> would have left it.
      if (showSearch) searchBox?.focus();
      else optionAt(focusIndex)?.focus();
    });
  }

  function close({ restoreFocus = false } = {}): void {
    if (!open) return;
    open = false;
    searchQuery = "";
    if (restoreFocus) trigger?.focus();
  }

  function toggle(): void {
    if (open) close({ restoreFocus: true });
    else openMenu(Math.max(options.findIndex((option) => option.value === value), 0));
  }

  function choose(next: string): void {
    onSelect(next);
    close({ restoreFocus: true });
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openMenu(event.key === "ArrowDown" ? 0 : -1);
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    optionAt(event.key === "ArrowDown" ? 0 : -1)?.focus();
  }

  function handleOptionKeydown(event: KeyboardEvent, index: number): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      optionAt(index + 1)?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      optionAt(index - 1)?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      optionAt(0)?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      optionAt(-1)?.focus();
    } else if (event.key === "Tab") {
      close();
    }
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

<!-- Capture phase: a page that closes its modal on Escape listens on document,
     which bubbling would reach before this handler could stop it. -->
<svelte:window
  onkeydowncapture={(event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close({ restoreFocus: true });
    }
  }}
/>

<div bind:this={wrapper} class="select-menu">
  <button
    bind:this={trigger}
    class:open
    class:compact
    class="menu-trigger"
    type="button"
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${panelId}-list`}
    aria-labelledby={labelledBy ? `${labelledBy} ${panelId}-value` : undefined}
    onclick={toggle}
    onkeydown={handleTriggerKeydown}
  >
    {#if selected && icon}<span class="menu-glyph">{@render icon(selected)}</span>{/if}
    <span class:placeholder={!selected} class="menu-value" id={`${panelId}-value`}>{selected?.label ?? placeholder}</span>
    {#if selected?.meta}<span class="menu-meta">{selected.meta}</span>{/if}
    <i class="fa-solid fa-chevron-down menu-caret" aria-hidden="true"></i>
  </button>

  {#if open}
    <div
      bind:this={panel}
      class:with-search={showSearch}
      class:no-glyph={!icon}
      class:columns={groupLayout === "columns" && sections.length > 1}
      class="menu-panel"
      id={panelId}
      role={showSearch ? "dialog" : undefined}
      aria-label={showSearch ? panelLabel : undefined}
      style={`${panelStyle} --menu-max-rows: ${maxRows};`}
    >
      {#if showSearch}
        <div class:has-value={searchQuery.length > 0} class="menu-search">
          <i class="fa-solid fa-magnifying-glass search-icon" aria-hidden="true"></i>
          <input
            bind:this={searchBox}
            bind:value={searchQuery}
            class="search-input"
            type="search"
            placeholder={searchPlaceholder}
            autocomplete="off"
            aria-label={searchPlaceholder}
            onkeydown={handleSearchKeydown}
          />
          <button class="search-clear" type="button" onclick={() => { searchQuery = ""; searchBox?.focus(); }}>Clear</button>
        </div>
      {/if}

      <div class="menu-rows" id={`${panelId}-list`} role="listbox" aria-label={panelLabel} tabindex="-1">
        {#if matches.length === 0}
          <p class="menu-empty">{emptyText}</p>
        {/if}
        {#each sections as section (section.group?.key ?? "__rest")}
          <div class="menu-group" style={section.group?.accent ? `--menu-accent: ${section.group.accent};` : undefined}>
            {#if section.group}
              <!-- Presentational: the headers never take focus, so arrow keys
                   see one uninterrupted option sequence. -->
              <div class="menu-group-head" aria-hidden="true">
                {#if groupIcon}<span class="menu-group-glyph">{@render groupIcon(section.group)}</span>{/if}
                <span class="menu-group-label">{section.group.label}</span>
                {#if section.group.hint}<span class="menu-group-hint">{section.group.hint}</span>{/if}
              </div>
            {/if}
            {#each section.items as { option, index } (option.value)}
              <button
                class:selected={option.value === value}
                class="menu-option"
                type="button"
                role="option"
                aria-selected={option.value === value}
                onclick={() => choose(option.value)}
                onkeydown={(event) => handleOptionKeydown(event, index)}
              >
                <!-- Either every row has a glyph cell or none does: the row is
                     a grid, so a per-row absence would shift the label out of
                     its own truncating column. -->
                {#if icon}<span class="menu-option-glyph">{@render icon(option)}</span>{/if}
                <span class="menu-option-label">{option.label}{#if option.note} <span class="menu-option-note">({option.note})</span>{/if}</span>
                {#if option.meta}<span class="menu-option-meta">{option.meta}</span>{/if}
                <i class="fa-solid fa-check menu-check" aria-hidden="true"></i>
              </button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Chrome copied from the endpoint editor's API format listbox so the two
     read as one control repeated. */
  .select-menu { position: relative; width: 100%; min-width: 0; }
  /* The font and casing are restated rather than inherited: a filter-bar field
     labels itself in small uppercase type, which would otherwise reach both the
     trigger and the panel the wrapper owns. */
  .menu-trigger { display: flex; width: 100%; align-items: center; gap: 10px; padding: 11px 14px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); font: 14px/normal Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: normal; text-align: left; text-transform: none; cursor: pointer; transition: border-color .2s ease, box-shadow .2s ease, background .2s ease; }
  .menu-trigger.compact { height: 38px; gap: 8px; padding: 0 11px; font-size: 12px; }
  .menu-trigger.compact .menu-meta { font-size: 11px; }
  .menu-trigger:hover:not(:disabled) { border-color: var(--primary-dark); }
  .menu-trigger.open { border-color: var(--primary); background: var(--card-bg); box-shadow: 0 0 0 3px var(--primary-alpha-01); }
  .menu-trigger:disabled { opacity: .6; cursor: not-allowed; }
  .menu-glyph { display: inline-flex; flex-shrink: 0; color: var(--primary-dark); }
  .menu-value { min-width: 0; overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .menu-value.placeholder { color: var(--text-tertiary); font-weight: 400; }
  .menu-meta { min-width: 0; flex: 1; overflow: hidden; color: var(--text-secondary); font: 400 12px monospace; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .menu-caret { flex-shrink: 0; margin-left: auto; color: var(--text-secondary); font-size: 11px; transition: transform .18s ease, color .2s ease; }
  .menu-meta ~ .menu-caret { margin-left: 0; }
  .menu-trigger.open .menu-caret { color: var(--primary-dark); transform: rotate(180deg); }
  .menu-panel { position: fixed; z-index: 520; display: grid; max-height: var(--picker-room); gap: 8px; padding: 6px; overflow: hidden; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); color: var(--text-primary); font: 14px/normal Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: normal; text-transform: none; box-shadow: 0 14px 36px rgba(36, 27, 45, .2); animation: menu-panel-in .16s ease; }
  .menu-panel.with-search { padding: 10px; }
  /* The list is capped at a whole number of rows and scrolls past it. The cap
     is a constant, so repositioning as the page scrolls cannot restretch the
     panel; --picker-room only clamps it further when the window is short. */
  .menu-rows { --menu-row-height: 32px; --menu-row-gap: 2px; display: grid; min-height: 0; max-height: min(calc(var(--menu-max-rows, 8) * var(--menu-row-height) - var(--menu-row-gap)), var(--picker-room, 100vh)); gap: var(--menu-row-gap); overflow-y: auto; overscroll-behavior: contain; scrollbar-color: var(--gray-300) transparent; scrollbar-width: thin; }
  .menu-panel.with-search .menu-rows { max-height: min(calc(var(--menu-max-rows, 8) * var(--menu-row-height) - var(--menu-row-gap)), calc(var(--picker-room, 100vh) - 76px)); }
  @keyframes menu-panel-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  .menu-search { position: relative; flex-shrink: 0; }
  .search-icon { position: absolute; top: 50%; left: 12px; color: var(--text-secondary); font-size: 12px; pointer-events: none; transform: translateY(-50%); }
  .search-input { width: 100%; box-sizing: border-box; padding: 9px 58px 9px 34px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--text-primary); font-size: 13px; }
  .search-clear { position: absolute; top: 50%; right: 6px; display: none; padding: 4px 9px; border: 0; border-radius: 6px; background: var(--primary-alpha-012); color: var(--primary-dark); font-size: 11px; font-weight: 600; cursor: pointer; transform: translateY(-50%); }
  .menu-search.has-value .search-clear { display: block; }
  .menu-empty { margin: 0; padding: 18px 6px; color: var(--text-secondary); font-size: 11.5px; text-align: center; }
  /* A tinted rail on each group's left edge marks the category without adding
     a column to every row. */
  .menu-group { --menu-accent: var(--primary-alpha-035); padding: 2px 0; border-left: 3px solid transparent; border-radius: 4px; }
  .menu-group:has(.menu-group-head) { padding-left: 8px; border-left-color: var(--menu-accent); }
  .menu-group + .menu-group { margin-top: 6px; }
  .menu-group-head { display: flex; align-items: center; gap: 7px; padding: 4px 10px 5px; }
  .menu-group-glyph { display: inline-flex; color: var(--menu-accent); }
  .menu-group-label { color: var(--text-primary); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
  .menu-group-hint { color: var(--text-secondary); font-size: 10.5px; }
  /* Fixed-width check column: changing the choice must not reflow the menu. */
  .menu-option { display: grid; width: 100%; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto 13px; gap: 10px; padding: 8px 10px; border: 0; border-radius: 7px; background: none; color: var(--text-primary); font: inherit; text-align: left; cursor: pointer; transition: background .12s ease, color .12s ease; }
  .menu-panel.no-glyph .menu-option { grid-template-columns: minmax(0, 1fr) auto 13px; }
  .menu-option:hover { background: var(--primary-alpha-01); }
  .menu-option:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .menu-option.selected { background: var(--primary-alpha-012); color: var(--primary-dark); }
  .menu-option-glyph { display: inline-flex; color: var(--text-secondary); }
  .menu-option:hover .menu-option-glyph, .menu-option.selected .menu-option-glyph { color: inherit; }
  .menu-option-label { min-width: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .menu-option-note { margin-left: 4px; color: var(--text-secondary); font-size: 11px; font-weight: 400; }
  .menu-option.selected .menu-option-note { color: inherit; opacity: .75; }
  .menu-option-meta { overflow: hidden; color: var(--text-secondary); font: 400 11px monospace; text-overflow: ellipsis; white-space: nowrap; }
  .menu-option:hover .menu-option-meta, .menu-option.selected .menu-option-meta { color: inherit; opacity: .75; }
  .menu-check { color: var(--primary-dark); font-size: 12px; opacity: 0; }
  .menu-option.selected .menu-check { opacity: 1; }
  /* Groups side by side, each column its own category with a ruled header —
     the shape that keeps ten formats on one screen without a scrollbar. The
     per-row glyph is dropped there: the column header already names the
     category, so repeating it on every row is noise. */
  .menu-panel.columns .menu-rows { --menu-row-height: 49px; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0; }
  .menu-panel.columns .menu-group { padding: 0 8px; border-left: 1px solid var(--border-color); border-radius: 0; }
  .menu-panel.columns .menu-group:first-child { padding-left: 2px; border-left: 0; }
  .menu-panel.columns .menu-group:last-child { padding-right: 2px; }
  .menu-panel.columns .menu-group + .menu-group { margin-top: 0; }
  .menu-panel.columns .menu-group-head { flex-direction: column; align-items: start; gap: 1px; margin-bottom: 6px; padding: 2px 8px 6px; border-bottom: 2px solid var(--menu-accent); }
  /* Two rows per option — name over path — with every cell placed explicitly so
     the check never auto-flows past the path onto a third row. */
  .menu-panel.columns .menu-option { align-items: start; grid-template-columns: minmax(0, 1fr) 13px; gap: 2px 8px; }
  .menu-panel.columns .menu-option-glyph { display: none; }
  .menu-panel.columns .menu-option-label { grid-area: 1 / 1 / 2 / 2; white-space: normal; }
  .menu-panel.columns .menu-check { grid-area: 1 / 2 / 2 / 3; align-self: center; }
  .menu-panel.columns .menu-option-meta { grid-area: 2 / 1 / 3 / -1; text-align: left; }
  @media (max-width: 560px) {
    .menu-panel.columns .menu-rows { grid-auto-flow: row; gap: 2px; }
    .menu-panel.columns .menu-group { padding: 2px 0 2px 8px; border-left: 3px solid var(--menu-accent); border-radius: 4px; }
    .menu-panel.columns .menu-group + .menu-group { margin-top: 6px; }
    .menu-panel.columns .menu-group-head { border-bottom: 0; }
  }
  @media (max-width: 480px) { .menu-option-meta { display: none; } }
  @media (prefers-reduced-motion: reduce) {
    .menu-trigger, .menu-caret, .menu-option { transition: none; }
    .menu-panel { animation: none; }
  }
</style>
