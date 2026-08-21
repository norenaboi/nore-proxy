<script lang="ts">
  import type { Snippet } from "svelte";
  import { fly } from "svelte/transition";
  import { logout } from "$frontend/lib/api/admin";
  import { motionDuration } from "$frontend/lib/motion";
  import { toast, theme } from "$frontend/lib/stores";
  import ThemeTogglePill from "../ThemeTogglePill.svelte";

  let {
    activePath,
    title,
    eyebrow = "Administration",
    children,
    actions,
  }: { activePath: string; title: string; eyebrow?: string; children: Snippet; actions?: Snippet } = $props();

  const navItems = [
    { href: "/admin/dashboard", icon: "fa-brands fa-quinscape", label: "Dashboard" },
    { href: "/admin/keys", icon: "fa-solid fa-key", label: "API Keys" },
    { href: "/admin/endpoints", icon: "fa-solid fa-hexagon-nodes", label: "Endpoints" },
    { href: "/admin/models", icon: "fa-solid fa-comment-nodes", label: "Models" },
    { href: "/admin/users", icon: "fa-solid fa-chart-column", label: "API Key Stats" },
    { href: "/admin/endpoint-stats", icon: "fa-solid fa-diagram-project", label: "Endpoint Stats" },
    { href: "/admin/model-stats", icon: "fa-solid fa-chart-line", label: "Model Stats" },
    { href: "/admin/logs", icon: "fa-solid fa-clock-rotate-left", label: "Logs" },
    { href: "/admin/errors", icon: "fa-solid fa-triangle-exclamation", label: "Errors" },
    { href: "/admin/console", icon: "fa-solid fa-terminal", label: "Console" },
    { href: "/admin/settings", icon: "fa-solid fa-sliders", label: "Settings" },
  ];
</script>

<a class="skip-link" href="#main">Skip to content</a>

<div class="admin-utility">
  <ThemeTogglePill theme={$theme} onThemeChange={(next) => theme.select(next)} />
</div>

<aside class="sidebar">
  <div class="logo">
    <img class="logo-icon" src="/favicon.ico" alt="" />
    <span class="logo-text">Nore Proxy</span>
  </div>
  <nav class="nav-menu" aria-label="Admin navigation">
    {#each navItems as item}
      <a
        class="nav-item"
        href={item.href}
        aria-current={activePath === item.href ? "page" : undefined}
      >
        <i class={item.icon}></i>
        <span>{item.label}</span>
      </a>
    {/each}
  </nav>
  <button class="logout" type="button" onclick={logout}>
    <i class="fa-solid fa-right-from-bracket"></i>
    <span>Logout</span>
  </button>
</aside>

<main class="main-content" class:wide-content={activePath === "/admin/logs" || activePath === "/admin/endpoint-stats"} id="main">
  <header class="header">
    <div>
      <p class="header-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
    </div>
    {#if actions}<div class="header-tools">{@render actions()}</div>{/if}
  </header>

  {@render children()}
</main>

<div class="toast-viewport" aria-live="polite" aria-atomic="false">
  {#each $toast as t (t.id)}
    <div class="toast {t.type}" role="status" transition:fly={{ y: 100, duration: motionDuration(300) }}>
      <i class="fa-solid fa-{t.type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i>
      {t.message}
    </div>
  {/each}
</div>

<style>
  .wide-content { width: min(1360px, calc(100% - 64px)); }
  @media (max-width: 1024px) { .wide-content { width: 100%; } }
  @media (max-width: 640px) { .wide-content { padding-inline: 16px; } }
</style>
