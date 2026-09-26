<script lang="ts">
  import { onDestroy } from "svelte";

  const deploymentUrl = typeof window === "undefined" ? "https://your-nore-proxy.example" : window.location.origin;

  const quickStart = `export NORE_PROXY_API_KEY="your-client-api-key"

curl "${deploymentUrl}/v1/chat/completions" \\
  -H "Authorization: Bearer $NORE_PROXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "your-model-id",
    "messages": [
      { "role": "user", "content": "Explain why the sky is blue." }
    ]
  }'`;

  const chatRequest = `curl "${deploymentUrl}/v1/chat/completions" \\
  -H "Authorization: Bearer $NORE_PROXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "your-model-id",
    "messages": [
      { "role": "system", "content": "You are a concise assistant." },
      { "role": "user", "content": "Give me three launch checklist items." }
    ],
    "temperature": 0.7,
    "max_tokens": 300
  }'`;

  const chatResponse = `{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "your-model-id",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "…" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 38,
    "total_tokens": 62
  }
}`;

  const messagesRequest = `curl "${deploymentUrl}/v1/messages" \\
  -H "Authorization: Bearer $NORE_PROXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "your-model-id",
    "system": "You are a concise assistant.",
    "messages": [
      { "role": "user", "content": "Give me three launch checklist items." }
    ],
    "max_tokens": 300
  }'`;

  const messagesResponse = `{
  "id": "msg_…",
  "type": "message",
  "role": "assistant",
  "model": "your-model-id",
  "content": [
    { "type": "text", "text": "…" }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 24,
    "output_tokens": 38
  }
}`;

  const imageRequest = `curl "${deploymentUrl}/v1/images" \\
  -H "Authorization: Bearer $NORE_PROXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "your-image-model-id",
    "prompt": "A quiet observatory above a sea of clouds",
    "n": 1
  }'`;

  const imageResponse = `{
  "created": 1760000000,
  "data": [
    { "b64_json": "…" }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 0,
    "total_tokens": 12
  }
}`;

  let copyMessage = $state("");
  let copyError = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copySnippet(label: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copyMessage = `${label} copied to clipboard.`;
      copyError = false;
    } catch {
      copyMessage = `Could not copy ${label.toLowerCase()}. Select the code and copy it manually.`;
      copyError = true;
    }

    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyMessage = "";
      copyError = false;
    }, 3000);
  }

  onDestroy(() => {
    if (copyTimer) clearTimeout(copyTimer);
  });
</script>

<div class="docs-layout">
  <aside class="docs-sidebar" aria-label="Documentation navigation">
    <div class="docs-sidebar-inner">
      <p class="docs-label">Documentation</p>
      <nav>
        <div class="nav-group">
          <span>Getting started</span>
          <a href="#overview">Overview</a>
          <a href="#quick-start">Quick start</a>
        </div>
        <div class="nav-group">
          <span>API reference</span>
          <a href="#chat-completions">Chat completions</a>
          <a href="#messages">Messages</a>
          <a href="#responses">Responses</a>
          <a href="#images">Images</a>
        </div>
        <div class="nav-group">
          <span>Resources</span>
          <a href="/models">Model catalog <i aria-hidden="true">↗</i></a>
          <a href="/playground">Playground <i aria-hidden="true">↗</i></a>
        </div>
      </nav>
    </div>
  </aside>

  <article class="docs-content">
    <header class="docs-hero" id="overview">
      <div class="hero-kicker"><span>API docs</span><b>Prototype</b></div>
      <h1>Build with Nore Proxy</h1>
      <p>Connect one client interface to the text and image models configured by your Nore Proxy operator.</p>
      <div class="hero-actions">
        <a class="primary-action" href="#quick-start">Make your first request</a>
        <a class="secondary-action" href="/models">Explore models</a>
      </div>
    </header>

    <section id="quick-start">
      <div class="section-heading">
        <span class="step">01</span>
        <div>
          <p class="section-kicker">Getting started</p>
          <h2>Quick start</h2>
        </div>
      </div>
      <p>The example below automatically uses this deployment's origin, <code>{deploymentUrl}</code>. Set your client API key, then choose an exact model ID from the <a href="/models">model catalog</a>. Your model must be enabled and available to the supplied key.</p>

      <div class="code-panel">
        <div class="code-header">
          <div><span class="terminal-dot"></span><span>cURL</span></div>
          <button type="button" aria-label="Copy quick start example" onclick={() => void copySnippet("Quick start", quickStart)}>Copy</button>
        </div>
        <pre><code>{quickStart}</code></pre>
      </div>
    </section>

    <div class="reference-divider"><span>API reference</span></div>

    <section id="chat-completions" class="endpoint-section">
      <div class="endpoint-heading">
        <div>
          <div class="endpoint-line"><span class="method">POST</span><code>/v1/chat/completions</code></div>
          <h2>Chat completions</h2>
        </div>
        <span class="status supported"><i></i>Supported</span>
      </div>
      <p>Send an OpenAI-compatible conversation to any configured text model. The proxy translates the request for the selected upstream and normalizes its response.</p>

      <h3>Request body</h3>
      <div class="parameter-list">
        <div><code>model</code><span class="required">required</span><p>The exact text model identifier. Browse currently available IDs on the <a href="/models">Models page</a>.</p></div>
        <div><code>messages</code><span class="required">required</span><p>An ordered array of role and content messages.</p></div>
        <div><code>stream</code><span>boolean</span><p>Set to <code>true</code> to receive Server-Sent Events ending with <code>[DONE]</code>.</p></div>
        <div><code>temperature</code><span>number</span><p>Controls sampling when supported by the selected endpoint policy and upstream.</p></div>
        <div><code>max_tokens</code><span>number</span><p>Limits generated tokens when supported by the selected endpoint policy and upstream.</p></div>
      </div>

      <div class="code-panel">
        <div class="code-header">
          <div><span class="terminal-dot"></span><span>Request</span></div>
          <button type="button" aria-label="Copy chat completions request" onclick={() => void copySnippet("Chat request", chatRequest)}>Copy</button>
        </div>
        <pre><code>{chatRequest}</code></pre>
      </div>

      <h3>Response</h3>
      <div class="code-panel">
        <div class="code-header">
          <div><span class="terminal-dot purple"></span><span>200 · application/json</span></div>
          <button type="button" aria-label="Copy chat completions response" onclick={() => void copySnippet("Chat response", chatResponse)}>Copy</button>
        </div>
        <pre><code>{chatResponse}</code></pre>
      </div>

      <div class="callout note">
        <span class="callout-icon" aria-hidden="true">↯</span>
        <div><strong>Streaming</strong><p>Text routes can stream. Add <code>"stream": true</code> to receive SSE chunks. Image models and embedding models must use their matching client routes.</p></div>
      </div>
    </section>

    <section id="messages" class="endpoint-section">
      <div class="endpoint-heading">
        <div>
          <div class="endpoint-line"><span class="method">POST</span><code>/v1/messages</code></div>
          <h2>Messages</h2>
        </div>
        <span class="status supported"><i></i>Supported</span>
      </div>
      <p>Send an Anthropic-compatible Messages API request to any configured text model. Nore Proxy forwards native Anthropic requests or translates them for other supported upstream formats, then returns an Anthropic-compatible response.</p>

      <h3>Request body</h3>
      <div class="parameter-list">
        <div><code>model</code><span class="required">required</span><p>The exact text model identifier. The selected model does not need to use an Anthropic upstream.</p></div>
        <div><code>messages</code><span class="required">required</span><p>An ordered array of Anthropic user and assistant messages. Text, image, tool-use, and tool-result content blocks are supported where compatible.</p></div>
        <div><code>max_tokens</code><span class="required">required</span><p>The maximum number of tokens to generate.</p></div>
        <div><code>system</code><span>string · array</span><p>A system prompt supplied separately from the conversation messages.</p></div>
        <div><code>stream</code><span>boolean</span><p>Set to <code>true</code> to receive Anthropic-style Server-Sent Events.</p></div>
        <div><code>temperature</code><span>number</span><p>Controls sampling when supported by the selected endpoint policy and upstream.</p></div>
      </div>

      <div class="code-panel">
        <div class="code-header">
          <div><span class="terminal-dot"></span><span>Request</span></div>
          <button type="button" aria-label="Copy Messages API request" onclick={() => void copySnippet("Messages request", messagesRequest)}>Copy</button>
        </div>
        <pre><code>{messagesRequest}</code></pre>
      </div>

      <h3>Response</h3>
      <div class="code-panel">
        <div class="code-header">
          <div><span class="terminal-dot purple"></span><span>200 · application/json</span></div>
          <button type="button" aria-label="Copy Messages API response" onclick={() => void copySnippet("Messages response", messagesResponse)}>Copy</button>
        </div>
        <pre><code>{messagesResponse}</code></pre>
      </div>

      <div class="callout note">
        <span class="callout-icon" aria-hidden="true">↯</span>
        <div><strong>Anthropic-compatible streaming</strong><p>Add <code>"stream": true</code> to receive events such as <code>message_start</code>, content block deltas, <code>message_delta</code>, and <code>message_stop</code>.</p></div>
      </div>
    </section>

    <section id="responses" class="endpoint-section">
      <div class="endpoint-heading">
        <div>
          <div class="endpoint-line muted"><span class="method unavailable">POST</span><code>/v1/responses</code></div>
          <h2>Responses</h2>
        </div>
        <span class="status not-exposed">Coming soon</span>
      </div>
      <p>The OpenAI-compatible Responses API is not available as a client route yet. It will be implemented soon. In the meantime, use <a href="#chat-completions"><code>/v1/chat/completions</code></a> or the Anthropic-compatible <a href="#messages"><code>/v1/messages</code></a> route.</p>
    </section>

    <section id="images" class="endpoint-section">
      <div class="endpoint-heading">
        <div>
          <div class="endpoint-line"><span class="method">POST</span><code>/v1/images</code></div>
          <h2>Images</h2>
        </div>
        <span class="status supported"><i></i>Supported</span>
      </div>
      <p>Generate images with any configured image model. Image requests are one-shot and never stream.</p>

      <h3>Request body</h3>
      <div class="parameter-list">
        <div><code>model</code><span class="required">required</span><p>The exact identifier of a configured image model.</p></div>
        <div><code>prompt</code><span class="required">required</span><p>A non-empty description of the image to generate.</p></div>
        <div><code>n</code><span>number</span><p>The requested image count when supported by the selected model.</p></div>
        <div><code>provider fields</code><span>varies</span><p>Compatible options such as aspect ratio, quality, output format, or references depend on the configured upstream.</p></div>
      </div>

      <div class="code-panel">
        <div class="code-header">
          <div><span class="terminal-dot"></span><span>Request</span></div>
          <button type="button" aria-label="Copy image request" onclick={() => void copySnippet("Image request", imageRequest)}>Copy</button>
        </div>
        <pre><code>{imageRequest}</code></pre>
      </div>

      <h3>Response</h3>
      <div class="code-panel">
        <div class="code-header">
          <div><span class="terminal-dot purple"></span><span>200 · application/json</span></div>
          <button type="button" aria-label="Copy image response" onclick={() => void copySnippet("Image response", imageResponse)}>Copy</button>
        </div>
        <pre><code>{imageResponse}</code></pre>
      </div>
      <p class="compatibility-note"><strong>SDK compatibility:</strong> <code>POST /v1/images/generations</code> reaches the same image handler for OpenAI SDK-style clients. Response items contain either <code>b64_json</code> or <code>url</code>; usage is included when available.</p>
    </section>

    <section id="resources" class="related-section">
      <p class="section-kicker">Keep exploring</p>
      <h2>Related resources</h2>
      <div class="resource-grid">
        <a href="/models"><span>Catalog</span><strong>Pricing</strong><p>Find an available model ID and compare pricing.</p><b>View pricing →</b></a>
        <a href="/playground"><span>Test</span><strong>Playground</strong><p>Try text and image models from the browser.</p><b>Open playground →</b></a>
        <a href="/status"><span>Health</span><strong>Status</strong><p>Review current service health and availability.</p><b>View status →</b></a>
        <a href="/account"><span>Usage</span><strong>Console</strong><p>Inspect quota, costs, and request history.</p><b>Open console →</b></a>
      </div>
    </section>
  </article>

  <aside class="page-toc">
    <nav aria-label="On this page">
      <span>On this page</span>
      <a href="#quick-start">Quick start</a>
      <a href="#chat-completions">Chat completions</a>
      <a href="#messages">Messages</a>
      <a href="#responses">Responses</a>
      <a href="#images">Images</a>
      <a href="#resources">Related resources</a>
    </nav>
  </aside>
</div>

<div class:error={copyError} class:show={copyMessage} class="docs-copy-status" role="status" aria-live="polite">
  {copyMessage}
</div>

<style>
  :global(.public-main.wide-main:has(.docs-layout)) {
    width: min(1480px, calc(100% - 48px));
    padding-top: 34px;
  }

  .docs-layout {
    display: grid;
    grid-template-columns: 210px minmax(0, 780px) 180px;
    gap: clamp(30px, 4vw, 64px);
    justify-content: center;
    align-items: start;
  }

  .docs-sidebar-inner,
  .page-toc nav {
    position: sticky;
    top: 28px;
  }

  .docs-label,
  .nav-group > span,
  .page-toc nav > span,
  .section-kicker,
  .resource-grid a > span {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
  }

  .docs-label { margin: 0 0 24px; color: var(--ink); }
  .docs-sidebar nav { display: grid; gap: 26px; }
  .nav-group { display: grid; gap: 4px; }
  .nav-group > span { margin-bottom: 6px; color: var(--muted); }
  .nav-group a,
  .page-toc a {
    padding: 6px 0;
    color: var(--muted);
    text-decoration: none;
    transition: color .14s;
  }
  .nav-group a:hover,
  .page-toc a:hover { color: var(--accent-ink); }
  .nav-group i { font-style: normal; }

  .docs-content { min-width: 0; }
  .docs-content section,
  .docs-hero { scroll-margin-top: 24px; }

  .docs-hero {
    padding: clamp(28px, 5vw, 54px);
    border: 1px solid var(--line);
    border-radius: 16px;
    background:
      radial-gradient(circle at 88% 12%, color-mix(in srgb, var(--accent) 18%, transparent) 0, transparent 34%),
      linear-gradient(145deg, var(--surface-raised), var(--surface));
    box-shadow: var(--shadow-sm);
  }

  .hero-kicker { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
  .hero-kicker span { color: var(--accent-ink); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; }
  .hero-kicker b { padding: 3px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
  .docs-hero h1 { max-width: 600px; font: 650 clamp(38px, 6vw, 64px)/.98 Inter, sans-serif; letter-spacing: -.055em; }
  .docs-hero p { max-width: 600px; margin: 20px 0 0; color: var(--ink-soft); font-size: 17px; line-height: 1.7; }
  .hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 30px; }
  .hero-actions a { padding: 10px 14px; border-radius: 8px; font-weight: 600; text-decoration: none; }
  .primary-action { background: var(--accent); color: var(--on-accent); }
  .primary-action:hover { background: var(--accent-hover); }
  .secondary-action { border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
  .secondary-action:hover { border-color: var(--accent-ink); }

  .docs-content > section { padding: 72px 0; border-bottom: 1px solid var(--line); }
  .docs-content > section:last-child { border-bottom: 0; }
  .docs-content h2 { margin: 0; font: 650 30px/1.15 Inter, sans-serif; letter-spacing: -.035em; }
  .docs-content h3 { margin: 34px 0 13px; font-size: 15px; }
  .docs-content section > p { max-width: 700px; color: var(--ink-soft); font-size: 15px; line-height: 1.75; }
  .docs-content section a { color: var(--accent-ink); }
  .docs-content p code { padding: 2px 5px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface-muted); color: var(--ink); font-size: .88em; }

  .section-heading { display: flex; gap: 18px; align-items: start; margin-bottom: 20px; }
  .step { display: grid; place-items: center; width: 33px; height: 33px; flex: 0 0 33px; border: 1px solid var(--line); border-radius: 8px; color: var(--accent-ink); font: 700 10px ui-monospace, monospace; }
  .section-kicker { margin: 0 0 5px; color: var(--muted); }

  .code-panel { margin: 24px 0; overflow: hidden; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--code-bg); box-shadow: var(--shadow-sm); }
  .code-header { display: flex; align-items: center; justify-content: space-between; min-height: 43px; padding: 7px 9px 7px 15px; border-bottom: 1px solid color-mix(in srgb, var(--code-ink) 15%, transparent); color: color-mix(in srgb, var(--code-ink) 70%, transparent); font-size: 11px; }
  .code-header > div { display: flex; align-items: center; gap: 9px; }
  .terminal-dot { width: 7px; height: 7px; border-radius: 50%; background: #6ed4a5; box-shadow: 0 0 0 3px rgba(110, 212, 165, .12); }
  .terminal-dot.purple { background: #c6a6ea; box-shadow: 0 0 0 3px rgba(198, 166, 234, .12); }
  .code-header button { padding: 5px 9px; border: 1px solid color-mix(in srgb, var(--code-ink) 20%, transparent); border-radius: 6px; background: transparent; color: var(--code-ink); font-size: 10px; cursor: pointer; }
  .code-header button:hover { background: color-mix(in srgb, var(--code-ink) 8%, transparent); }
  pre { margin: 0; padding: 21px; overflow-x: auto; color: var(--code-ink); font: 12.5px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
  pre code { font: inherit; }

  .callout { display: grid; grid-template-columns: 28px 1fr; gap: 12px; margin: 24px 0 0; padding: 16px; border: 1px solid var(--line); border-radius: 9px; }
  .callout-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; font: 700 12px ui-monospace, monospace; }
  .callout strong { display: block; margin-bottom: 3px; }
  .callout p { margin: 0; color: var(--ink-soft); line-height: 1.6; }
  .callout.note { background: var(--accent-soft); }
  .callout.note .callout-icon { background: var(--accent); color: var(--on-accent); }

  .reference-divider { display: flex; align-items: center; gap: 14px; padding-top: 34px; color: var(--muted); }
  .reference-divider::before,
  .reference-divider::after { content: ""; height: 1px; flex: 1; background: var(--line); }
  .reference-divider span { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }

  .endpoint-heading { display: flex; align-items: start; justify-content: space-between; gap: 22px; margin-bottom: 20px; }
  .endpoint-line { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
  .endpoint-line > code { font-size: 12px; font-weight: 600; }
  .method { padding: 3px 6px; border-radius: 4px; background: var(--success-soft); color: var(--success); font: 800 9px ui-monospace, monospace; letter-spacing: .04em; }
  .method.unavailable { background: var(--surface-muted); color: var(--muted); }
  .endpoint-line.muted > code { color: var(--muted); }
  .status { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; font-size: 10px; font-weight: 700; }
  .status.supported { border-color: var(--success-line); background: var(--success-soft); color: var(--success); }
  .status.supported i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .status.not-exposed { background: var(--surface-muted); color: var(--muted); }

  .parameter-list { overflow: hidden; border: 1px solid var(--line); border-radius: 9px; }
  .parameter-list > div { display: grid; grid-template-columns: 130px 82px 1fr; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--line); align-items: baseline; }
  .parameter-list > div:last-child { border-bottom: 0; }
  .parameter-list code { font-size: 12px; font-weight: 650; }
  .parameter-list span { color: var(--muted); font: 10px ui-monospace, monospace; }
  .parameter-list span.required { color: var(--danger); }
  .parameter-list p { margin: 0; color: var(--ink-soft); font-size: 12.5px; line-height: 1.55; }
  .compatibility-note { margin-top: 22px; padding: 15px 17px; border-left: 3px solid var(--accent); background: var(--surface-muted); }

  .related-section h2 { margin-bottom: 22px; }
  .resource-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .resource-grid a { display: grid; padding: 18px; border: 1px solid var(--line); border-radius: 9px; color: inherit; text-decoration: none; transition: border-color .14s, transform .14s; }
  .resource-grid a:hover { border-color: var(--accent-ink); transform: translateY(-2px); }
  .resource-grid a > span { color: var(--muted); }
  .resource-grid strong { margin-top: 9px; font-size: 17px; }
  .resource-grid p { margin: 5px 0 16px; color: var(--muted); font-size: 12px; }
  .resource-grid b { margin-top: auto; color: var(--accent-ink); font-size: 11px; }

  .page-toc { min-width: 0; }
  .page-toc nav { display: grid; padding-left: 15px; border-left: 1px solid var(--line); }
  .page-toc nav > span { margin-bottom: 8px; color: var(--ink); }
  .page-toc a { padding: 5px 0; font-size: 11px; line-height: 1.4; }

  .docs-copy-status { position: fixed; bottom: 28px; left: 50%; z-index: 100; max-width: calc(100% - 32px); padding: 10px 16px; transform: translate(-50%, 100px); border: 1px solid var(--success-line); border-radius: 8px; background: var(--surface-raised); color: var(--success); box-shadow: var(--shadow-md); transition: transform .2s; }
  .docs-copy-status.show { transform: translate(-50%, 0); }
  .docs-copy-status.error { border-color: var(--danger-line); color: var(--danger); }

  @media (max-width: 1160px) {
    .docs-layout { grid-template-columns: 190px minmax(0, 780px); }
    .page-toc { display: none; }
  }

  @media (max-width: 760px) {
    :global(.public-main.wide-main:has(.docs-layout)) { padding-top: 22px; }
    .docs-layout { display: block; }
    .docs-sidebar { margin-bottom: 22px; padding: 14px; overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
    .docs-sidebar-inner { position: static; min-width: 570px; }
    .docs-label { margin-bottom: 10px; }
    .docs-sidebar nav { display: flex; gap: 30px; }
    .nav-group { display: flex; align-items: center; gap: 13px; }
    .nav-group > span { margin: 0; }
    .nav-group a { white-space: nowrap; }
    .docs-hero { padding: 28px 22px; }
    .docs-content > section { padding: 52px 0; }
    .endpoint-heading { display: grid; }
    .status { width: fit-content; }
    .parameter-list > div { grid-template-columns: 1fr auto; }
    .parameter-list p { grid-column: 1 / -1; }
  }

  @media (max-width: 520px) {
    .hero-actions { display: grid; }
    .hero-actions a { text-align: center; }
    .resource-grid { grid-template-columns: 1fr; }
    pre { padding: 17px; font-size: 11.5px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .nav-group a,
    .page-toc a,
    .resource-grid a,
    .docs-copy-status { transition: none; }
    .resource-grid a:hover { transform: none; }
  }
</style>
