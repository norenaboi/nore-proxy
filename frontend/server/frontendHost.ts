import type { Express, Request, Response } from "express";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontendDir = path.join(rootDir, "frontend");
const outputDir = path.join(rootDir, "dist", "frontend");

let vite: ViteDevServer | undefined;
let productionDocuments = new Map<string, string>();

export async function initializeFrontend(app: Express): Promise<void> {
  if (process.env.NODE_ENV === "development") {
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: path.join(frontendDir, "vite.config.ts"),
      server: { middlewareMode: true },
      appType: "custom",
    });
    app.use(vite.middlewares);
    return;
  }

  app.use(
    "/assets/app/assets",
    express.static(path.join(outputDir, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.use("/assets/app", express.static(outputDir));
  app.use(
    "/icons",
    express.static(path.join(outputDir, "icons"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.get("/favicon.ico", (_req, res) => {
    res.sendFile(path.join(outputDir, "favicon.ico"));
  });
}

export async function renderFrontend(
  req: Request,
  res: Response,
  documentName: "public.html" | "admin.html" | "login.html",
): Promise<void> {
  try {
    if (vite) {
      const source = await fs.readFile(path.join(frontendDir, documentName), "utf8");
      const html = await vite.transformIndexHtml(req.originalUrl, source);
      res.set("Cache-Control", "no-cache").type("html").send(html);
      return;
    }

    let html = productionDocuments.get(documentName);
    if (!html) {
      html = await fs.readFile(path.join(outputDir, documentName), "utf8");
      productionDocuments.set(documentName, html);
    }
    res.set("Cache-Control", "no-cache").type("html").send(html);
  } catch (error) {
    vite?.ssrFixStacktrace(error as Error);
    console.error(`Could not render ${documentName}:`, error);
    res.status(503).type("text").send("Frontend assets are unavailable. Run npm run build:frontend and restart the server.");
  }
}
