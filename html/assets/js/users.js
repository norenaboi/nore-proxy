let allUsers = [];
let currentUser = null;

async function loadUsers() {
    try {
        const response = await fetch("/api/users");
        const data = await response.json();

        allUsers = data.users;
        renderUsers();
    } catch (error) {
        console.error("Error loading users:", error);
        document.getElementById("usersGrid").innerHTML =
            '<div class="empty-state"><i class="fa-solid fa-exclamation-triangle"></i><p>Error loading users</p></div>';
    } finally {
        document.getElementById("loading").style.display = "none";
    }
}

function renderUsers() {
    const grid = document.getElementById("usersGrid");
    const query = document
        .getElementById("userSearch")
        .value.trim()
        .toLowerCase();
    const visibleUsers = query
        ? allUsers.filter((user) =>
              [user.name, user.api_key].some((value) =>
                  String(value || "").toLowerCase().includes(query),
              ),
          )
        : allUsers;

    document.getElementById("searchCount").textContent = query
        ? `${visibleUsers.length} of ${allUsers.length} users`
        : `${allUsers.length} users`;

    if (visibleUsers.length === 0) {
        grid.innerHTML = query
            ? '<div class="empty-state"><i class="fa-solid fa-magnifying-glass"></i><p>No users match your search</p></div>'
            : '<div class="empty-state"><i class="fa-solid fa-users"></i><p>No users found</p></div>';
        return;
    }

    grid.innerHTML = visibleUsers
        .map(
            (user) => `
        <div class="user-card" onclick="showUserDetail('${escapeHtml(user.api_key_full)}')">
            <div class="user-header">
                <div class="user-avatar">${user.name.charAt(0).toUpperCase()}</div>
                <div class="user-info">
                    <h3>${escapeHtml(user.name)}</h3>
                    <div class="user-key">${escapeHtml(user.api_key)}</div>
                </div>
            </div>
        </div>
    `,
        )
        .join("");
}

async function showUserDetail(apiKey) {
    try {
        const response = await fetch(
            `/api/users/${encodeURIComponent(apiKey)}`,
        );
        const data = await response.json();

        currentUser = data;
        renderUserDetail();
    } catch (error) {
        console.error("Error loading user detail:", error);
    }
}

function renderUserDetail() {
    const user = currentUser;
    document.getElementById("usersList").style.display = "none";
    document.getElementById("userDetail").classList.add("show");

    // Use server-computed per-model costs from the API response
    const totalCost = user.total_cost || 0;
    const dailyCost = user.daily_cost || 0;

    // Per-type cost breakdowns
    const totalInputCost = user.total_input_cost || 0;
    const totalOutputCost = user.total_output_cost || 0;
    const totalCacheWriteCost = user.total_cache_write_cost || 0;
    const totalCacheReadCost = user.total_cache_read_cost || 0;
    const dailyInputCost = user.daily_input_cost || 0;
    const dailyOutputCost = user.daily_output_cost || 0;
    const dailyCacheWriteCost = user.daily_cache_write_cost || 0;
    const dailyCacheReadCost = user.daily_cache_read_cost || 0;

    document.getElementById("userDetail").innerHTML = `
        <div class="detail-header">
            <div>
                <h1>${escapeHtml(user.name)}</h1>
                <div class="user-key" style="margin-top: 0.5rem;">${escapeHtml(user.api_key)}</div>
            </div>
            <button class="back-btn" onclick="backToList()">
                <i class="fa-solid fa-arrow-left"></i>
                Back to Users
            </button>
        </div>

        <div class="summary-cards">
            <div class="summary-card">
                <h3>Total Requests</h3>
                <div class="value">${user.total_requests.toLocaleString()}</div>
            </div>
            <div class="summary-card">
                <h3>Total Input Tokens</h3>
                <div class="value">${formatNumber(user.total_input_tokens)}</div>
                <div class="cost-caption">$${totalInputCost.toFixed(4)}</div>
            </div>
            <div class="summary-card">
                <h3>Total Output Tokens</h3>
                <div class="value">${formatNumber(user.total_output_tokens)}</div>
                <div class="cost-caption">$${totalOutputCost.toFixed(4)}</div>
            </div>
            <div class="summary-card">
                <h3>Total Estimated Cost</h3>
                <div class="value">$${totalCost.toFixed(2)}</div>
            </div>
            <div class="summary-card">
                <h3>Daily Requests</h3>
                <div class="value">${user.daily_requests.toLocaleString()}</div>
            </div>
            <div class="summary-card">
                <h3>Daily Input Tokens</h3>
                <div class="value">${formatNumber(user.daily_input_tokens)}</div>
                <div class="cost-caption">$${dailyInputCost.toFixed(4)}</div>
            </div>
            <div class="summary-card">
                <h3>Daily Output Tokens</h3>
                <div class="value">${formatNumber(user.daily_output_tokens)}</div>
                <div class="cost-caption">$${dailyOutputCost.toFixed(4)}</div>
            </div>
            <div class="summary-card">
                <h3>Daily Estimated Cost</h3>
                <div class="value">$${dailyCost.toFixed(2)}</div>
            </div>
            <div class="summary-card">
                <h3>Total Cache Write</h3>
                <div class="value">${formatNumber(user.total_cache_write_tokens || 0)}</div>
                <div class="cost-caption">$${totalCacheWriteCost.toFixed(4)}</div>
            </div>
            <div class="summary-card">
                <h3>Total Cache Read</h3>
                <div class="value">${formatNumber(user.total_cache_read_tokens || 0)}</div>
                <div class="cost-caption">$${totalCacheReadCost.toFixed(4)}</div>
            </div>
            <div class="summary-card">
                <h3>Daily Cache Write</h3>
                <div class="value">${formatNumber(user.daily_cache_write_tokens || 0)}</div>
                <div class="cost-caption">$${dailyCacheWriteCost.toFixed(4)}</div>
            </div>
            <div class="summary-card">
                <h3>Daily Cache Read</h3>
                <div class="value">${formatNumber(user.daily_cache_read_tokens || 0)}</div>
                <div class="cost-caption">$${dailyCacheReadCost.toFixed(4)}</div>
            </div>
        </div>

        <div class="table-card">
            <div class="table-header">
                <h2><i class="fa-solid fa-clock-rotate-left"></i> Recent Requests</h2>
            </div>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Model</th>
                        <th>Input Tokens</th>
                        <th>Output Tokens</th>
                        <th>Cache Write</th>
                        <th>Cache Read</th>
                        <th>Total Tokens</th>
                        <th>Duration</th>
                        <th>Est. Cost</th>
                    </tr>
                </thead>
                <tbody>
                    ${user.recent_requests
                        .map((req) => {
                            const date = new Date(
                                req.timestamp * 1000,
                            );
                            const timeStr =
                                date.toLocaleTimeString();
                            const dateStr =
                                date.toLocaleDateString();

                            const reqTotalCost = req.cost || 0;

                            return `
                            <tr>
                                <td>
                                    <div class="timestamp">${dateStr} ${timeStr}</div>
                                </td>
                                <td><span class="model-badge">${escapeHtml(req.model)}</span></td>
                                <td><span class="token-value input">${req.input_tokens.toLocaleString()}</span></td>
                                <td><span class="token-value output">${req.output_tokens.toLocaleString()}</span></td>
                                <td><span class="token-value">${(req.cache_write_tokens || 0).toLocaleString()}</span></td>
                                <td><span class="token-value">${(req.cache_read_tokens || 0).toLocaleString()}</span></td>
                                <td><span class="token-value">${req.total_tokens.toLocaleString()}</span></td>
                                <td>${req.duration.toFixed(2)}s</td>
                                <td>$${reqTotalCost.toFixed(4)}</td>
                            </tr>
                        `;
                        })
                        .join("")}
                </tbody>
            </table>
        </div>
    `;
}

function backToList() {
    document.getElementById("usersList").style.display = "block";
    document.getElementById("userDetail").classList.remove("show");
    currentUser = null;
}

document.getElementById("userSearch").addEventListener("input", renderUsers);

// Load users on page load
loadUsers();
