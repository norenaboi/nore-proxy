<script lang="ts">
  import type { ModelModality } from "$contracts/models";
  import ModalityIcon from "./ModalityIcon.svelte";

  /**
   * Icon-only three-position modality filter with a thumb that slides between
   * the segments, shared by the admin model list and the public catalog.
   *
   * Selection is single but clearable: choosing the active segment again clears
   * the filter and fades the thumb out, which is what keeps an "all modalities"
   * view reachable from a control that only has three positions.
   *
   * The glyphs come from ModalityIcon, so the badges on the model and endpoint
   * lists carry the same mark as the segment that filters by it.
   */
  let {
    value = null,
    onChange,
    counts = null,
    idPrefix = "modality",
    noun = "models",
  }: {
    value?: ModelModality | null;
    onChange: (next: ModelModality | null) => void;
    counts?: Partial<Record<ModelModality, number>> | null;
    idPrefix?: string;
    /** Plural noun used in each segment's accessible name and tooltip. */
    noun?: string;
  } = $props();

  const OPTIONS: ReadonlyArray<{ modality: ModelModality; label: string }> = [
    { modality: "text", label: "Text" },
    { modality: "image", label: "Image" },
    { modality: "embedding", label: "Embedding" },
  ];

  const activeIndex = $derived(OPTIONS.findIndex((option) => option.modality === value));

  function describe(option: { modality: ModelModality; label: string }): string {
    const hint = `${option.label} ${noun}`;
    const count = counts?.[option.modality];
    return count === undefined ? hint : `${hint} (${count})`;
  }

  function select(modality: ModelModality): void {
    onChange(value === modality ? null : modality);
  }
</script>

<div class="modality-toggle" class:cleared={activeIndex < 0} role="group" aria-label={`Filter ${noun} by modality`}>
  <span class="thumb" style={`--modality-index: ${Math.max(activeIndex, 0)}`} aria-hidden="true"></span>
  {#each OPTIONS as option (option.modality)}
    <button
      type="button"
      class="segment"
      class:active={value === option.modality}
      aria-pressed={value === option.modality}
      aria-label={describe(option)}
      aria-describedby={`${idPrefix}-tip-${option.modality}`}
      onclick={() => select(option.modality)}
    >
      <span class="icon" aria-hidden="true">
        <ModalityIcon modality={option.modality} />
      </span>
      <span class="tip" id={`${idPrefix}-tip-${option.modality}`} role="tooltip">{describe(option)}</span>
    </button>
  {/each}
</div>

<style>
  /*
   * Maps onto the same --pill-* variables the theme pill uses, so the control
   * inherits whichever palette the surrounding document defines.
   */
  .modality-toggle {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    /* Holds its size when it sits in a flex toolbar next to a growing search
       field, so the segments stay square and legible on narrow viewports. */
    flex-shrink: 0;
    /* No column gap: the thumb travels exactly one segment per step, so any gap
       would accumulate into a visible drift by the third position. */
    padding: 3px;
    border: 1px solid var(--pill-line, #ddd4e7);
    border-radius: 999px;
    background: var(--pill-surface, #fff);
    box-shadow: var(--pill-shadow, 0 1px 2px rgba(0, 0, 0, 0.06));
  }

  .thumb {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    width: calc((100% - 6px) / 3);
    border-radius: 999px;
    background: var(--pill-active-surface, #f3eefc);
    transform: translateX(calc(var(--modality-index, 0) * 100%));
    transition: transform 0.26s cubic-bezier(0.34, 1.32, 0.5, 1), opacity 0.16s ease;
  }

  .modality-toggle.cleared .thumb { opacity: 0; }

  .segment {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 38px;
    min-height: 32px;
    padding: 4px 10px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--pill-muted, #70657c);
    font: inherit;
    line-height: 1;
    cursor: pointer;
    transition: color 0.16s ease;
  }

  .segment:hover { color: var(--pill-ink, #241b2d); }
  .segment.active { color: var(--pill-active-ink, #563d7c); }

  .segment:focus-visible {
    outline: 2px solid var(--pill-active-ink, #563d7c);
    outline-offset: 1px;
  }

  .icon {
    display: inline-flex;
    transition: transform 0.26s cubic-bezier(0.34, 1.32, 0.5, 1);
  }

  .segment.active .icon { transform: scale(1.09); }

  /* Hover/focus label. The button already carries the same text as its
     accessible name, so the tooltip is presentational only. */
  .tip {
    position: absolute;
    top: calc(100% + 7px);
    left: 50%;
    z-index: 20;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--pill-ink, #241b2d);
    color: var(--pill-surface, #fff);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    opacity: 0;
    transform: translate(-50%, -3px);
    pointer-events: none;
    transition: opacity 0.14s ease, transform 0.14s ease;
  }

  .segment:hover .tip,
  .segment:focus-visible .tip {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  @media (prefers-reduced-motion: reduce) {
    .thumb, .icon, .tip { transition: none; }
    .segment.active .icon { transform: none; }
  }
</style>
