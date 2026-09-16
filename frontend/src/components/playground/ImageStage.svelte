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

  function extensionFor(mimeType: string): string {
    const subtype = mimeType.split("/")[1] ?? "png";
    return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/gi, "") || "png";
  }
</script>

<div class="stage" aria-label="Generated images">
  {#if generating}
    <p class="empty pulsing">Generating image…</p>
  {:else if images.length === 0}
    <p class="empty">Describe the image you want in the box below and press Send.</p>
  {:else}
    <div class="results">
      {#each images as image, index (index)}
        <figure class="result">
          <div class="frame">
            <img src={image.dataUrl} alt={prompt || "Generated image"} />
            <a
              class="download"
              href={image.dataUrl}
              download={`generated-image.${extensionFor(image.mimeType)}`}
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

  .result img {
    display: block;
    max-width: 100%;
    max-height: min(62vh, 640px);
    border: 1px solid var(--line);
    border-radius: 10px;
    object-fit: contain;
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
