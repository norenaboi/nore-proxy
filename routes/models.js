import express from "express";
import { MODEL_PRICING, MODEL_REGISTRY } from "../utils/helpers.js";

const router = express.Router();

router.get("/v1/models", async (req, res) => {
  const modelsData = [];

  try {
    for (const [modelName, modelInfo] of Object.entries(MODEL_REGISTRY)) {
      modelsData.push({
        id: modelName,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "nore-proxy",
        type: modelInfo.type || "chat",
        pricing: MODEL_PRICING[modelName] || null,
      });
    }
  } catch (error) {
    console.error("Error reading models:", error);
  }

  res.json({
    object: "list",
    data: modelsData,
  });
});

export default router;
