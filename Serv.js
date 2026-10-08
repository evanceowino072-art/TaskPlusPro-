const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "TaskPlusPro",
    status: "online"
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "taskpluspro_tpp_website.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`TaskPlusPro listening on port ${PORT}`);
});
