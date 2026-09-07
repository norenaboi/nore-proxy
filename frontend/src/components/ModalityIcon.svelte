<script lang="ts">
  import type { ModelModality } from "$contracts/models";

  /**
   * Inline SVG glyph for one modality, shared by the modality filter, the admin
   * model and endpoint lists, and the endpoint editor's format picker.
   *
   * Inline rather than an icon font because the public documents do not load
   * Font Awesome — only the admin stylesheet imports it.
   *
   * Decorative by default; pass a `label` to give the glyph an accessible name
   * where it is the only thing carrying the modality.
   */
  let {
    modality,
    size = 17,
    label = "",
  }: {
    modality: ModelModality;
    size?: number;
    label?: string;
  } = $props();

  const common = $derived({
    viewBox: "0 0 20 20",
    width: size,
    height: size,
    role: label ? "img" : "presentation",
  });
</script>

{#if modality === "text"}
  <svg
    {...common}
    aria-label={label || undefined}
    aria-hidden={label ? undefined : "true"}
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
  >
    <path d="M4.4 5.2h11.2M10 5.2v9.6M7.3 14.8h5.4" />
  </svg>
{:else if modality === "image"}
  <svg
    {...common}
    aria-label={label || undefined}
    aria-hidden={label ? undefined : "true"}
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="2.6" y="3.9" width="14.8" height="12.2" rx="2.4" />
    <circle cx="7.2" cy="8.1" r="1.3" />
    <path d="M3.2 13.6l3.5-3.2a1.6 1.6 0 0 1 2.2 0l4.1 3.8M12 11.3l1.4-1.3a1.6 1.6 0 0 1 2.2 0l1.7 1.6" />
  </svg>
{:else}
  <svg
    {...common}
    aria-label={label || undefined}
    aria-hidden={label ? undefined : "true"}
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M5.6 6.6 14.4 5M5.6 6.6l3.2 7.1M14.4 5l0.9 7.4M8.8 13.7l6.5-1.3" />
    <circle cx="4.6" cy="6.2" r="1.9" fill="currentColor" stroke="none" />
    <circle cx="15.3" cy="4.6" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="9.4" cy="14.6" r="1.7" fill="currentColor" stroke="none" />
    <circle cx="15.8" cy="12.8" r="1.7" fill="currentColor" stroke="none" />
  </svg>
{/if}

<style>
  svg { display: block; }
</style>
