<script lang="ts">
  import AdminShell from "$frontend/components/admin/AdminShell.svelte";
  import { dashboardRange, pageHeaderActions, theme, type DashboardRange } from "$frontend/lib/stores";
  import { onMount, type Component } from "svelte";

  const path = window.location.pathname.replace(/\/+$/, "") || "/admin/dashboard";

  onMount(() => theme.init());

  const pages: Record<string, () => Promise<{ default: unknown }>> = {
    "/admin/dashboard": () => import("./pages/DashboardPage.svelte"),
    "/admin/model-stats": () => import("./pages/ModelStatsPage.svelte"),
    "/admin/endpoint-stats": () => import("./pages/EndpointStatsPage.svelte"),
    "/admin/users": () => import("./pages/UsersPage.svelte"),
    "/admin/keys": () => import("./pages/KeysPage.svelte"),
    "/admin/endpoints": () => import("./pages/EndpointsPage.svelte"),
    "/admin/models": () => import("./pages/ModelsPage.svelte"),
    "/admin/console": () => import("./pages/ConsolePage.svelte"),
    "/admin/logs": () => import("./pages/LogsPage.svelte"),
    "/admin/errors": () => import("./pages/ErrorsPage.svelte"),
    "/admin/settings": () => import("./pages/SettingsPage.svelte"),
  };

  const titles: Record<string, string> = {
    "/admin/dashboard": "API Usage Dashboard",
    "/admin/model-stats": "Model Stats",
    "/admin/endpoint-stats": "Endpoint Stats",
    "/admin/users": "API Key Stats",
    "/admin/keys": "API Keys",
    "/admin/endpoints": "Endpoints",
    "/admin/models": "Models",
    "/admin/console": "Console",
    "/admin/logs": "Logs",
    "/admin/errors": "Errors",
    "/admin/settings": "Settings",
  };

  let PageComponent: Component | null = $state(null);
  let loadError = $state("");

  // Express serves one document for every admin path, so the tab title has to
  // be set here rather than in admin.html.
  const documentTitle = `${titles[path] ?? "Admin"} — Nore Proxy`;

  const loader = pages[path];
  if (loader) {
    loader()
      .then((mod) => { PageComponent = (mod as { default: Component }).default; })
      .catch(() => { loadError = "Failed to load page."; });
  } else {
    loadError = "Page not found.";
  }
</script>

<svelte:head>
  <title>{documentTitle}</title>
</svelte:head>

<AdminShell activePath={path} title={titles[path] ?? "Admin"} eyebrow={path === "/admin/dashboard" ? "Overview" : "Administration"}>
  {#snippet actions()}
    {#if path === "/admin/dashboard"}
      <div class="dashboard-range-control" aria-label="Dashboard time range">
        {#each (["24h", "7d", "30d", "total"] as DashboardRange[]) as range}
          <button type="button" aria-pressed={$dashboardRange === range} onclick={() => dashboardRange.set(range)}>{range === "total" ? "Total" : range}</button>
        {/each}
      </div>
    {:else if $pageHeaderActions}
      {@const action = $pageHeaderActions}
      <div class="page-header-actions">
        <span class="stats-badge"><i class={action.icon}></i>{action.count} {action.noun}{action.count === 1 ? "" : "s"}</span>
        <button class="btn btn-primary" type="button" onclick={action.onAdd}><i class="fa-solid fa-plus"></i> {action.addLabel}</button>
      </div>
    {/if}
  {/snippet}

  {#if loadError}
    <div class="page-error" role="alert">{loadError}</div>
  {:else if PageComponent}
    <PageComponent />
  {:else}
    <!-- The page chunk is still loading, so its layout is not known yet; this is
         the one placeholder here that cannot mirror real content. -->
    <div class="card skeleton" aria-hidden="true">
      <div class="skeleton-head">
        <span class="skeleton-block skeleton-eyebrow"></span>
        <span class="skeleton-block skeleton-heading"></span>
      </div>
      <div class="skeleton-rows">
        {#each Array(5) as _}
          <div class="skeleton-row">
            <span class="skeleton-block skeleton-cell wide"></span>
            <span class="skeleton-block skeleton-cell"></span>
            <span class="skeleton-block skeleton-cell narrow"></span>
          </div>
        {/each}
      </div>
    </div>
    <span class="sr-only" role="status">Loading…</span>
  {/if}
</AdminShell>

<style>
  .page-header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 16px; }
  .stats-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 20px; background: var(--primary-light); color: var(--primary-dark); font-size: 13px; white-space: nowrap; }
  .dashboard-range-control {
    display: inline-flex;
    padding: 3px;
    border: 1px solid var(--border-color);
    border-radius: 9px;
    background: var(--bg-secondary);
  }
  .dashboard-range-control button {
    min-height: 34px;
    padding: 6px 12px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .dashboard-range-control button[aria-pressed="true"] {
    background: var(--primary);
    color: #241b2d;
    font-weight: 700;
  }
  @media (max-width: 640px) {
    .dashboard-range-control { width: 100%; }
    .dashboard-range-control button { flex: 1; padding-inline: 8px; }
  }
</style>
