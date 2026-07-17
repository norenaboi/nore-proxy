async function loadDashboard() {
    try {
        const response = await fetch("/api/logs");

        if (!response.ok) {
            if (
                response.status === 401 ||
                response.status === 403
            ) {
                window.location.href = "/admin/login";
                return;
            }
            throw new Error("Failed to load dashboard");
        }

        const data = await response.json();

        // Use server-computed per-model costs from the API response
        const totalCost = data.summary.total_cost || 0;
        const dailyCost = data.summary.daily_cost || 0;

        // Update summary cards
        document.getElementById("dailyRequests").textContent =
            data.summary.daily_requests.toLocaleString();
        document.getElementById("totalRequests").textContent =
            data.summary.total_requests.toLocaleString();
        document.getElementById("totalInput").textContent =
            data.summary.total_input_tokens.toLocaleString();
        document.getElementById("totalOutput").textContent =
            data.summary.total_output_tokens.toLocaleString();
        document.getElementById("totalCacheWrite").textContent = (
            data.summary.total_cache_write_tokens || 0
        ).toLocaleString();
        document.getElementById("totalCacheRead").textContent = (
            data.summary.total_cache_read_tokens || 0
        ).toLocaleString();
        document.getElementById("dailyInput").textContent =
            data.summary.daily_input_tokens.toLocaleString();
        document.getElementById("dailyOutput").textContent =
            data.summary.daily_output_tokens.toLocaleString();
        document.getElementById("dailyCacheWrite").textContent = (
            data.summary.daily_cache_write_tokens || 0
        ).toLocaleString();
        document.getElementById("dailyCacheRead").textContent = (
            data.summary.daily_cache_read_tokens || 0
        ).toLocaleString();
        document.getElementById("keyCount").textContent =
            data.summary.total_api_keys.toLocaleString() + " keys";

        // Update costs (server-computed per-model)
        document.getElementById("totalInputCost").textContent =
            "$" + (data.summary.total_input_cost || 0).toFixed(4);
        document.getElementById("totalOutputCost").textContent =
            "$" + (data.summary.total_output_cost || 0).toFixed(4);
        document.getElementById("totalCacheWriteCost").textContent =
            "$" +
            (data.summary.total_cache_write_cost || 0).toFixed(4);
        document.getElementById("totalCacheReadCost").textContent =
            "$" +
            (data.summary.total_cache_read_cost || 0).toFixed(4);
        document.getElementById("dailyInputCost").textContent =
            "$" + (data.summary.daily_input_cost || 0).toFixed(4);
        document.getElementById("dailyOutputCost").textContent =
            "$" + (data.summary.daily_output_cost || 0).toFixed(4);
        document.getElementById("dailyCacheWriteCost").textContent =
            "$" +
            (data.summary.daily_cache_write_cost || 0).toFixed(4);
        document.getElementById("dailyCacheReadCost").textContent =
            "$" +
            (data.summary.daily_cache_read_cost || 0).toFixed(4);
        document.getElementById("totalCost").textContent =
            "$" + totalCost.toFixed(2);
        document.getElementById("dailyCost").textContent =
            "$" + dailyCost.toFixed(2);

        // Update table
        const tbody = document.getElementById("apiKeysBody");
        tbody.innerHTML = data.api_keys
            .map((key) => {
                const keyTotalCost = key.total_cost || 0;
                return `
        <tr>
            <td><strong>${key.name}</strong></td>
            <td>${key.daily_requests.toLocaleString()}</td>
            <td>${key.total_requests.toLocaleString()}</td>
            <td>${key.daily_input_tokens.toLocaleString()}</td>
            <td>${key.daily_output_tokens.toLocaleString()}</td>
            <td>${(key.daily_cache_write_tokens || 0).toLocaleString()}</td>
            <td>${(key.daily_cache_read_tokens || 0).toLocaleString()}</td>
            <td>${key.total_input_tokens.toLocaleString()}</td>
            <td>${key.total_output_tokens.toLocaleString()}</td>
            <td>${(key.total_cache_write_tokens || 0).toLocaleString()}</td>
            <td>${(key.total_cache_read_tokens || 0).toLocaleString()}</td>
            <td>$${keyTotalCost.toFixed(2)}</td>
        </tr>
    `;
            })
            .join("");

        if (data.recent_logs && data.recent_logs.length > 0) {
            const recentLogsBody =
                document.getElementById("recentLogsBody");
            recentLogsBody.innerHTML = data.recent_logs
                .map((log) => {
                    const date = new Date(log.timestamp * 1000);
                    const timeStr = date.toLocaleTimeString();
                    const dateStr = date.toLocaleDateString();

                    const logTotalCost = log.cost || 0;

                    return `
                <tr>
                    <td class="timestamp">${dateStr} ${timeStr}</td>
                    <td><strong>${log.name}</strong></td>
                    <td><span class="model-badge">${log.model}</span></td>
                    <td>${log.input_tokens.toLocaleString()}</td>
                    <td>${log.output_tokens.toLocaleString()}</td>
                    <td>${(log.cache_write_tokens || 0).toLocaleString()}</td>
                    <td>${(log.cache_read_tokens || 0).toLocaleString()}</td>
                    <td>${log.duration.toFixed(2)}s</td>
                    <td>$${logTotalCost.toFixed(4)}</td>
                </tr>
            `;
                })
                .join("");
        } else {
            document.getElementById("recentLogsBody").innerHTML =
                '<tr><td colspan="10" style="text-align: center; padding: 20px; color: #666;">No recent requests</td></tr>';
        }

        document.getElementById("loading").style.display = "none";
        document.getElementById("dashboard").style.display =
            "block";
    } catch (error) {
        document.getElementById("loading").style.display = "none";
        document.getElementById("error").style.display = "block";
        document.getElementById("error").textContent =
            error.message;
    }
}

// Load dashboard on page load
loadDashboard();

// Refresh every 30 seconds
setInterval(loadDashboard, 30000);
