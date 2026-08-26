const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SEED_CONTENT = path.join(__dirname, "content.seed.json");
const SEED_GALLERY_DIR = path.join(__dirname, "images", "gallery");
const CONTENT_PATH = path.join(DATA_DIR, "content.json");
const GALLERY_DIR = path.join(DATA_DIR, "images", "gallery");
const STATS_PATH = path.join(DATA_DIR, "stats.json");

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// ---- first-boot seed: copy default content/images into the persistent volume ----
function ensureSeeded() {
  fs.mkdirSync(GALLERY_DIR, { recursive: true });

  if (!fs.existsSync(CONTENT_PATH)) {
    fs.copyFileSync(SEED_CONTENT, CONTENT_PATH);
    console.log("Seeded content.json into", DATA_DIR);
  }

  if (fs.existsSync(SEED_GALLERY_DIR)) {
    for (const f of fs.readdirSync(SEED_GALLERY_DIR)) {
      const dest = path.join(GALLERY_DIR, f);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(SEED_GALLERY_DIR, f), dest);
      }
    }
  }

  if (!fs.existsSync(STATS_PATH)) {
    fs.writeFileSync(STATS_PATH, JSON.stringify({ days: {} }, null, 2), "utf-8");
  }
}
ensureSeeded();

function readContent() {
  return JSON.parse(fs.readFileSync(CONTENT_PATH, "utf-8"));
}
function writeContent(obj) {
  fs.writeFileSync(CONTENT_PATH, JSON.stringify(obj, null, 2), "utf-8");
}

function readStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
    if (!parsed.days) parsed.days = {};
    return parsed;
  } catch (err) {
    return { days: {} };
  }
}
function writeStats(obj) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(obj, null, 2), "utf-8");
}

// dates are bucketed in Asia/Bangkok time (UTC+7) regardless of server timezone,
// since that's the timezone the shop and its customers actually operate in
function bangkokDateKey() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const bkk = new Date(utcMs + 7 * 3600000);
  const y = bkk.getFullYear();
  const m = String(bkk.getMonth() + 1).padStart(2, "0");
  const d = String(bkk.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---- basic auth for admin routes ----
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    res.status(503).send("Admin panel is not configured (ADMIN_PASSWORD is not set).");
    return;
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const sepIndex = decoded.indexOf(":");
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);
    if (timingSafeEqual(user, ADMIN_USER) && timingSafeEqual(pass, ADMIN_PASSWORD)) {
      next();
      return;
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Nuam Admin"');
  res.status(401).send("Authentication required.");
}

// ---- uploads (gallery photos) ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, GALLERY_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
      const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
      cb(null, `g_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${safeExt}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG, or WEBP images are allowed."));
  },
});

app.use(express.json({ limit: "2mb" }));

// ---- public content API (read) ----
app.get("/api/content", (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(readContent());
  } catch (err) {
    res.status(500).json({ error: "Could not read content." });
  }
});

// ---- public: record an analytics event (pageview / call click / directions click) ----
const TRACK_TYPES = ["pageview", "call", "directions"];
app.post("/api/track", (req, res) => {
  const type = req.body && req.body.type;
  if (!TRACK_TYPES.includes(type)) {
    res.status(400).json({ error: "Invalid event type." });
    return;
  }
  try {
    const stats = readStats();
    const key = bangkokDateKey();
    if (!stats.days[key]) stats.days[key] = { pageviews: 0, calls: 0, directions: 0 };
    const field = type === "pageview" ? "pageviews" : type === "call" ? "calls" : "directions";
    stats.days[key][field] = (stats.days[key][field] || 0) + 1;
    writeStats(stats);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: "Could not record event." });
  }
});

// ---- admin: read analytics ----
app.get("/api/stats", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    res.json(readStats());
  } catch (err) {
    res.status(500).json({ error: "Could not read stats." });
  }
});

// ---- admin: save full content JSON (prices, promo, gallery captions) ----
app.post("/api/content", requireAdmin, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || !Array.isArray(body.priceGroups) || !Array.isArray(body.gallery)) {
    res.status(400).json({ error: "Invalid content payload." });
    return;
  }
  try {
    writeContent(body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not save content." });
  }
});

// ---- admin: replace or add a gallery photo ----
// index = existing gallery array index to replace; omit to append a new photo
app.post("/api/upload/gallery", requireAdmin, upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No image uploaded." });
    return;
  }
  try {
    const content = readContent();
    const relFile = "gallery/" + req.file.filename;
    const indexRaw = req.body.index;
    const index = indexRaw !== undefined && indexRaw !== "" ? parseInt(indexRaw, 10) : NaN;

    if (!isNaN(index) && content.gallery[index]) {
      const oldFile = content.gallery[index].file;
      content.gallery[index].file = relFile;
      const oldPath = path.join(DATA_DIR, "images", oldFile);
      if (oldFile && oldFile !== relFile && fs.existsSync(oldPath)) {
        fs.unlink(oldPath, () => {});
      }
    } else {
      content.gallery.push({
        file: relFile,
        alt_th: "รูปใหม่",
        alt_en: "New photo",
        caption_th: "รูปใหม่",
        caption_en: "New photo",
      });
    }
    writeContent(content);
    res.json({ ok: true, file: relFile, content });
  } catch (err) {
    res.status(500).json({ error: "Could not save uploaded image." });
  }
});

// ---- admin: delete a gallery photo ----
app.post("/api/gallery/:index/delete", requireAdmin, (req, res) => {
  try {
    const content = readContent();
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || !content.gallery[index]) {
      res.status(400).json({ error: "Invalid photo index." });
      return;
    }
    const removed = content.gallery.splice(index, 1)[0];
    writeContent(content);
    if (removed && removed.file) {
      const p = path.join(DATA_DIR, "images", removed.file);
      if (fs.existsSync(p)) fs.unlink(p, () => {});
    }
    res.json({ ok: true, content });
  } catch (err) {
    res.status(500).json({ error: "Could not delete photo." });
  }
});

// serve uploaded/current images from the persistent volume
app.use("/uploads", express.static(path.join(DATA_DIR, "images")));

// protect the admin page itself
app.get(["/admin", "/admin.html"], requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use(express.static(__dirname, { extensions: ["html"] }));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`น่วม Thai Massage site running on port ${PORT}`);
});
