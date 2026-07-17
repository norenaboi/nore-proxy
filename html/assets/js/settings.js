// ── Auth helpers ────────────────────────────────────────────────
// ── Toast ────────────────────────────────────────────────────────
function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    const icon = document.getElementById("toastIcon");
    const text = document.getElementById("toastText");
    icon.className =
        type === "success"
            ? "fa-solid fa-circle-check"
            : "fa-solid fa-circle-exclamation";
    text.textContent = message;
    toast.className = `toast show ${type}`;
    setTimeout(() => {
        toast.className = "toast";
    }, 3500);
}

// ── In-memory settings snapshot ──────────────────────────────────
let settings = {};

// ── Render ───────────────────────────────────────────────────────
function renderSettings(s) {
    settings = { ...s };
    renderKeyDefaults(s);
    renderKeyFailover(s);
    renderEndpointDefaults(s);
}

function renderKeyFailover(s) {
    const body = document.getElementById("keyFailoverBody");
    body.innerHTML = `
    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Key Hop Attempts</div>
            <div class="setting-description">
                When an upstream key returns an actionable error (400/401/402/429), how many
                extra keys a single request may try before giving up. 0 disables hopping.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper">
                <input type="number" class="number-input" id="keyHopAttempts"
                       min="0" step="1" placeholder="1"
                       value="${s.keyHopAttempts}">
            </div>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Key Timeout Hours</div>
            <div class="setting-description">
                How long a rate-limited (429) key stays timed out before it auto-recovers.
                Keys hit with 400/401/402 are disabled until reset manually.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper">
                <input type="number" class="number-input" id="keyTimeoutHours"
                       min="1" step="1" placeholder="24"
                       value="${s.keyTimeoutHours}">
            </div>
        </div>
    </div>
    `;
}

function renderKeyDefaults(s) {
    const body = document.getElementById("keyDefaultsBody");
    body.innerHTML = `
    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default RPD</div>
            <div class="setting-description">
                Requests per day limit applied to new API keys. 0 is not allowed.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper">
                <input type="number" class="number-input" id="rpdDefault"
                       min="1" step="1" placeholder="500"
                       value="${s.rpdDefault}">
            </div>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default RPM</div>
            <div class="setting-description">
                Requests per minute limit applied to new API keys. 0 is not allowed.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper">
                <input type="number" class="number-input" id="rpmDefault"
                       min="1" step="1" placeholder="10"
                       value="${s.rpmDefault}">
            </div>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default Max Context Size</div>
            <div class="setting-description">
                Maximum context size in tokens applied to new API keys. 0 means unlimited.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper">
                <input type="number" class="number-input" id="maxContextSizeDefault"
                       min="0" step="1" placeholder="0"
                       value="${s.maxContextSizeDefault}">
            </div>
        </div>
    </div>
    `;
}

function renderEndpointDefaults(s) {
    const body = document.getElementById("endpointDefaultsBody");
    body.innerHTML = `
    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default API Format</div>
            <div class="setting-description">
                Pre-selected API format for newly created endpoints.
            </div>
        </div>
        <div class="setting-control" style="min-width:180px;">
            <select id="defaultEndpointApiFormat" class="form-select">
                <option value="openai" ${!s.defaultEndpointApiFormat || s.defaultEndpointApiFormat === 'openai' ? 'selected' : ''}>OpenAI — /v1/chat/completions</option>
                <option value="anthropic" ${s.defaultEndpointApiFormat === 'anthropic' ? 'selected' : ''}>Anthropic — /v1/messages</option>
                <option value="gemini" ${s.defaultEndpointApiFormat === 'gemini' ? 'selected' : ''}>Gemini — /v1beta/generateContent</option>
                <option value="openai-responses" ${s.defaultEndpointApiFormat === 'openai-responses' ? 'selected' : ''}>OpenAI Responses — /v1/responses</option>
                <option value="openai-codex" ${s.defaultEndpointApiFormat === 'openai-codex' ? 'selected' : ''}>OpenAI Codex — /v1/responses</option>
            </select>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default Key Rotation</div>
            <div class="setting-description">
                Rotation mode seeded onto new endpoints. Sticky reuses one key until it
                fails; round-robin cycles through healthy keys per request.
            </div>
        </div>
        <div class="setting-control" style="min-width:180px;">
            <select id="defaultEndpointKeyRotation" class="form-select">
                <option value="sticky" ${s.defaultEndpointKeyRotation === 'sticky' ? 'selected' : ''}>Sticky</option>
                <option value="roundrobin" ${s.defaultEndpointKeyRotation === 'roundrobin' ? 'selected' : ''}>Round-robin</option>
            </select>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default Key Health</div>
            <div class="setting-description">
                Seeded onto new endpoints. On benches a key on a 400/401/402 (invalid) or
                429 (timeout for the configured window). Off never benches a key — requests
                still hop to the next one, but a momentarily rate-limited key is not parked.
                Turn off for RPM/TPM endpoints whose limits clear in seconds.
            </div>
        </div>
        <div class="setting-control" style="min-width:180px;">
            <select id="defaultEndpointKeyHealth" class="form-select">
                <option value="true" ${s.defaultEndpointKeyHealth !== false ? 'selected' : ''}>On</option>
                <option value="false" ${s.defaultEndpointKeyHealth === false ? 'selected' : ''}>Off</option>
            </select>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default Temperature</div>
            <div class="setting-description">
                Seeds new endpoints: blank passes the client value through; a value overrides it.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper" style="gap:12px;">
                <label class="toggle" title="Enable default temperature">
                    <input type="checkbox" id="defaultEndpointTemperatureEnabled"
                           ${s.defaultEndpointTemperatureEnabled ? "checked" : ""}
                           onchange="onEndpointDefaultToggle('Temperature')">
                    <div class="toggle-track"></div>
                    <div class="toggle-thumb"></div>
                </label>
                <input type="number" class="number-input" id="defaultEndpointTemperature"
                       step="0.1" min="0" max="2" placeholder="1"
                       value="${s.defaultEndpointTemperature ?? ''}"
                       ${s.defaultEndpointTemperatureEnabled ? "" : "disabled"}>
            </div>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default Top P</div>
            <div class="setting-description">
                Seeds new endpoints: blank passes the client value through; a value overrides it.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper" style="gap:12px;">
                <label class="toggle" title="Enable default top P">
                    <input type="checkbox" id="defaultEndpointTopPEnabled"
                           ${s.defaultEndpointTopPEnabled ? "checked" : ""}
                           onchange="onEndpointDefaultToggle('TopP')">
                    <div class="toggle-track"></div>
                    <div class="toggle-thumb"></div>
                </label>
                <input type="number" class="number-input" id="defaultEndpointTopP"
                       step="0.05" min="0" max="1" placeholder="1"
                       value="${s.defaultEndpointTopP ?? ''}"
                       ${s.defaultEndpointTopPEnabled ? "" : "disabled"}>
            </div>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default Max Tokens</div>
            <div class="setting-description">
                Seeds new endpoints: blank passes the client value through; a value overrides it.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper" style="gap:12px;">
                <label class="toggle" title="Enable default max tokens">
                    <input type="checkbox" id="defaultEndpointMaxTokensEnabled"
                           ${s.defaultEndpointMaxTokensEnabled ? "checked" : ""}
                           onchange="onEndpointDefaultToggle('MaxTokens')">
                    <div class="toggle-track"></div>
                    <div class="toggle-thumb"></div>
                </label>
                <input type="number" class="number-input" id="defaultEndpointMaxTokens"
                       step="1" min="1" placeholder="4096"
                       value="${s.defaultEndpointMaxTokens ?? ''}"
                       ${s.defaultEndpointMaxTokensEnabled ? "" : "disabled"}>
            </div>
        </div>
    </div>

    <div class="setting-row">
        <div class="setting-info">
            <div class="setting-label">Default Prompt Caching for Claude</div>
            <div class="setting-description">
                When enabled, new endpoints will have prompt caching turned on with the specified cache depth.
                Caching only applies to Claude models and can still be disabled per request with
                <code style="background:var(--gray-100);padding:1px 5px;border-radius:4px;font-size:12px;">cache_depth: -1</code>.
            </div>
        </div>
        <div class="setting-control">
            <div class="number-input-wrapper" style="gap:12px;">
                <label class="toggle" title="Enable default prompt caching for Claude">
                    <input type="checkbox" id="defaultEndpointPromptCachingEnabled"
                           ${s.defaultEndpointPromptCachingEnabled ? "checked" : ""}
                           onchange="onEndpointDefaultToggle('PromptCaching')">
                    <div class="toggle-track"></div>
                    <div class="toggle-thumb"></div>
                </label>
                <input type="number" class="number-input" id="defaultEndpointPromptCachingDepth"
                       min="0" max="100" step="1" placeholder="2"
                       value="${s.defaultEndpointPromptCachingDepth}"
                       ${s.defaultEndpointPromptCachingEnabled ? "" : "disabled"}>
            </div>
        </div>
    </div>
`;
}

function onEndpointDefaultToggle(param) {
    const enabled = document.getElementById(`defaultEndpoint${param}Enabled`).checked;
    const input = document.getElementById(`defaultEndpoint${param}`);
    input.disabled = !enabled;
    if (enabled) {
        input.focus();
    }
}

// ── Load ─────────────────────────────────────────────────────────
async function loadSettings() {
    try {
        const res = await fetch("/api/settings");

        if (res.status === 401 || res.status === 403) {
            logout();
            return;
        }
        if (!res.ok) throw new Error("Failed to load settings");

        const data = await res.json();
        renderSettings(data.settings);
    } catch (err) {
        showToast(
            "Error loading settings: " + err.message,
            "error",
        );
    }
}

// ── Save ─────────────────────────────────────────────────────────
async function saveSettings() {
    const saveBtn = document.getElementById("saveBtn");

    const rpdDefault = parseInt(document.getElementById("rpdDefault").value, 10);
    const rpmDefault = parseInt(document.getElementById("rpmDefault").value, 10);
    const maxContextSizeDefault = parseInt(document.getElementById("maxContextSizeDefault").value, 10);

    if (isNaN(rpdDefault) || rpdDefault < 1) {
        showToast("RPD default must be at least 1", "error");
        return;
    }
    if (isNaN(rpmDefault) || rpmDefault < 1) {
        showToast("RPM default must be at least 1", "error");
        return;
    }
    if (isNaN(maxContextSizeDefault) || maxContextSizeDefault < 0) {
        showToast("Max context size default must be 0 or higher", "error");
        return;
    }

    const keyHopAttempts = parseInt(document.getElementById("keyHopAttempts").value, 10);
    const keyTimeoutHours = parseInt(document.getElementById("keyTimeoutHours").value, 10);

    if (isNaN(keyHopAttempts) || keyHopAttempts < 0) {
        showToast("Key hop attempts must be 0 or higher", "error");
        return;
    }
    if (isNaN(keyTimeoutHours) || keyTimeoutHours < 1) {
        showToast("Key timeout hours must be at least 1", "error");
        return;
    }

    const keyRotation = document.getElementById("defaultEndpointKeyRotation").value;
    const keyHealth = document.getElementById("defaultEndpointKeyHealth").value === "true";

    const apiFormat = document.getElementById("defaultEndpointApiFormat").value;
    const tempEnabled = document.getElementById("defaultEndpointTemperatureEnabled").checked;
    const tempRaw = document.getElementById("defaultEndpointTemperature").value.trim();
    const temp = tempRaw === "" ? null : parseFloat(tempRaw);
    const topPEnabled = document.getElementById("defaultEndpointTopPEnabled").checked;
    const topPRaw = document.getElementById("defaultEndpointTopP").value.trim();
    const topP = topPRaw === "" ? null : parseFloat(topPRaw);
    const maxTokensEnabled = document.getElementById("defaultEndpointMaxTokensEnabled").checked;
    const maxTokensRaw = document.getElementById("defaultEndpointMaxTokens").value.trim();
    const maxTokens = maxTokensRaw === "" ? null : parseInt(maxTokensRaw, 10);
    const promptCachingEnabled = document.getElementById("defaultEndpointPromptCachingEnabled").checked;
    const promptCachingDepth = parseInt(document.getElementById("defaultEndpointPromptCachingDepth").value, 10);

    if (tempEnabled && temp !== null && (isNaN(temp) || temp < 0 || temp > 2)) {
        showToast("Temperature must be between 0 and 2", "error");
        return;
    }
    if (topPEnabled && topP !== null && (isNaN(topP) || topP < 0 || topP > 1)) {
        showToast("Top P must be between 0 and 1", "error");
        return;
    }
    if (maxTokensEnabled && maxTokens !== null && (isNaN(maxTokens) || maxTokens < 1)) {
        showToast("Max tokens must be at least 1", "error");
        return;
    }
    if (promptCachingEnabled && (isNaN(promptCachingDepth) || promptCachingDepth < 0)) {
        showToast("Cache depth must be a non-negative integer", "error");
        return;
    }

    saveBtn.disabled = true;
    saveBtn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        const res = await fetch("/api/settings", {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                rpdDefault,
                rpmDefault,
                maxContextSizeDefault,
                keyHopAttempts,
                keyTimeoutHours,
                defaultEndpointKeyRotation: keyRotation,
                defaultEndpointKeyHealth: keyHealth,
                defaultEndpointApiFormat: apiFormat,
                defaultEndpointTemperatureEnabled: tempEnabled,
                defaultEndpointTemperature: temp,
                defaultEndpointTopPEnabled: topPEnabled,
                defaultEndpointTopP: topP,
                defaultEndpointMaxTokensEnabled: maxTokensEnabled,
                defaultEndpointMaxTokens: maxTokens,
                defaultEndpointPromptCachingEnabled: promptCachingEnabled,
                defaultEndpointPromptCachingDepth: promptCachingDepth,
            }),
        });

        if (res.status === 401 || res.status === 403) {
            logout();
            return;
        }

        const data = await res.json();
        if (!res.ok)
            throw new Error(
                data.error || "Failed to save settings",
            );

        showToast("Settings saved successfully!", "success");
        renderSettings(data.settings);
    } catch (err) {
        showToast("Error saving settings: " + err.message, "error");
    } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML =
            '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
    }
}

// ── Init ─────────────────────────────────────────────────────────
loadSettings();
