import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { killTree } from "./agentRunner.js";

/** jobId -> { child, port, startedAt } */
const servers = new Map();

export function devServerStatus(jobId) {
  const s = servers.get(jobId);
  return s ? { running: true, port: s.port, url: `http://localhost:${s.port}/` } : { running: false };
}

export function startDevServer(jobId, workspace) {
  const existing = servers.get(jobId);
  if (existing) return devServerStatus(jobId);

  const presDir = join(workspace, "presentation");
  if (!existsSync(join(presDir, "package.json"))) {
    throw new Error("presentation/ not scaffolded yet for this job");
  }

  const port = config.devServerBasePort + (jobId % 100);
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(port), "--strictPort"],
    { cwd: presDir, shell: true, stdio: "ignore", env: process.env },
  );
  child.on("close", () => servers.delete(jobId));
  servers.set(jobId, { child, port, startedAt: Date.now() });
  return devServerStatus(jobId);
}

export function stopDevServer(jobId) {
  const s = servers.get(jobId);
  if (s) {
    killTree(s.child.pid);
    servers.delete(jobId);
  }
  return { running: false };
}

export function stopAllDevServers() {
  for (const jobId of [...servers.keys()]) stopDevServer(jobId);
}
