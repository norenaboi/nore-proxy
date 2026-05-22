import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MODEL_REGISTRY } from "../utils/helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.get("/v1/models", async (req, res) => {
  const modelsData = [];

  try {
    const jsonPath = path.join(__dirname, "..", "models.json");

    if (fs.existsSync(jsonPath)) {
      const content = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(content);

      for (const [displayName, modelConfig] of Object.entries(
        data.models || {},
      )) {
        modelsData.push({
          id: displayName,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "nore-proxy",
          type: "chat",
          pricing: modelConfig.pricing || null,
        });
      }
    } else {
      // Fall back to in-memory registry
      for (const [modelName, modelInfo] of Object.entries(MODEL_REGISTRY)) {
        modelsData.push({
          id: modelName,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "nore-proxy",
          type: modelInfo.type || "chat",
          pricing: null,
        });
      }
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
