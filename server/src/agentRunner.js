import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { logEvent } from "./db.js";

let running = 0;
const queue = [];

/**
 * Headless `claude -p` in an UNTRUSTED directory silently ignores all
 * permission rules ("this workspace has not been trusted") — which is why
 * pipeline agents spawned in freshly created workspaces/job-N dirs failed
 * with empty output. The CLI's own suggested fix: mark the project trusted
 * in ~/.claude.json. Do that idempotently before every spawn.
 */
export function ensureWorkspaceTrusted(cwd) {
  try {
    const p = join(homedir(), ".claude.json");
    const j = JSON.parse(readFileSync(p, "utf8"));
    const key = cwd.replace(/\\/g, "/");
    j.projects ??= {};
    if (!j.projects[key]?.hasTrustDialogAccepted) {
      j.projects[key] = { ...(j.projects[key] ?? {}), hasTrustDialogAccepted: true };
      writeFileSync(p, JSON.stringify(j, null, 2));
    }
    return true;
  } catch (err) {
    console.warn(`ensureWorkspaceTrusted failed (${err.message}) — agent may run with restricted tools`);
    return false;
  }
}

/**
 * Run a headless agent (claude -p) in a workspace directory, prompt via
 * stdin. Personal-use mode: rides the local Claude Code login, no API key.
 * Concurrency-capped (config.agent.maxConcurrent) so parallel jobs don't
 * trample the subscription rate limit.
 *
 * Returns { ok, output } — output is combined stdout tail for logging.
 */
export function runAgent({ jobId, stage, cwd, prompt }) {
  return new Promise((resolve) => {
    const task = () => {
      running++;
      const trusted = ensureWorkspaceTrusted(cwd);
      logEvent(jobId, stage, `agent start (cwd=${cwd}, trusted=${trusted})`);

      const child = spawn(config.agent.command, config.agent.args, {
        cwd,
        shell: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      const cap = (s) => (s.length > 20000 ? s.slice(-20000) : s);
      child.stdout.on("data", (d) => (out = cap(out + d)));
      child.stderr.on("data", (d) => (err = cap(err + d)));

      const timer = setTimeout(() => {
        logEvent(jobId, stage, "agent timeout — killing", "error");
        killTree(child.pid);
      }, config.agent.timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        running--;
        drain();
        const ok = code === 0;
        logEvent(
          jobId,
          stage,
          ok
            ? `agent done\n--- tail ---\n${out.slice(-1500)}`
            : `agent exit ${code}\n--- stderr ---\n${err.slice(-1500)}\n--- stdout ---\n${out.slice(-1500)}`,
          ok ? "info" : "error",
        );
        resolve({ ok, output: out });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    };

    if (running < config.agent.maxConcurrent) task();
    else queue.push(task);
  });
}

function drain() {
  if (queue.length > 0 && running < config.agent.maxConcurrent) {
    queue.shift()();
  }
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}
