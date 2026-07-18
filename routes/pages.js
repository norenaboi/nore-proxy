import express from "express";
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

function serveAdmin(res, filename) {
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

function servePublic(res, filename) {
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

router.get("/", (req, res) => {
  servePublic(res, "index.html");
});

router.get("/v1", (req, res) => {
  res.redirect("/");
});

router.get("/models", (req, res) => {
  servePublic(res, "display.html");
});

router.get("/usage", (req, res) => {
  servePublic(res, "usage.html");
});

router.get("/terms", (req, res) => {
  servePublic(res, "terms.html");
});

router.get("/privacy", (req, res) => {
  servePublic(res, "privacy.html");
});

router.get("/admin", (req, res) => {
  res.redirect("/admin/login");
});

router.get("/admin/login", (req, res) => {
  if (validateSession(req.cookies?.adminSession)) {
    return res.redirect("/admin/dashboard");
  }
  serveAdmin(res, "login.html");
});

router.get("/admin/dashboard", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "dashboard.html");
});

router.get("/admin/keys", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "keys.html");
});

router.get("/admin/models", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "models.html");
});

router.get("/admin/endpoints", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "endpoints.html");
});

router.get("/admin/settings", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "settings.html");
});

router.get("/admin/users", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "users.html");
});

router.get("/admin/model-usage", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "model-usage.html");
});

router.get("/admin/logs", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "logs.html");
});

router.get("/admin/errors", verifySessionOrRedirect, (req, res) => {
  serveAdmin(res, "errors.html");
});

export default router;
