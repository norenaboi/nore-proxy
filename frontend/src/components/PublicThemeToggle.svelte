<script lang="ts">
  import type { PublicTheme } from "$frontend/lib/publicTheme";

  let {
    theme,
    onThemeChange,
  }: {
    theme: PublicTheme;
    onThemeChange: (theme: PublicTheme) => void;
  } = $props();
</script>

<div class="public-theme-toggle" role="group" aria-label="Color theme">
  <button
    type="button"
    aria-pressed={theme === "light"}
    onclick={() => onThemeChange("light")}
  >
    <span aria-hidden="true">☀</span> Light
  </button>
  <button
    type="button"
    aria-pressed={theme === "dark"}
    onclick={() => onThemeChange("dark")}
  >
    <span aria-hidden="true">☾</span> Dark
  </button>
</div>
