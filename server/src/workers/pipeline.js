import { db, getJob, logEvent, updateJob } from "../db.js";
import { nextStage, runStage, stageDef } from "../stages.js";

/**
 * DB-backed job runner. Picks queued jobs, runs their current stage,
 * advances until it hits a gate (waiting_approval) or a failure.
 * In-process set guards against double-running while a stage is async.
 */
const inFlight = new Set();
const MAX_PARALLEL_JOBS = 2;

async function advance(jobId) {
  if (inFlight.has(jobId)) return;
  inFlight.add(jobId);
  try {
    // Loop through consecutive work stages so one pick-up runs as far as it can.
    for (;;) {
      const job = getJob(jobId);
      if (!job || job.status !== "running") break;

      const def = stageDef(job.stage);
      if (!def) {
        updateJob(jobId, { status: "failed" });
        logEvent(jobId, job.stage, "unknown stage", "error");
        break;
      }
      if (def.kind === "gate") {
        updateJob(jobId, { status: job.stage === "done" ? "done" : "waiting_approval" });
        logEvent(jobId, job.stage, def.id === "done" ? "全部完成" : `到达审批门：${def.label}`);
        break;
      }

      logEvent(jobId, job.stage, `stage start: ${def.label}`);
      const t0 = Date.now();
      let result;
      try {
        result = await runStage(job);
      } catch (err) {
        result = { ok: false, note: String(err?.stack ?? err) };
      }
      const secs = Math.round((Date.now() - t0) / 1000);

      if (!result.ok) {
        updateJob(jobId, { status: "failed" });
        logEvent(jobId, job.stage, `stage FAILED after ${secs}s${result.note ? `: ${result.note}` : ""}`, "error");
        break;
      }
      logEvent(jobId, job.stage, `stage ok (${secs}s)${result.note ? `\n${result.note}` : ""}`);
      updateJob(jobId, { stage: nextStage(job.stage) });
    }
  } finally {
    inFlight.delete(jobId);
  }
}

function tick() {
  if (inFlight.size >= MAX_PARALLEL_JOBS) return;
  const rows = db
    .prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT ?")
    .all(MAX_PARALLEL_JOBS - inFlight.size);
  for (const { id } of rows) {
    updateJob(id, { status: "running" });
    void advance(id);
  }
}

export function startPipelineWorker() {
  // Recover: anything left 'running' by a previous process crash goes back
  // to queued so it re-enters cleanly (stages are idempotent-ish: agent
  // stages re-run, deterministic stages skip existing outputs).
  db.exec("UPDATE jobs SET status = 'queued' WHERE status = 'running'");
  setInterval(tick, 3000);
}

/** Approve current gate -> move to next stage and requeue. */
export function approveGate(jobId) {
  const job = getJob(jobId);
  if (!job || job.status !== "waiting_approval") return false;
  updateJob(jobId, { stage: nextStage(job.stage), status: "queued" });
  logEvent(jobId, job.stage, "审批通过");
  return true;
}

/** Requeue a failed job at its current (or a specific) stage. */
export function retryJob(jobId, stage) {
  const job = getJob(jobId);
  if (!job) return false;
  updateJob(jobId, { ...(stage ? { stage } : {}), status: "queued" });
  logEvent(jobId, stage ?? job.stage, "手动重试");
  return true;
}
