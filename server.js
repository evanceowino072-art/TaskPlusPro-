
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const WEBSITE_FILE = path.join(
  __dirname,
  "taskpluspro_tpp_website.html"
);

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Basic security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

// Health check
app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "TaskPlusPro",
    status: "online",
    timestamp: new Date().toISOString()
  });
});

// Public Supabase browser configuration
app.get("/api/config", (_req, res) => {
  const url = process.env.TPP_SUPABASE_URL;
  const key = process.env.TPP_SUPABASE_ANON_KEY;

  res.set("Cache-Control", "no-store");

  if (!url || !key) {
    return res.status(503).json({
      ok: false,
      message: "Supabase browser configuration is missing."
    });
  }

  res.json({
    supabaseUrl: url,
    supabaseKey: key
  });
});

// Diagnostics: checks file and environment-variable presence only
app.get("/api/diagnostics", (_req, res) => {
  res.set("Cache-Control", "no-store");

  res.json({
    ok: true,
    service: "TaskPlusPro",
    checks: {
      websiteFileExists: fs.existsSync(WEBSITE_FILE),
      supabaseUrlConfigured: Boolean(
        process.env.TPP_SUPABASE_URL
      ),
      supabaseAnonKeyConfigured: Boolean(
        process.env.TPP_SUPABASE_ANON_KEY
      ),
      nodeEnvironment: process.env.NODE_ENV || "not-set"
    },
    note: "This does not test authentication or payments."
  });
});

// Homepage
app.get("/", (_req, res) => {
  res.sendFile(WEBSITE_FILE, (err) => {
    if (err && !res.headersSent) {
      console.error("Homepage error:", err.message);
      res.status(500).send(
        "Homepage missing. Check taskpluspro_tpp_website.html."
      );
    }
  });
});

// Explicit homepage file route
app.get("/taskpluspro_tpp_website.html", (_req, res) => {
  res.sendFile(WEBSITE_FILE);
});

// Unknown API routes
app.use("/api", (_req, res) => {
  res.status(404).json({
    ok: false,
    message: "API route not found."
  });
});

// Other unknown routes
app.use((_req, res) => {
  res.status(404).send("Page not found.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TaskPlusPro listening on port ${PORT}`);
});
