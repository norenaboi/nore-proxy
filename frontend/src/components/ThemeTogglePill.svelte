<script lang="ts">
  let {
    theme,
    onThemeChange,
  }: {
    theme: string;
    onThemeChange: (theme: "light" | "dark") => void;
  } = $props();
</script>

<div class="theme-pill" role="group" aria-label="Color theme">
  <button
    type="button"
    aria-label="Light theme"
    aria-pressed={theme !== "dark"}
    onclick={() => onThemeChange("light")}
  >
    <span class="glyph" aria-hidden="true">☀</span><span class="label">Light</span>
  </button>
  <button
    type="button"
    aria-label="Dark theme"
    aria-pressed={theme === "dark"}
    onclick={() => onThemeChange("dark")}
  >
    <span class="glyph" aria-hidden="true">☾</span><span class="label">Dark</span>
  </button>
</div>

<style>
  /*
   * Shared by the public and admin shells. The two apps use different token
   * names, so each stylesheet maps its own palette onto the --pill-* variables
   * below; the fallbacks only apply if a stylesheet forgets to.
   */
  .theme-pill {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px;
    border: 1px solid var(--pill-line, #ddd4e7);
    border-radius: 999px;
    background: var(--pill-surface, #fff);
    box-shadow: var(--pill-shadow, 0 1px 2px rgba(0, 0, 0, 0.06));
  }

  .theme-pill button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 38px;
    padding: 8px 15px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--pill-muted, #70657c);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }

  .theme-pill button:hover { color: var(--pill-ink, #241b2d); }

  .theme-pill button[aria-pressed="true"] {
    background: var(--pill-active-surface, #f3eefc);
    color: var(--pill-active-ink, #563d7c);
    font-weight: 700;
  }

  .theme-pill button:focus-visible {
    outline: 2px solid var(--pill-active-ink, #563d7c);
    outline-offset: 1px;
  }

  .glyph { font-size: 13px; }

  /* Small screens drop the text labels so the control becomes two square icon
     targets instead of a pill wide enough to crowd the header. The buttons keep
     their accessible names from aria-label. */
  @media (max-width: 700px) {
    .theme-pill { gap: 2px; padding: 2px; }
    .theme-pill button { min-width: 38px; min-height: 34px; padding: 6px; }
    .label { display: none; }
    .glyph { font-size: 14px; }
  }
</style>
