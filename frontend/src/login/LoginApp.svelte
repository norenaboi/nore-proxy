<script lang="ts">
  let masterKey = $state("");
  let errorMessage = $state("");
  let loading = $state(false);

  async function login(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    errorMessage = "";
    loading = true;
    try {
      const res = await fetch("/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterKey }),
      });
      if (res.ok) {
        window.location.href = "/admin/dashboard";
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        errorMessage = data.error ?? "Invalid master key";
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
    <p class="eyebrow">Administration</p>
    <h1 id="loginTitle">Welcome back.</h1>
    <p class="intro">Enter the master key to access proxy operations and usage.</p>
    <form onsubmit={login} aria-busy={loading}>
      <div class="form-group">
        <label for="masterKey">Master key</label>
        <input
          id="masterKey"
          type="password"
          bind:value={masterKey}
          placeholder="Enter master key"
          autocomplete="current-password"
          required
        />
      </div>
      <button type="submit" disabled={loading}>Access dashboard</button>
      {#if errorMessage}
        <div class="error" role="alert">{errorMessage}</div>
      {/if}
    </form>
  </section>
  <a class="back-link" href="/">← Return to public pages</a>
</main>
