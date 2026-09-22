<script lang="ts">
  import type { StreamImage } from "$frontend/lib/playground/stream";

  let {
    images,
    prompt,
    generating,
    statusMessage,
  }: {
    images: StreamImage[];
    /** The prompt that produced the current images, used as their alt text. */
    prompt: string;
    generating: boolean;
    statusMessage: string;
  } = $props();

  /** Index of the image shown full-size, or null for the grid. */
  let inspected = $state<number | null>(null);

  // A new generation replaces the images array, so a stale inspect view from
  // the previous batch never survives into the next one.
  $effect(() => {
    void images;
    inspected = null;
  });

  function extensionFor(mimeType: string): string {
    const subtype = mimeType.split("/")[1] ?? "png";
    return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "") || "png";
  }

  function downloadName(image: StreamImage, index: number): string {
    const suffix = images.length > 1 ? `-${index + 1}` : "";
    return `generated-image${suffix}.${extensionFor(image.mimeType)}`;
  }

  function altFor(index: number): string {
    const base = prompt || "Generated image";
    return images.length > 1 ? `${base} (${index + 1} of ${images.length})` : base;
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape" && inspected !== null) inspected = null;
  }}
/>

<div class="stage" aria-label="Generated images">
  {#if generating}
    <p class="empty pulsing">Generating image…</p>
  {:else if images.length === 0}
    <p class="empty">Describe the image you want in the box below and press Send.</p>
  {:else if inspected !== null && images[inspected]}
    <div class="inspect">
      <button class="back" type="button" onclick={() => (inspected = null)}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9.5 3.5 5 8l4.5 4.5" />
        </svg>
        Back
      </button>
      <div class="frame">
        <img class="full" src={images[inspected].dataUrl} alt={altFor(inspected)} />
        <a
          class="download"
          href={images[inspected].dataUrl}
          download={downloadName(images[inspected], inspected)}
          aria-label="Download image"
          title="Download"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 2.5v8m0 0 3-3m-3 3-3-3M3 13.5h10" />
          </svg>
        </a>
      </div>
    </div>
  {:else}
    <div class:multi={images.length > 1} class="results">
      {#each images as image, index (index)}
        <figure class="result">
          <div class="frame">
            <button
              class="zoom"
              type="button"
              onclick={() => (inspected = index)}
              aria-label={`Inspect image ${index + 1} of ${images.length}`}
            >
              <img src={image.dataUrl} alt={altFor(index)} />
            </button>
            <a
              class="download"
              href={image.dataUrl}
              download={downloadName(image, index)}
              aria-label="Download image"
              title="Download"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 2.5v8m0 0 3-3m-3 3-3-3M3 13.5h10" />
              </svg>
            </a>
          </div>
        </figure>
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
    align-content: center;
    justify-items: center;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
  }

  .empty {
    margin: 0;
    max-width: 46ch;
    padding: 48px 20px;
    color: var(--muted);
    text-align: center;
    line-height: 1.7;
  }

  .pulsing { animation: stage-pulse 1.4s ease-in-out infinite; }

  @keyframes stage-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }

  .results {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    justify-content: center;
    max-width: 100%;
  }

  .result {
    display: grid;
    gap: 8px;
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
    max-width: 100%;
    max-height: min(62vh, 640px);
    border: 1px solid var(--line);
    border-radius: 10px;
    object-fit: contain;
  }

  /* Several results share the stage, so each thumbnail stays smaller. */
  .results.multi .result img {
    max-height: min(38vh, 380px);
  }

  .inspect {
    display: grid;
    justify-items: center;
    min-width: 0;
    max-width: 100%;
    /* Clears the back button pinned to the stage's top-left corner. */
    padding-top: 34px;
  }

  .inspect .full {
    display: block;
    max-width: 100%;
    max-height: min(74vh, 900px);
    border: 1px solid var(--line);
    border-radius: 10px;
    object-fit: contain;
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
  .back:focus-visible {
    color: var(--ink);
  }

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
  .download:focus-visible {
    opacity: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .download { transition: none; }
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .pulsing { animation: none; }
  }
</style>
