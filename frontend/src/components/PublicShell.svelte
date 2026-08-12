<script lang="ts">
  import type { Snippet } from "svelte";

  let { activePath, children }: { activePath: string; children: Snippet } = $props();

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

<header class="public-head">
  <a class="brand" href="/">
    <img class="brand-mark" src="/favicon.ico" alt="" />
    <strong>Nore Proxy</strong>
  </a>
  <nav aria-label="Public navigation">
    <a href="/playground" aria-current={isPlayground ? "page" : undefined}>Playground</a>
    <a href="/usage" aria-current={isUsage ? "page" : undefined}>Usage</a>
    <a href="/models" aria-current={isModels ? "page" : undefined}>Models</a>
    {#if !isHome && !isNotFound}
      <a href="/">Overview</a>
    {/if}
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
    <span class="public-footer-links">
      <a href="/terms">Terms of Service</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/admin/login">Admin</a>
    </span>
  {:else if isModels}
    <span>Nore Proxy</span><a href="/usage">Review usage</a>
  {:else if isUsage}
    <span>Nore Proxy</span><a href="/models">Browse models</a>
  {:else if isPlayground}
    <span>Nore Proxy</span><a href="/models">Browse models</a>
  {:else if isTerms}
    <span class="public-footer-links"><a href="/privacy">Privacy Policy</a><a href="/">Overview</a></span>
  {:else if isPrivacy}
    <span class="public-footer-links"><a href="/terms">Terms of Service</a><a href="/">Overview</a></span>
  {:else}
    <span>Nore Proxy</span><span>Unified model access</span>
  {/if}
</footer>
