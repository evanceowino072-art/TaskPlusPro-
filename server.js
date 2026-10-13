const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "TaskPlusPro",
    status: "online"
  });
});

// Public Supabase configuration
// Only expose the project URL and publishable/anon key.
app.get("/api/config", (_req, res) => {
  const url = process.env.TPP_SUPABASE_URL;
  const key = process.env.TPP_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return res.status(503).json({
      ok: false,
      message: "Supabase configuration is missing"
    });
  }

  res.set("Cache-Control", "no-store");

  res.json({
    supabaseUrl: url,
    supabaseKey: key
  });
});

// Homepage
app.get("/", (_req, res) => {
  res.sendFile(
    path.join(__dirname, "taskpluspro_tpp_website.html")
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TaskPlusPro listening on port ${PORT}`);
});
