// Show message
function showMessage(text, type = "success") {
    const messageEl = document.getElementById("message");
    messageEl.textContent = text;
    messageEl.className = `message ${type} show`;
    setTimeout(() => {
        messageEl.className = "message";
    }, 5000);
}

// Generate random API key
function generateKey() {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let key = "sk-";
    for (let i = 0; i < 48; i++) {
        key += chars.charAt(
            Math.floor(Math.random() * chars.length),
        );
    }
    document.getElementById("newApiKey").value = key;
}

// Load all keys
async function loadKeys() {
    try {
        const response = await fetch("/api/keys", {
            method: "GET",
        });

        if (!response.ok) {
            throw new Error("Failed to load keys");
        }

        const data = await response.json();
        renderKeysTable(data.keys);
    } catch (error) {
        showMessage(
            "Error loading keys: " + error.message,
            "error",
        );
    }
}

// Render keys table
function renderKeysTable(keys) {
    const container = document.getElementById("keysTableContainer");

    if (!keys || keys.length === 0) {
        container.innerHTML =
            '<p style="color: #6b7280; text-align: center; margin-block:70px;">No API keys found. Add one to get started!</p>';
        return;
    }

    let html = `
    <table class="keys-table">
        <thead>
            <tr>
                <th>Status</th>
                <th>Name</th>
                <th>API Key</th>
                <th>RPD Quota</th>
                <th>RPM Limit</th>
                <th>Max Context</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>
`;

    keys.forEach((key) => {
        const maskedKey =
            key.api_key.substring(0, 10) +
            "..." +
            key.api_key.substring(key.api_key.length - 4);
        if (key.active) {
            check = "checked";
            icon = "🟢";
        } else {
            check = "";
            icon = "🔴";
        }

        html += `
        <tr id="key-row-${key.api_key}">
            <td style="text-align:center;">
                <span class="key-active-display">${escapeHtml(icon)}</span>
                <input type="checkbox" class="edit-active checkmark" style="display: none;" ${check}>
            </td>
            <td>
                <span class="key-name-display">${escapeHtml(key.name)}</span>
                <input type="text" class="edit-name" style="display: none;" value="${escapeHtml(key.name)}">
            </td>
            <td>
                <span class="key-display" data-full-key="${escapeHtml(key.api_key)}">${escapeHtml(key.api_key)}</span>
            </td>
            <td>
                <span class="key-quota-display">${escapeHtml(key.usage_today)}/${escapeHtml(key.rpd)}</span>
                <input type="number" class="edit-rpd" style="display: none;" value="${escapeHtml(key.rpd)}">
            </td>
            <td>
                <span class="key-rpm-display">${escapeHtml(key.rpm)}</span>
                <input type="number" class="edit-rpm" style="display: none;" value="${escapeHtml(key.rpm)}">
            </td>
            <td>
                <span class="key-max-context-display">${key.max_context_size > 0 ? escapeHtml(String(key.max_context_size)) : "&#8734;"}</span>
                <input type="number" class="edit-max-context" style="display: none;" value="${escapeHtml(String(key.max_context_size ?? 0))}" min="0">
            </td>
            <td>
                <div class="actions" style="">
                    <button class="btn btn-primary" onclick="editKey('${escapeHtml(key.api_key)}')">Edit</button>
                    <button class="btn btn-success" style="display: none;" onclick="saveKey('${escapeHtml(key.api_key)}')">Save</button>
                    <button class="btn btn-danger" onclick="deleteKey('${escapeHtml(key.api_key)}', '${escapeHtml(key.name)}')">Delete</button>
                </div>
            </td>
        </tr>
    `;
    });

    html += `
        </tbody>
    </table>
`;

    container.innerHTML = html;
}

// Escape HTML to prevent XSS
// Add new key
async function addKey() {
    const name = document.getElementById("newKeyName").value.trim();
    const apiKey = document
        .getElementById("newApiKey")
        .value.trim();

    if (!name) {
        showMessage("Please enter a key name", "error");
        return;
    }

    if (!apiKey) {
        showMessage(
            "Please enter an API key or generate one",
            "error",
        );
        return;
    }

    try {
        const body = {
            api_key: apiKey,
            name: name,
        };

        const response = await fetch("/api/keys", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (response.status === 401) {
            logout();
            return;
        }

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Failed to add key");
        }

        showMessage("API key added successfully!", "success");
        document.getElementById("newKeyName").value = "";
        document.getElementById("newApiKey").value = "";
        loadKeys();
    } catch (error) {
        showMessage("Error adding key: " + error.message, "error");
    }
}

async function userCount() {
    try {
        const response = await fetch("/api/summary");
        const data = await response.json();

        const element = document.getElementById("keyCountText");
        element.textContent =
            data.total_api_keys + " Keys" || "0 Keys";
    } catch (error) {
        console.error("Error:", error);
    }
}

// Edit key name
function editKey(apiKey) {
    const row = document.getElementById(`key-row-${apiKey}`);

    const nameDisplay = row.querySelector(".key-name-display");
    const keyDisplay = row.querySelector(".key-display");
    const rpdDisplay = row.querySelector(".key-quota-display");
    const rpmDisplay = row.querySelector(".key-rpm-display");
    const maxContextDisplay = row.querySelector(
        ".key-max-context-display",
    );
    const activeDisplay = row.querySelector(".key-active-display");

    const nameInput = row.querySelector(".edit-name");
    const rpdInput = row.querySelector(".edit-rpd");
    const rpmInput = row.querySelector(".edit-rpm");
    const maxContextInput = row.querySelector(".edit-max-context");
    const activeInput = row.querySelector(".edit-active");

    const editBtn = row.querySelector(".btn-primary");
    const saveBtn = row.querySelector(".btn-success");

    nameDisplay.style.display = "none";
    const fullKey = keyDisplay.getAttribute("data-full-key");
    keyDisplay.textContent =
        fullKey.substring(0, 10) +
        "..." +
        fullKey.substring(fullKey.length - 4);
    rpdDisplay.style.display = "none";
    rpmDisplay.style.display = "none";
    maxContextDisplay.style.display = "none";
    activeDisplay.style.display = "none";

    nameInput.style.display = "block";
    rpdInput.style.display = "block";
    rpmInput.style.display = "block";
    maxContextInput.style.display = "block";
    activeInput.style.display = "block";

    editBtn.style.display = "none";
    saveBtn.style.display = "inline-block";
    nameInput.focus();
    rpdInput.focus();
    rpmInput.focus();
    maxContextInput.focus();
    activeInput.focus();
}

// Save key name
async function saveKey(apiKey) {
    const row = document.getElementById(`key-row-${apiKey}`);
    const nameInput = row.querySelector(".edit-name");
    const rpdInput = row.querySelector(".edit-rpd");
    const rpmInput = row.querySelector(".edit-rpm");
    const maxContextInput = row.querySelector(".edit-max-context");
    const activeInput = row.querySelector(".edit-active");

    const newName = nameInput.value.trim();
    const newRpd = rpdInput.value.trim();
    const newRpm = rpmInput.value.trim();
    const newMaxContextSize =
        parseInt(maxContextInput.value, 10) || 0;
    const newActive = activeInput.checked;

    if (!newName) {
        showMessage("Name cannot be empty", "error");
        return;
    }

    try {
        const response = await fetch(`/api/keys`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                name: newName,
                api_key: apiKey,
                rpd: newRpd,
                rpm: newRpm,
                max_context_size: newMaxContextSize,
                active: newActive,
            }),
        });

        if (response.status === 401) {
            logout();
            return;
        }

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Failed to update key");
        }

        showMessage("Key name updated successfully!", "success");
        loadKeys();
    } catch (error) {
        showMessage(
            "Error updating key: " + error.message,
            "error",
        );
    }
}

// Delete key
async function deleteKey(apiKey, name) {
    if (
        !confirm(
            `Are you sure you want to delete the key "${name}"? This action cannot be undone.`,
        )
    ) {
        return;
    }

    try {
        const response = await fetch(`/api/keys`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ api_key: apiKey }),
        });

        if (response.status === 401) {
            logout();
            return;
        }

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Failed to delete key");
        }

        showMessage("API key deleted successfully!", "success");
        loadKeys();
    } catch (error) {
        showMessage(
            "Error deleting key: " + error.message,
            "error",
        );
    }
}

async function reloadConfig() {
    try {
        const response = await fetch("/api/reload", {
            method: "POST",
        });

        const data = await response.json();
        showMessage(data.message);
        loadKeys(); // Refresh list
    } catch (error) {
        alert("Error reloading");
    }
}

// Load keys on page load
loadKeys();
userCount();
