import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { killTree } from "./agentRunner.js";

/** jobId -> { child, port, startedAt } */
const servers = new Map();

async function portIsServing(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function devServerStatus(jobId) {
  const s = servers.get(jobId);
  return s ? { running: true, port: s.port, url: `http://localhost:${s.port}/` } : { running: false };
}

export async function startDevServer(jobId, workspace) {
  const existing = servers.get(jobId);
  if (existing) return devServerStatus(jobId);

  const presDir = join(workspace, "presentation");
  if (!existsSync(join(presDir, "package.json"))) {
    throw new Error("presentation/ not scaffolded yet for this job");
  }

  const port = config.devServerBasePort + (jobId % 100);
  // Vite can outlive the API process during a server restart. Re-adopt that
  // deterministic per-job port instead of spawning a second --strictPort
  // process that immediately exits and leaves the UI stuck on loading.
  if (await portIsServing(port)) {
    servers.set(jobId, { child: null, port, startedAt: Date.now(), adopted: true });
    return devServerStatus(jobId);
  }

  const child = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(port), "--strictPort"],
    { cwd: presDir, shell: true, stdio: "ignore", env: process.env },
  );
  let spawnError = null;
  child.on("error", (error) => { spawnError = error; });
  child.on("close", () => {
    if (servers.get(jobId)?.child === child) servers.delete(jobId);
  });
  servers.set(jobId, { child, port, startedAt: Date.now() });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (spawnError) break;
    if (await portIsServing(port)) return devServerStatus(jobId);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  servers.delete(jobId);
  if (child.exitCode === null) killTree(child.pid);
  throw new Error(spawnError?.message || `preview service did not start on port ${port}`);
}

export function stopDevServer(jobId) {
  const s = servers.get(jobId);
  if (s) {
    if (s.child) killTree(s.child.pid);
    servers.delete(jobId);
  }
  return { running: false };
}

export function stopAllDevServers() {
  for (const jobId of [...servers.keys()]) stopDevServer(jobId);
}
