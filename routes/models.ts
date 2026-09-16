import express, { type Request, type Response } from "express";
import type { PublicModel } from "../types/models.js";
import { MODEL_PRICING, MODEL_REGISTRY, publicModelEntries } from "../utils/helpers.js";
import Config from "../config/index.js";
import { imageModelFormat } from "../utils/imageModelFormat.js";

const router = express.Router();

router.get("/v1/models", async (_req: Request, res: Response) => {
  const modelsData: PublicModel[] = [];

  try {
    for (const [modelName, modelInfo] of publicModelEntries()) {
      modelsData.push({
        id: modelName,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "nore-proxy",
        type: modelInfo.type || "chat",
        modality: modelInfo.modality || "text",
        image_api_format: imageModelFormat(modelInfo, MODEL_REGISTRY, Config.ENDPOINTS),
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
