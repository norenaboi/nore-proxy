<script lang="ts">
  import PublicShell from "../components/PublicShell.svelte";
  import HomePage from "./pages/HomePage.svelte";
  import LegalPage from "./pages/LegalPage.svelte";
  import ModelsPage from "./pages/ModelsPage.svelte";
  import NotFoundPage from "./pages/NotFoundPage.svelte";
  import UsagePage from "./pages/UsagePage.svelte";

  const path = window.location.pathname.replace(/\/+$/, "") || "/";
</script>

<PublicShell activePath={path}>
  {#if path === "/"}
    <HomePage />
  {:else if path === "/usage"}
    <UsagePage />
  {:else if path === "/models"}
    <ModelsPage />
  {:else if path === "/terms"}
    <LegalPage kind="terms" />
  {:else if path === "/privacy"}
    <LegalPage kind="privacy" />
  {:else}
    <NotFoundPage />
  {/if}
</PublicShell>
