import express from "express";
import logService from "../services/logService.js";
import { validateSession } from "../services/sessionManager.js";

const router = express.Router();

function requireSession(req, res, next) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    }
  }
  if (!validateSession(cookies.adminSession)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Get recent logs
router.get("/api/logs", requireSession, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = logService.getLogs(limit);
  res.json({ logs });
});

// SSE endpoint for live logs
router.get("/api/logs/stream", requireSession, (req, res) => {
  // Set headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable buffering in nginx

  // Send initial connection message
  res.write("data: " + JSON.stringify({ type: "connected" }) + "\n\n");

  // Send recent logs on connection
  const recentLogs = logService.getLogs(50);
  res.write(
    "data: " +
      JSON.stringify({ type: "initial", logs: recentLogs }) +
      "\n\n",
  );

  // Listen for new logs
  const logHandler = (logEntry) => {
    res.write(
      "data: " + JSON.stringify({ type: "log", log: logEntry }) + "\n\n",
    );
  };

  logService.on("log", logHandler);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30000);

  // Clean up on client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    logService.removeListener("log", logHandler);
  });
});

// Clear logs
router.post("/api/logs/clear", requireSession, (req, res) => {
  logService.clearLogs();
  res.json({ success: true, message: "Logs cleared" });
});

export default router;
