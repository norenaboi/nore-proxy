<script lang="ts">
  import type { Snippet } from "svelte";
  import type { PublicTheme } from "$frontend/lib/publicTheme";
  import ThemeTogglePill from "./ThemeTogglePill.svelte";

  let {
    activePath,
    theme,
    onThemeChange,
    children,
  }: {
    activePath: string;
    theme: PublicTheme;
    onThemeChange: (theme: PublicTheme) => void;
    children: Snippet;
  } = $props();

  const isHome = $derived(activePath === "/");
  const isModels = $derived(activePath === "/models");
  const isUsage = $derived(activePath === "/usage");
  const isPlayground = $derived(activePath === "/playground");
  const isTerms = $derived(activePath === "/terms");
  const isPrivacy = $derived(activePath === "/privacy");
  const isLegal = $derived(isTerms || isPrivacy);
  const isNotFound = $derived(!isHome && !isModels && !isUsage && !isPlayground && !isLegal);
  const isWide = $derived(isModels || isPlayground);
</script>

<div class="public-utility">
  <div class="public-utility-inner">
    <ThemeTogglePill {theme} {onThemeChange} />
  </div>
</div>

<header class="public-head">
  <a class="brand" href="/">
    <img class="brand-mark" src="/favicon.ico" alt="" />
    <strong>Nore Proxy</strong>
  </a>
  <nav aria-label="Public navigation">
    <a href="/playground" aria-current={isPlayground ? "page" : undefined}>Playground</a>
    <a href="/usage" aria-current={isUsage ? "page" : undefined}>Check Usage</a>
    <a href="/models" aria-current={isModels ? "page" : undefined}>Models</a>
  </nav>
</header>

<main
  class:not-found-main={isNotFound}
  class:wide-main={isWide}
  class:playground-main={isPlayground}
  class="public-main"
>
  {@render children()}
</main>

<footer class="public-footer">
  {#if isHome}
    <span class="public-footer-copy">We do not store prompt content in request logs. We retain operational metadata such as request status, duration, and token counts.</span>
  {/if}
  <span class="public-footer-links">
    <a href="/terms" aria-current={isTerms ? "page" : undefined}>Terms of Service</a>
    <a href="/privacy" aria-current={isPrivacy ? "page" : undefined}>Privacy Policy</a>
    <a href="/admin/login">Admin</a>
    <a href="https://github.com/norenaboi/nore-proxy">Nore-Proxy</a>
  </span>
</footer>
