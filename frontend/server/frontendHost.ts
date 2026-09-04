import type { Express, Request, Response } from "express";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const frontendDir = path.join(rootDir, "frontend");
const outputDir = path.join(rootDir, "dist", "frontend");
const assetBase = "/assets/app/";

interface ManifestChunk {
  file: string;
  css?: string[];
  imports?: string[];
}

let vite: ViteDevServer | undefined;
let productionDocuments = new Map<string, string>();
let manifest: Record<string, ManifestChunk> | null | undefined;

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

async function loadManifest(): Promise<Record<string, ManifestChunk> | null> {
  if (manifest !== undefined) return manifest;
  let loaded: Record<string, ManifestChunk> | null;
  try {
    loaded = JSON.parse(await fs.readFile(path.join(outputDir, ".vite", "manifest.json"), "utf8"));
  } catch {
    loaded = null;
  }
  manifest = loaded;
  return loaded;
}

// Admin page chunks are named after their URL slug: /admin/model-stats is
// src/admin/pages/ModelStatsPage.svelte. Returning null for anything else
// means the document is served exactly as built.
export function adminPageChunkKey(pathname: string): string | null {
  const slug = pathname.replace(/\/+$/, "").replace(/^\/admin\//, "");
  if (!/^[a-z]+(-[a-z]+)*$/.test(slug)) return null;
  const name = slug.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  return `src/admin/pages/${name}Page.svelte`;
}

// Vite only preloads the entry's static imports. The lazily imported page chunk
// would otherwise start downloading after admin.js has executed, so hint it (and
// its shared chunks and CSS) from the document. Vite's runtime skips links that
// are already in the document, so nothing loads twice.
export function preloadTagsForAdminPath(
  chunks: Record<string, ManifestChunk>,
  pathname: string,
  alreadyLinked: (file: string) => boolean = () => false,
): string {
  const key = adminPageChunkKey(pathname);
  const page = key ? chunks[key] : undefined;
  if (!page) return "";

  const scripts = new Set<string>();
  const styles = new Set<string>();
  const visit = (chunk: ManifestChunk | undefined) => {
    if (!chunk || scripts.has(chunk.file)) return;
    scripts.add(chunk.file);
    for (const css of chunk.css ?? []) styles.add(css);
    for (const dependency of chunk.imports ?? []) visit(chunks[dependency]);
  };
  visit(page);

  const fresh = (file: string) => !alreadyLinked(file);
  return [
    ...[...styles].filter(fresh).map((file) => `    <link rel="stylesheet" crossorigin href="${assetBase}${file}">`),
    ...[...scripts].filter(fresh).map((file) => `    <link rel="modulepreload" crossorigin href="${assetBase}${file}">`),
  ].join("\n");
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

    // Only registered admin paths reach here, so this cache stays bounded.
    const cacheKey = documentName === "admin.html" ? `${documentName}:${req.path}` : documentName;
    let html = productionDocuments.get(cacheKey);
    if (!html) {
      html = await fs.readFile(path.join(outputDir, documentName), "utf8");
      if (documentName === "admin.html") {
        const chunks = await loadManifest();
        const built = html;
        const tags = chunks ? preloadTagsForAdminPath(chunks, req.path, (file) => built.includes(file)) : "";
        if (tags) html = html.replace("</head>", `${tags}\n  </head>`);
      }
      productionDocuments.set(cacheKey, html);
    }
    res.set("Cache-Control", "no-cache").type("html").send(html);
  } catch (error) {
    vite?.ssrFixStacktrace(error as Error);
    console.error(`Could not render ${documentName}:`, error);
    res.status(503).type("text").send("Frontend assets are unavailable. Run npm run build:frontend and restart the server.");
  }
}
