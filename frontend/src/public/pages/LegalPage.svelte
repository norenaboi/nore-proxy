<script lang="ts">
  let { kind }: { kind: "terms" | "privacy" } = $props();

  const terms = [
    ["Acceptable use", "Use the service only for lawful, authorized purposes. Do not use it to harm others, interfere with service operation, bypass access controls, or violate an upstream provider’s terms."],
    ["API keys and access", "You are responsible for protecting keys issued to you and for activity performed with them. Do not share credentials publicly, and report suspected compromise promptly."],
    ["Availability and changes", "The service and its available models may change, be rate limited, or become temporarily unavailable. Access may be suspended when needed to protect the service, its users, or upstream providers."],
    ["No warranty", "The service is provided on an “as is” and “as available” basis. Model output may be incomplete or inaccurate and should be independently reviewed before consequential use."],
    ["Responsibility", "To the extent permitted by law, the service operator is not responsible for indirect or consequential loss arising from use of the service or reliance on model output."],
  ];
  const privacy = [
    ["Prompt content", "Prompts and generated responses pass through the proxy so requests can be served, but their content is not persisted in request logs."],
    ["Operational metadata", "We retain metadata needed to operate and understand the service. This can include timestamps, model and internal or masked key identity, request status and duration, plus input, output, cache-read, and cache-write token counts."],
    ["Errors and security", "Diagnostic records may include upstream status, endpoint information, sanitized request headers, and truncated error responses. Authorization values and raw API keys are removed or masked before storage."],
    ["Upstream processing", "Requests are forwarded to the selected upstream model provider. That provider processes request content under its own terms and privacy practices."],
  ];

  const isTerms = $derived(kind === "terms");
  const title = $derived(isTerms ? "Terms of Service" : "Privacy Policy");
  const lead = $derived(isTerms ? "General terms for using the Nore Proxy service." : "A plain-language summary of what the proxy processes and retains.");
  const sections = $derived(isTerms ? terms : privacy);
</script>

<div class="legal-main">
  <p class="eyebrow">Legal</p>
  <h1>{title}</h1>
  <p class="lead">{lead}</p>
  <article class="legal-copy panel">
    {#each sections as section}
      <section><h2>{section[0]}</h2><p>{section[1]}</p></section>
    {/each}
  </article>
</div>

<style>
  .legal-main {
    width: min(780px, 100%);
    max-width: none;
    margin: 0 auto;
  }

  .legal-main > .lead { margin-bottom: 0; }

  .legal-copy {
    display: grid;
    gap: 20px;
    margin-top: 36px;
    padding: 32px;
    overflow: visible;
  }

  .legal-copy section {
    padding: 0 0 20px;
    border-bottom: 1px solid var(--line);
  }

  .legal-copy section:last-child { padding-bottom: 0; border-bottom: 0; }
  .legal-copy h2 { margin: 0 0 8px; font: 500 25px/1.2 Georgia, serif; }
  .legal-copy p { margin: 0; color: var(--muted); font-size: inherit; line-height: inherit; }

  @media (max-width: 700px) {
    .legal-copy { padding: 24px; }
  }
</style>
