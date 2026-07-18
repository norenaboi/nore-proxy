let ws = null;
let currentTab = "requests";
let stats = {};

function formatDuration(seconds) {
    if (seconds < 1) return (seconds * 1000).toFixed(0) + "ms";
    if (seconds < 60) return seconds.toFixed(1) + "s";
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}m ${secs}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}

// Refresh Stats
async function refreshStats() {
    try {
        const response = await fetch("/api/summary");
        const data = await response.json();

        // Animate number changes
        document.getElementById("users-count").textContent =
            data.total_api_keys || 0;
        document.getElementById("success-24h").textContent =
            `${((data.successful / data.daily_requests)*100).toFixed(1)}%`;
        document.getElementById("success-all-time").textContent =
            `${((data.all_time_successful / data.all_time_requests)*100).toFixed(1)}%`;
        document.getElementById("uptime").textContent =
            formatDuration(data.uptime);
    } catch (error) {
        console.error("Error:", error);
    }
}

// Initial load
refreshStats();

// Refresh every 30 seconds
setInterval(refreshStats, 30000);
