<script lang="ts">
  /**
   * Markup only: the styles live in src/styles/themePill.css because each HTML
   * entry document paints a static copy of this control before the bundle runs,
   * and scoped component styles could never reach it.
   */
  let {
    theme,
    onThemeChange,
  }: {
    theme: string;
    onThemeChange: (theme: "light" | "dark") => void;
  } = $props();

  const isDark = $derived(theme === "dark");
</script>

<div class="theme-pill" role="group" aria-label="Color theme">
  <span class="thumb" style={`--theme-index: ${isDark ? 1 : 0}`} aria-hidden="true"></span>
  <button
    type="button"
    aria-label="Light theme"
    aria-pressed={!isDark}
    onclick={() => onThemeChange("light")}
  >
    <span class="glyph" aria-hidden="true">☀</span>
  </button>
  <button
    type="button"
    aria-label="Dark theme"
    aria-pressed={isDark}
    onclick={() => onThemeChange("dark")}
  >
    <span class="glyph" aria-hidden="true">☾</span>
  </button>
</div>
