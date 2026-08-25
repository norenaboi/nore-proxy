/**
 * Uptime layer routes.
 *
 * This router is the only HTTP surface of the uptime layer. Handlers never
 * propagate an error: the service resolves to a well-formed payload with
 * `available: false` when it is degraded, and the try/catch here is a final
 * backstop so a fault in this layer cannot reach the shared error handler.
 */
import express, { type Request, type Response } from "express";
import { verifySession } from "../middleware/auth.js";
import uptimeService from "../services/uptime/index.js";
import { MODEL_REGISTRY } from "../utils/helpers.js";
import {
  UPTIME_BUCKET_SECONDS_ALLOWED,
  UPTIME_BUCKET_SECONDS_DEFAULT,
  UPTIME_WINDOW_HOURS_DEFAULT,
  UPTIME_WINDOW_HOURS_MAX,
  uptimeStatus,
  type ModelUptimeResponse,
  type PublicUptimeResponse,
} from "../shared/contracts/uptime.js";

const router = express.Router();

function parseWindowHours(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return UPTIME_WINDOW_HOURS_DEFAULT;
  return Math.min(UPTIME_WINDOW_HOURS_MAX, Math.max(1, parsed));
}

function parseBucketSeconds(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return (UPTIME_BUCKET_SECONDS_ALLOWED as readonly number[]).includes(parsed)
    ? parsed
    : UPTIME_BUCKET_SECONDS_DEFAULT;
}

function emptyResponse(hours: number, bucketSeconds: number): ModelUptimeResponse {
  return {
    window_hours: hours,
    bucket_seconds: bucketSeconds,
    generated_at: Math.floor(Date.now() / 1000),
    available: false,
    models: [],
  };
}

export function publicResponse(payload: ModelUptimeResponse): PublicUptimeResponse {
  const observed = new Map(payload.models.map((model) => [model.model_name, model]));
  const configuredModels = Object.entries(MODEL_REGISTRY as Record<string, { hidden?: boolean }>)
    .filter(([, model]) => model.hidden !== true)
    .map(([name]) => name);
  const modelNames = [...new Set([...configuredModels, ...observed.keys()])];

  return {
    window_hours: payload.window_hours,
    bucket_seconds: payload.bucket_seconds,
    generated_at: payload.generated_at,
    available: payload.available,
    models: modelNames.map((modelName) => {
      const model = observed.get(modelName);
      if (!model) {
        return {
          model_name: modelName,
          success_rate: 0,
          avg_latency_ms: 0,
          status: "unknown",
          series: [],
        };
      }
      return {
        model_name: model.model_name,
        success_rate: model.success_rate,
        avg_latency_ms: model.avg_latency_ms,
        status: uptimeStatus(model.success_rate, model.request_count),
        series: model.series.map((bucket) => ({
          ts: bucket.ts,
          success_rate: bucket.success_rate,
          avg_latency_ms: bucket.avg_latency_ms,
          status: uptimeStatus(bucket.success_rate, bucket.request_count),
        })),
      };
    }),
  };
}

router.get("/api/uptime", verifySession, async (req: Request, res: Response) => {
  const hours = parseWindowHours(req.query.hours);
  const bucketSeconds = parseBucketSeconds(req.query.bucket);
  try {
    const payload = await uptimeService.query({ hours, bucketSeconds });
    return res.json(payload);
  } catch (error: unknown) {
    console.error("[uptime] request failed:", error);
    return res.json(emptyResponse(hours, bucketSeconds));
  }
});

router.get("/api/public-uptime", async (req: Request, res: Response) => {
  const hours = parseWindowHours(req.query.hours);
  const bucketSeconds = parseBucketSeconds(req.query.bucket);
  try {
    const payload = await uptimeService.query({ hours, bucketSeconds });
    return res.json(publicResponse(payload));
  } catch (error: unknown) {
    console.error("[uptime] public request failed:", error);
    return res.json(publicResponse(emptyResponse(hours, bucketSeconds)));
  }
});

router.get("/api/uptime/status", verifySession, (_req: Request, res: Response) => {
  try {
    return res.json(uptimeService.status());
  } catch (error: unknown) {
    console.error("[uptime] status failed:", error);
    return res.json({ available: false, degraded: true });
  }
});

export default router;
