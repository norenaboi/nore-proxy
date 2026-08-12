<script lang="ts">
  import PublicShell from "../components/PublicShell.svelte";
  import HomePage from "./pages/HomePage.svelte";
  import LegalPage from "./pages/LegalPage.svelte";
  import ModelsPage from "./pages/ModelsPage.svelte";
  import NotFoundPage from "./pages/NotFoundPage.svelte";
  import PlaygroundPage from "./pages/PlaygroundPage.svelte";
  import UsagePage from "./pages/UsagePage.svelte";

  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  // Express serves one document for every public path, so the tab title has to
  // be set here rather than in public.html.
  const titles: Record<string, string> = {
    "/": "Unified model access",
    "/usage": "Usage",
    "/models": "Models",
    "/playground": "Playground",
    "/terms": "Terms of Service",
    "/privacy": "Privacy Policy",
  };
  const title = `${titles[path] ?? "Page not found"} — Nore Proxy`;
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<PublicShell activePath={path}>
  {#if path === "/"}
    <HomePage />
  {:else if path === "/usage"}
    <UsagePage />
  {:else if path === "/models"}
    <ModelsPage />
  {:else if path === "/playground"}
    <PlaygroundPage />
  {:else if path === "/terms"}
    <LegalPage kind="terms" />
  {:else if path === "/privacy"}
    <LegalPage kind="privacy" />
  {:else}
    <NotFoundPage />
  {/if}
</PublicShell>
