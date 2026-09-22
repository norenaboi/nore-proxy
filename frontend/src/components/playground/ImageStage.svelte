<script lang="ts">
  import type { ImageSlot } from "$frontend/lib/playground/images";
  import type { StreamImage } from "$frontend/lib/playground/stream";

  let {
    slots,
    generating,
    statusMessage,
    onRetry,
  }: {
    slots: ImageSlot[];
    generating: boolean;
    statusMessage: string;
    onRetry?: (slotId: string) => void;
  } = $props();

  const batches = $derived.by(() => {
    const grouped: Array<{ id: string; layout: ImageSlot["layout"]; slots: ImageSlot[] }> = [];
    for (const slot of slots) {
      const current = grouped.at(-1);
      if (current?.id === slot.batchId) current.slots.push(slot);
      else grouped.push({ id: slot.batchId, layout: slot.layout, slots: [slot] });
    }
    return grouped;
  });
  const readySlots = $derived(
    slots.filter((slot): slot is ImageSlot & { image: StreamImage } => slot.state === "ready" && Boolean(slot.image)),
  );

  /** Stable id of the image shown full-size, or null for the grid. */
  let inspectedId = $state<string | null>(null);
  let slideDirection = $state<-1 | 0 | 1>(0);
  let lastBatchId: string | undefined;
  const inspectedIndex = $derived(readySlots.findIndex((slot) => slot.id === inspectedId));
  const inspectedSlot = $derived(inspectedIndex >= 0 ? readySlots[inspectedIndex] : undefined);

  $effect(() => {
    const newestBatchId = slots[0]?.batchId;
    if (lastBatchId !== undefined && newestBatchId !== lastBatchId) inspectedId = null;
    lastBatchId = newestBatchId;
  });

  $effect(() => {
    if (inspectedId !== null && inspectedIndex === -1) inspectedId = null;
  });

  function extensionFor(mimeType: string): string {
    const subtype = mimeType.split("/")[1] ?? "png";
    return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "") || "png";
  }

  function downloadName(image: StreamImage, index: number): string {
    const suffix = readySlots.length > 1 ? `-${index + 1}` : "";
    return `generated-image${suffix}.${extensionFor(image.mimeType)}`;
  }

  function altFor(slot: ImageSlot, index: number): string {
    const base = slot.prompt || "Generated image";
    return readySlots.length > 1 ? `${base} (${index + 1} of ${readySlots.length})` : base;
  }

  function inspect(id: string, direction: -1 | 0 | 1 = 0): void {
    slideDirection = direction;
    inspectedId = id;
  }

  function moveInspection(direction: -1 | 1): void {
    if (inspectedIndex < 0 || readySlots.length < 2) return;
    const next = (inspectedIndex + direction + readySlots.length) % readySlots.length;
    inspect(readySlots[next].id, direction);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape" && inspectedId !== null) inspectedId = null;
    if (event.key === "ArrowLeft" && inspectedId !== null) moveInspection(-1);
    if (event.key === "ArrowRight" && inspectedId !== null) moveInspection(1);
  }}
/>

<div class:has-results={slots.length > 0} class="stage" data-image-stage aria-label="Generated images">
  {#if slots.length === 0}
    <p class="empty">Describe the image you want in the box below and press Send.</p>
  {:else if inspectedSlot?.image}
    <div class="inspect">
      <button class="back" type="button" onclick={() => (inspectedId = null)}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9.5 3.5 5 8l4.5 4.5" />
        </svg>
        Back
      </button>
      <div class="viewer">
        {#if readySlots.length > 1}
          <button class="previous navigation" type="button" onclick={() => moveInspection(-1)} aria-label="Previous image" title="Previous image">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 3 5 8l5 5" />
            </svg>
          </button>
        {/if}
        <div class="frame">
          {#key inspectedSlot.id}
            <img
              class:slide-left={slideDirection < 0}
              class:slide-right={slideDirection > 0}
              class="full"
              src={inspectedSlot.image.dataUrl}
              alt={altFor(inspectedSlot, inspectedIndex)}
            />
          {/key}
          <a
            class="download"
            href={inspectedSlot.image.dataUrl}
            download={downloadName(inspectedSlot.image, inspectedIndex)}
            aria-label="Download image"
            title="Download"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 2.5v8m0 0 3-3m-3 3-3-3M3 13.5h10" />
            </svg>
          </a>
        </div>
        {#if readySlots.length > 1}
          <button class="next navigation" type="button" onclick={() => moveInspection(1)} aria-label="Next image" title="Next image">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m6 3 5 5-5 5" />
            </svg>
          </button>
        {/if}
      </div>
      {#if readySlots.length > 1}
        <p class="position">{inspectedIndex + 1} / {readySlots.length}</p>
      {/if}
    </div>
  {:else}
    <div class="gallery">
      {#each batches as batch (batch.id)}
        <div
          class:single={batch.slots.length === 1}
          class:portrait={batch.layout === "portrait"}
          class:landscape={batch.layout === "landscape"}
          class="results"
        >
          {#each batch.slots as slot (slot.id)}
            <figure class="result">
              {#if slot.state === "ready" && slot.image}
                {@const index = readySlots.findIndex((candidate) => candidate.id === slot.id)}
                <div class="frame">
                  <button
                    class="zoom"
                    type="button"
                    onclick={() => inspect(slot.id)}
                    aria-label={`Inspect image ${index + 1} of ${readySlots.length}`}
                  >
                    <img src={slot.image.dataUrl} alt={altFor(slot, index)} />
                  </button>
                  <a
                    class="download"
                    href={slot.image.dataUrl}
                    download={downloadName(slot.image, index)}
                    aria-label="Download image"
                    title="Download"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M8 2.5v8m0 0 3-3m-3 3-3-3M3 13.5h10" />
                    </svg>
                  </a>
                </div>
              {:else if slot.state === "failed"}
                <div class="placeholder failed" aria-label="Image generation failed">
                  <button type="button" onclick={() => onRetry?.(slot.id)} disabled={generating || !onRetry}>
                    Regenerate image
                  </button>
                </div>
              {:else}
                <div class="placeholder" aria-label="Image generating">
                  <span aria-hidden="true"></span>
                  <small>Generating…</small>
                </div>
              {/if}
            </figure>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</div>

<p class="visually-hidden" role="status" aria-live="polite">{statusMessage}</p>

<style>
  /* Mirrors the transcript panel so switching modes keeps the same frame. */
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    display: grid;
    align-content: safe center;
    justify-items: center;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
  }

  .stage.has-results { align-content: start; }

  .empty {
    margin: 0;
    max-width: 46ch;
    padding: 48px 20px;
    color: var(--muted);
    text-align: center;
    line-height: 1.7;
  }

  .gallery {
    display: grid;
    gap: 18px;
    width: 100%;
    min-height: 0;
  }

  .results {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    width: 100%;
    min-height: 0;
  }

  .results.portrait { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .results.single { grid-template-columns: minmax(0, 1fr); }

  .result {
    display: grid;
    margin: 0;
    min-width: 0;
    max-width: 100%;
    justify-items: center;
  }

  .frame {
    position: relative;
    min-width: 0;
    max-width: 100%;
  }

  .zoom {
    display: block;
    padding: 0;
    border: 0;
    min-width: 0;
    max-width: 100%;
    background: none;
    cursor: zoom-in;
  }

  .result img {
    display: block;
    width: auto;
    max-width: 100%;
    max-height: min(38vh, 380px);
    border: 1px solid var(--line);
    border-radius: 10px;
    object-fit: contain;
  }

  .results.single .result img { max-height: min(62vh, 640px); }

  .placeholder {
    position: relative;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 10px;
    width: 100%;
    min-height: 220px;
    overflow: hidden;
    border: 1px dashed var(--line);
    border-radius: 10px;
    color: var(--muted);
    background: var(--surface-raised, var(--surface));
  }

  .placeholder span {
    position: absolute;
    inset: 0;
    background: linear-gradient(110deg, transparent 25%, var(--accent-soft) 45%, transparent 65%);
    transform: translateX(-100%);
    animation: loading-sweep 1.5s ease-in-out infinite;
  }

  .placeholder small { position: relative; font-size: 12px; }

  .placeholder button {
    position: relative;
    min-height: 38px;
    padding: 9px 14px;
    border: 1px solid var(--accent-ink);
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font: inherit;
    cursor: pointer;
  }

  .placeholder button:disabled { cursor: not-allowed; opacity: 0.55; }

  @keyframes loading-sweep {
    to { transform: translateX(100%); }
  }

  .inspect {
    display: grid;
    justify-items: center;
    min-width: 0;
    max-width: 100%;
    padding-top: 34px;
  }

  .viewer {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
    max-width: 100%;
  }

  .inspect .frame { overflow: hidden; }

  .inspect .full {
    display: block;
    max-width: 100%;
    max-height: min(74vh, 900px);
    border: 1px solid var(--line);
    border-radius: 10px;
    object-fit: contain;
  }

  .slide-left { animation: slide-from-left 180ms ease-out; }
  .slide-right { animation: slide-from-right 180ms ease-out; }

  @keyframes slide-from-left {
    from { opacity: 0; transform: translateX(-18px); }
  }

  @keyframes slide-from-right {
    from { opacity: 0; transform: translateX(18px); }
  }

  .navigation {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
  }

  .navigation:hover,
  .navigation:focus-visible {
    color: var(--ink);
    border-color: var(--muted);
  }

  .position {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .back {
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 6px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    font-size: 12.5px;
    cursor: pointer;
  }

  .back:hover,
  .back:focus-visible { color: var(--ink); }

  .download {
    position: absolute;
    top: 8px;
    right: 8px;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    color: #fff;
    background: rgb(0 0 0 / 55%);
    opacity: 0.35;
    transition: opacity 120ms ease;
  }

  .frame:hover .download,
  .download:hover,
  .download:focus-visible { opacity: 1; }

  @media (max-width: 760px) {
    .results.portrait { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (max-width: 560px) {
    .results,
    .results.portrait { grid-template-columns: minmax(0, 1fr); }

    .viewer {
      grid-template-columns: repeat(2, auto);
      justify-content: center;
    }

    .viewer .frame {
      grid-column: 1 / -1;
      grid-row: 1;
    }

    .navigation {
      grid-row: 2;
      margin-top: 2px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .download { transition: none; }
    .slide-left,
    .slide-right { animation: none; }
    .placeholder span { animation: none; transform: none; opacity: 0.45; }
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
