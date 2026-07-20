const terminal = document.getElementById("logsTerminal");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

function addLog(log) {
    const entry = document.createElement("div");
    entry.className = "log-entry";

    const time = new Date(log.timestamp).toLocaleTimeString();

    entry.innerHTML = `
        <span class="log-time">${time}</span>
        <span class="log-level ${log.level}">${log.level}</span>
        <span class="log-message"></span>
    `;

    entry.querySelector(".log-message").textContent = log.message;

    terminal.appendChild(entry);
    terminal.scrollTop = terminal.scrollHeight;

    while (terminal.children.length > 500) {
        terminal.removeChild(terminal.firstChild);
    }
}

function connectSSE() {
    const eventSource = new EventSource("/api/logs/stream");

    eventSource.onopen = () => {
        statusDot.classList.add("connected");
        statusText.textContent = "Connected";
    };

    eventSource.onerror = () => {
        statusDot.classList.remove("connected");
        statusText.textContent = "Disconnected";
    };

    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "initial") {
            terminal.innerHTML = "";
            data.logs.forEach(addLog);
        }

        if (data.type === "log") {
            addLog(data.log);
        }
    };
}

async function clearLogs() {
    const response = await fetch("/api/logs/clear", {
        method: "POST",
    });

    if (response.ok) {
        terminal.innerHTML = "";
    }
}

connectSSE();
