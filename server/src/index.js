import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "./config.js";
import { api } from "./routes.js";
import { startPipelineWorker } from "./workers/pipeline.js";
import { startDiscoveryWorker } from "./workers/discovery.js";
import { stopAllDevServers } from "./devServers.js";
import { startExtractionWorker } from "./workers/extractions.js";

const app = express();
// 30mb: voice-clone samples (≤20MB per MiniMax) travel as base64 JSON.
app.use(express.json({ limit: "250mb" }));
app.use("/api", api);

// Serve the built dashboard in production; in dev, Vite proxies /api here.
const dist = join(ROOT, "dashboard", "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

app.listen(config.port, () => {
  console.log(`videoforge server → http://localhost:${config.port}`);
});

startPipelineWorker();
startDiscoveryWorker();
startExtractionWorker();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopAllDevServers();
    process.exit(0);
  });
}
