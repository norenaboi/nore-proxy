<section class="not-found">
  <p class="eyebrow">404 · Not found</p>
  <h1>This route isn’t here.</h1>
  <p class="lead">The page may have moved, or the address may not belong to the public interface.</p>
  <a class="home-action" href="/">Return to overview →</a>
</section>

<style>
  .not-found {
    min-height: 0;
    width: 100%;
    max-width: none;
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: 0;
  }

  .not-found h1 { max-width: 700px; }
  .not-found .lead { max-width: 580px; margin: 18px 0 28px; }
  .home-action {
    display: inline-block;
    width: auto;
    padding: 11px 15px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 700;
    text-decoration: none;
  }

  .home-action:hover { border-color: var(--accent-ink); }
</style>
