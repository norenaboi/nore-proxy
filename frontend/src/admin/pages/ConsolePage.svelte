<script lang="ts">
  import { onMount } from "svelte";
  import { requestAdminJson } from "$frontend/lib/api/admin";

  interface LogEntry { timestamp: string; level: string; message: string; }

  let logs = $state<LogEntry[]>([]);
  let connected = $state(false);
  let terminal: HTMLElement;
  let es: EventSource | undefined;

  function addLog(log: LogEntry) {
    logs = [...logs.slice(-499), log];
    setTimeout(() => { terminal?.scrollTo(0, terminal.scrollHeight); }, 0);
  }

  function connect() {
    es?.close();
    es = new EventSource("/api/logs/stream");
    es.onopen = () => { connected = true; };
    es.onerror = () => { connected = false; };
    es.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string) as { type: string; logs?: LogEntry[]; log?: LogEntry };
      if (data.type === "initial") {
        logs = (data.logs ?? []).slice(-500);
        setTimeout(() => { terminal?.scrollTo(0, terminal.scrollHeight); }, 0);
      } else if (data.type === "log" && data.log) { addLog(data.log); }
    };
  }

  async function clearLogs() {
    try {
      await requestAdminJson("/api/logs/clear", { method: "POST" });
      logs = [];
    } catch (error) {
      if (error instanceof Error && error.message === "Session expired") return;
      window.alert(error instanceof Error ? error.message : "Could not clear logs.");
    }
  }

  function fmtTime(ts: string) { return new Date(ts).toLocaleTimeString(); }

  onMount(() => {
    connect();
    return () => es?.close();
  });
</script>

<section class="controls-section">
  <div class="controls">
    <div class="status">
      <span class="status-dot" class:connected></span>
      <span>{connected ? "Connected" : "Disconnected"}</span>
    </div>
    <div class="control-actions">
      <button class="btn btn-secondary" type="button" onclick={connect}>
        <i class="fa-solid fa-rotate"></i> Reconnect
      </button>
      <button class="btn btn-danger" type="button" onclick={clearLogs}>
        <i class="fa-solid fa-trash"></i> Clear Logs
      </button>
    </div>
  </div>
</section>

<section class="logs-container">
  <div class="logs-header">
    <span><i class="fa-solid fa-terminal"></i> Real-time Server Output</span>
  </div>
  <div class="logs-terminal" bind:this={terminal}>
    {#each logs as log}
      <div class="log-entry">
        <span class="log-time">{fmtTime(log.timestamp)}</span>
        <span class="log-level {log.level}">{log.level}</span>
        <span class="log-message">{log.message}</span>
      </div>
    {/each}
    {#if logs.length === 0}
      <div class="empty-terminal">No log entries yet.</div>
    {/if}
  </div>
</section>

<style>
  .controls-section { margin-bottom: 24px; padding: 18px; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .status { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 10px; color: var(--text-primary); font-size: .9rem; }
  .status-dot { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 50%; background: var(--danger); }
  .status-dot.connected { background: var(--success); box-shadow: 0 0 10px var(--success-alpha-01); }
  .control-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; padding: 10px 16px; border: 1px solid transparent; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 650; }
  .btn-secondary { border-color: var(--border-color); background: var(--bg-secondary); color: var(--primary-dark); }
  .btn-danger { border-color: var(--danger); background: var(--danger); color: white; }
  .logs-container { --terminal-bg: #19151e; --terminal-header: #231d2a; --terminal-text: #eee8f3; --terminal-muted: #a99bb5; --terminal-border: #403449; display: flex; flex: 1; min-height: 0; overflow: hidden; flex-direction: column; border: 1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); }
  .logs-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-color); background: transparent; color: var(--text-primary); }
  .logs-header span { display: inline-flex; align-items: center; gap: 9px; font-family: Georgia, "Times New Roman", serif; font-weight: 500; }
  .logs-terminal { height: 600px; min-height: 360px; overflow-y: auto; padding: 20px; background: var(--terminal-bg); color: var(--terminal-text); font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 13px; line-height: 1.6; }
  .log-entry { display: flex; gap: 12px; margin-bottom: 8px; padding: 8px 12px; border-radius: 8px; animation: fadeIn .2s ease; word-break: break-word; }
  .log-entry:hover { background: rgba(255,255,255,.04); }
  .log-time { flex-shrink: 0; color: var(--terminal-muted); white-space: nowrap; }
  .log-level { min-width: 60px; flex-shrink: 0; font-weight: 700; text-transform: uppercase; }
  .log-level.info { color: #60a5fa; }
  .log-level.warn { color: var(--warning); }
  .log-level.error { color: var(--danger); }
  .log-level.debug { color: #a78bfa; }
  .log-message { flex: 1; color: var(--terminal-text); white-space: pre-wrap; }
  .empty-terminal { padding: 8px 12px; color: var(--terminal-muted); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 560px) {
    .control-actions { width: 100%; }
    .control-actions .btn { flex: 1; }
    .logs-terminal { height: 520px; padding: 12px; }
    .log-entry { display: grid; grid-template-columns: auto 1fr; padding: 7px 4px; }
    .log-message { grid-column: 1 / -1; }
  }
</style>
