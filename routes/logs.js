import express from "express";
import logService from "../services/logService.js";
import { verifySession } from "../middleware/auth.js";

const router = express.Router();

// SSE endpoint for live logs
router.get("/api/logs/stream", verifySession, (req, res) => {
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
    "data: " + JSON.stringify({ type: "initial", logs: recentLogs }) + "\n\n",
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
router.post("/api/logs/clear", verifySession, (req, res) => {
  logService.clearLogs();
  res.json({ success: true, message: "Logs cleared" });
});

export default router;
