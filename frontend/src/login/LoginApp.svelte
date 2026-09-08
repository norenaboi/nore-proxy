<script lang="ts">
  let key = $state("");
  let errorMessage = $state("");
  let loading = $state(false);

  // One form for both audiences: the server decides from the submitted key
  // whether this is an account or the admin panel, and answers with the path.
  async function login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMessage = "";
    loading = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({})) as { redirect?: string; error?: string };
      if (res.ok && data.redirect) {
        window.location.href = data.redirect;
      } else {
        errorMessage = data.error ?? "Invalid key";
      }
    } catch {
      errorMessage = "Network error. Please try again.";
    } finally {
      loading = false;
    }
  }
</script>

<main class="login-shell">
  <a class="brand" href="/">
    <img src="/favicon.ico" alt="" />
    <strong>Nore Proxy</strong>
  </a>
  <section class="container" aria-labelledby="loginTitle">
    <p class="eyebrow">Sign in</p>
    <h1 id="loginTitle">Welcome back.</h1>
    <p class="intro">Enter your API key</p>
    <form onsubmit={login} aria-busy={loading}>
      <div class="form-group">
        <label for="key">API key</label>
        <input
          id="key"
          type="password"
          bind:value={key}
          placeholder="Enter your key"
          autocomplete="current-password"
          required
        />
      </div>
      <button type="submit" disabled={loading}>{loading ? "Signing in…" : "Continue"}</button>
      {#if errorMessage}
        <div class="error" role="alert">{errorMessage}</div>
      {/if}
    </form>
  </section>
  <a class="back-link" href="/">← Return to public pages</a>
</main>
