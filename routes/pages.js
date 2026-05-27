import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateSession } from "../services/sessionManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

function requireSession(req, res, next) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    }
  }
  if (!validateSession(cookies.adminSession)) {
    return res.redirect("/admin/login");
  }
  next();
}

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

router.get("/admin", (req, res) => {
  res.redirect("/admin/login");
});

router.get("/admin/login", (req, res) => {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim(),
      );
    }
  }
  if (validateSession(cookies.adminSession)) {
    return res.redirect("/admin/dashboard");
  }
  serveAdmin(res, "login.html");
});

router.get("/admin/dashboard", requireSession, (req, res) => {
  serveAdmin(res, "dashboard.html");
});

router.get("/admin/keys", requireSession, (req, res) => {
  serveAdmin(res, "keys.html");
});

router.get("/admin/models", requireSession, (req, res) => {
  serveAdmin(res, "models.html");
});

router.get("/admin/endpoints", requireSession, (req, res) => {
  serveAdmin(res, "endpoints.html");
});

router.get("/admin/settings", requireSession, (req, res) => {
  serveAdmin(res, "settings.html");
});

router.get("/admin/users", requireSession, (req, res) => {
  serveAdmin(res, "users.html");
});

router.get("/admin/model-usage", requireSession, (req, res) => {
  serveAdmin(res, "model-usage.html");
});

router.get("/admin/logs", requireSession, (req, res) => {
  serveAdmin(res, "logs.html");
});

export default router;
