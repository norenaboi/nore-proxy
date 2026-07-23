import express, { type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { verifySessionOrRedirect } from "../middleware/auth.js";
import { validateSession } from "../services/sessionManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const adminDir = path.join(__dirname, "..", "html", "admin");
const publicDir = path.join(__dirname, "..", "html", "public");
const assetsDir = path.join(__dirname, "..", "html", "assets");

function serveAdmin(res: Response, filename: string): void {
  const htmlPath = path.join(adminDir, filename);
  const errorPath = path.join(publicDir, "404.html");

  if (fs.existsSync(htmlPath)) {
    const content = fs.readFileSync(htmlPath, "utf-8");
    res.type("html").send(content);
  } else if (fs.existsSync(errorPath)) {
    const errorContent = fs.readFileSync(errorPath, "utf-8");
    res.status(404).type("html").send(errorContent);
  } else {
    res.status(404).send("Page not found");
  }
}

function servePublic(res: Response, filename: string): void {
  const htmlPath = path.join(publicDir, filename);
  const errorPath = path.join(publicDir, "404.html");

  if (fs.existsSync(htmlPath)) {
    const content = fs.readFileSync(htmlPath, "utf-8");
    res.type("html").send(content);
  } else if (fs.existsSync(errorPath)) {
    const errorContent = fs.readFileSync(errorPath, "utf-8");
    res.status(404).type("html").send(errorContent);
  } else {
    res.status(404).send("Page not found");
  }
}

const assetsStatic = express.static(assetsDir);
router.use("/admin", assetsStatic);
router.use("/", assetsStatic);

router.get("/", (req: any, res: any) => {
  servePublic(res, "index.html");
});

router.get("/v1", (req: any, res: any) => {
  res.redirect("/");
});

router.get("/models", (req: any, res: any) => {
  servePublic(res, "display.html");
});

router.get("/usage", (req: any, res: any) => {
  servePublic(res, "usage.html");
});

router.get("/terms", (req: any, res: any) => {
  servePublic(res, "terms.html");
});

router.get("/privacy", (req: any, res: any) => {
  servePublic(res, "privacy.html");
});

router.get("/admin", (req: any, res: any) => {
  res.redirect("/admin/login");
});

router.get("/admin/login", (req: any, res: any) => {
  if (validateSession(req.cookies?.adminSession)) {
    return res.redirect("/admin/dashboard");
  }
  serveAdmin(res, "login.html");
});

router.get("/admin/dashboard", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "dashboard.html");
});

router.get("/admin/keys", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "keys.html");
});

router.get("/admin/models", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "models.html");
});

router.get("/admin/endpoints", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "endpoints.html");
});

router.get("/admin/settings", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "settings.html");
});

router.get("/admin/users", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "users.html");
});

router.get("/admin/model-usage", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "model-usage.html");
});

router.get("/admin/console", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "console.html");
});

router.get("/admin/logs", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "logs.html");
});

router.get("/admin/errors", verifySessionOrRedirect, (req: any, res: any) => {
  serveAdmin(res, "errors.html");
});

export default router;
