import express, { type Request, type Response } from "express";
import type { PublicModel, RegisteredModel } from "../types/models.js";
import { MODEL_PRICING, MODEL_REGISTRY } from "../utils/helpers.js";

const router = express.Router();

router.get("/v1/models", async (_req: Request, res: Response) => {
  const modelsData: PublicModel[] = [];

  try {
    for (const [modelName, modelInfo] of Object.entries(
      MODEL_REGISTRY as Record<string, RegisteredModel>,
    )) {
      if (modelInfo.hidden === true) continue;
      modelsData.push({
        id: modelName,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "nore-proxy",
        type: modelInfo.type || "chat",
        pricing: MODEL_PRICING[modelName] || null,
      });
    }
  } catch (error: unknown) {
    console.error("Error reading models:", error);
  }

  res.json({
    object: "list",
    data: modelsData,
  });
});

export default router;
