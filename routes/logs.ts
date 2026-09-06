import express, { type Request, type Response } from "express";
import logService from "../services/logService.js";
import { verifySession } from "../middleware/auth.js";

const router = express.Router();

router.get("/api/logs/stream", verifySession, (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable buffering in nginx

  res.write("data: " + JSON.stringify({ type: "connected" }) + "\n\n");

  const recentLogs = logService.getLogs(50);
  res.write(
    "data: " + JSON.stringify({ type: "initial", logs: recentLogs }) + "\n\n",
  );

  const logHandler = (logEntry: any) => {
    res.write(
      "data: " + JSON.stringify({ type: "log", log: logEntry }) + "\n\n",
    );
  };

  logService.on("log", logHandler);

  // Proxies and browsers drop an idle event stream, so hold it open.
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    logService.removeListener("log", logHandler);
  });
});

router.post("/api/logs/clear", verifySession, (_req: Request, res: Response) => {
  logService.clearLogs();
  res.json({ success: true, message: "Logs cleared" });
});

export default router;
