import express, { type Request, type Response } from "express";
import { verifySessionOrRedirect } from "../middleware/auth.js";
import { validateSession } from "../services/sessionManager.js";
import { renderFrontend } from "../frontend/server/frontendHost.js";

const router = express.Router();

const publicPaths = ["/", "/models", "/status", "/usage", "/playground", "/terms", "/privacy"] as const;
for (const publicPath of publicPaths) {
  router.get(publicPath, async (req: Request, res: Response) => {
    await renderFrontend(req, res, "public.html");
  });
}

router.get("/v1", (_req, res) => {
  res.redirect("/");
});

router.get("/admin", (_req, res) => {
  res.redirect("/admin/login");
});

router.get("/admin/login", async (req: Request, res: Response) => {
  if (await validateSession(req.cookies?.adminSession)) {
    return res.redirect("/admin/dashboard");
  }
  return renderFrontend(req, res, "login.html");
});

router.get("/admin/model-usage", verifySessionOrRedirect, (_req, res) => {
  res.redirect("/admin/model-stats");
});

const adminPaths = [
  "/admin/dashboard",
  "/admin/keys",
  "/admin/models",
  "/admin/endpoints",
  "/admin/settings",
  "/admin/users",
  "/admin/model-stats",
  "/admin/endpoint-stats",
  "/admin/console",
  "/admin/logs",
  "/admin/errors",
] as const;

for (const adminPath of adminPaths) {
  router.get(adminPath, verifySessionOrRedirect, async (req: Request, res: Response) => {
    await renderFrontend(req, res, "admin.html");
  });
}

export default router;
