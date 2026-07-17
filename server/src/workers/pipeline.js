import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, getJob, logEvent, updateJob } from "../db.js";
import { nextStage, repairChapterQuality, runStage, stageDef } from "../stages.js";
import { buildPresentation } from "../preview.js";
import { auditPreviewQuality, inspectPreviewQuality } from "../render.js";
import { defectSummary, recordQualityEntry } from "../qualityLedger.js";
import { lintChapters, lintDefectSummary, lintEvidence } from "../chapterLint.js";
import { cameraEvidence, validateCameraCues } from "../cameraCheck.js";
import { preflightWarnings } from "../preflight.js";

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
        updateJob(jobId, { status: "failed", error: "无法识别当前制作步骤，请重试或检查版本" });
        logEvent(jobId, job.stage, "unknown stage", "error");
        break;
      }
      if (def.kind === "gate") {
        updateJob(jobId, { status: job.stage === "done" ? "done" : "waiting_approval" });
        logEvent(jobId, job.stage, def.id === "done" ? "全部完成" : `到达审批门：${def.label}`);
        break;
      }

      // 开工预检：第一个工作阶段启动时给出依赖服务预警（不阻断——服务可能
      // 中途才启动；硬检查仍在各消费阶段自检）。
      if (job.stage === "script_outline") {
        try {
          let meta = {};
          try { meta = JSON.parse(job.meta || "{}"); } catch {}
          for (const warning of await preflightWarnings(meta)) {
            logEvent(jobId, "preflight", warning, "warning");
          }
        } catch (err) {
          logEvent(jobId, "preflight", `服务预检未能运行：${err.message}`, "warning");
        }
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
        updateJob(jobId, { status: "failed", error: result.note || "当前步骤没有完成" });
        logEvent(jobId, job.stage, `stage FAILED after ${secs}s${result.note ? `: ${result.note}` : ""}`, "error");
        break;
      }
      if (job.stage === "chapter_gen") {
        try {
          await buildPresentation(getJob(jobId));
          // 静态 linter 执法模式（2026-07-16 转正：7 个满分作品实测零误伤）：
          // error 级违规直接判章节生成失败并给出毫秒级归因证据；warn 只记账。
          try {
            const lint = lintChapters(join(getJob(jobId).workspace, "presentation"));
            writeFileSync(join(getJob(jobId).workspace, "presentation", "public", "quality-lint.json"), `${JSON.stringify(lint, null, 2)}\n`);
            if (lint.findings.length) {
              recordQualityEntry({ kind: "lint", jobId, errors: lint.errors, warnings: lint.warnings, defects: lintDefectSummary(lint) });
              logEvent(jobId, "quality", `静态规则：${lint.errors} 处违规、${lint.warnings} 处提醒（详见 quality-lint.json）`, lint.errors ? "error" : "info");
            }
            if (lint.errors > 0) {
              throw new Error(`静态规则 ${lint.errors} 处违规：${lintEvidence(lint, 3).join("；")}（确定性检查，重试本环节会重新生成）`);
            }
            let cameraDensity = "dense";
            try { cameraDensity = JSON.parse(getJob(jobId).meta || "{}").camera?.density || "dense"; } catch {}
            const camera = validateCameraCues(join(getJob(jobId).workspace, "presentation"), { density: cameraDensity });
            if (!camera.pass) {
              recordQualityEntry({ kind: "camera-check", jobId, errors: camera.errors, defects: { "camera-violation": camera.errors } });
              throw new Error(`镜头声明 ${camera.errors} 处违规：${cameraEvidence(camera, 3).join("；")}（确定性检查，重试本环节会重新生成）`);
            }
          } catch (lintError) {
            if (/处违规/.test(lintError.message)) throw lintError;
            logEvent(jobId, "quality", `静态 linter 未能运行：${lintError.message}`, "error");
          }
          let audit = await inspectPreviewQuality(getJob(jobId));
          if (!audit.pass) audit = await auditPreviewQuality(getJob(jobId));
          recordQualityEntry({ kind: "audit", jobId, phase: "first", score: audit.score, pass: audit.pass, checkedSteps: audit.checkedSteps, defects: defectSummary(audit) });
          for (let attempt = 1; !audit.pass && attempt <= 3; attempt += 1) {
            const worst = audit.worstStep;
            logEvent(jobId, "quality", `自动画面验收 ${audit.score}/100，开始第 ${attempt}/3 次修复${worst ? `（第 ${worst.chapter + 1} 章第 ${worst.step + 1} 屏）` : ""}`, "error");
            const repaired = await repairChapterQuality(getJob(jobId), audit);
            if (!repaired.ok) throw new Error(`第 ${attempt} 次自动修复失败：${repaired.note || "模型未完成修复"}`);
            await buildPresentation(getJob(jobId));
            const before = audit.score;
            audit = await inspectPreviewQuality(getJob(jobId));
            if (!audit.pass) audit = await auditPreviewQuality(getJob(jobId));
            recordQualityEntry({ kind: "repair-round", jobId, round: attempt, scoreBefore: before, scoreAfter: audit.score, pass: audit.pass, defects: defectSummary(audit) });
          }
          if (!audit.pass) {
            const worst = audit.worstStep;
            throw new Error(`逐屏画面验收仅 ${audit.score}/100，低于 90 分${worst ? `；最低分为第 ${worst.chapter + 1} 章第 ${worst.step + 1} 屏` : ""}。已保留最低分截图，未进入人工验收。`);
          }
          logEvent(jobId, "quality", `结构质量门禁通过：${audit.score}/100，共检查 ${audit.checkedSteps} 屏${audit.screenshotsCaptured ? `，留存 ${audit.screenshotsCaptured} 张问题复核截图` : "，无需截图修复"}`);
        } catch (error) {
          result = { ok: false, note: `画面构建未通过，尚未进入验收：${error.message}` };
          updateJob(jobId, { status: "failed", error: result.note });
          logEvent(jobId, job.stage, `stage FAILED after ${secs}s: ${result.note}`, "error");
          break;
        }
      }
      logEvent(jobId, job.stage, `stage ok (${secs}s)${result.note ? `\n${result.note}` : ""}`);
      updateJob(jobId, { stage: nextStage(job.stage), error: null });
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
  updateJob(jobId, { stage: nextStage(job.stage), status: "queued", error: null });
  logEvent(jobId, job.stage, "审批通过");
  return true;
}

/** Requeue a failed job at its current (or a specific) stage. */
export function retryJob(jobId, stage) {
  const job = getJob(jobId);
  if (!job) return false;
  const targetStage = stage ?? job.stage;
  if (["queued", "running"].includes(job.status) && targetStage === job.stage) return true;
  if (targetStage === "gate_style" && job.stage !== "gate_style") {
    // Changing style is a full visual restart. Keeping the previous
    // presentation makes chapterGeneration report N/N and lets stale slides,
    // subtitles, audio and avatar artifacts leak into the new run.
    const presentation = join(job.workspace, "presentation");
    if (existsSync(presentation)) {
      // A legacy Vite preview may keep this directory as its Windows cwd,
      // which makes removing the root fail with EPERM. Clearing every child
      // preserves the locked root while still guaranteeing a fresh scaffold.
      for (const name of readdirSync(presentation)) {
        rmSync(join(presentation, name), { recursive: true, force: true });
      }
    }
    rmSync(join(job.workspace, "render-tmp"), { recursive: true, force: true });
    rmSync(join(job.workspace, "output.mp4"), { force: true });
    rmSync(join(job.workspace, "render-meta.json"), { force: true });
    db.prepare("DELETE FROM chapter_reviews WHERE job_id = ?").run(jobId);
    logEvent(jobId, targetStage, "已清空旧画面和下游产物，新风格将从 0 章重新生成");
  }
  updateJob(jobId, { ...(stage ? { stage } : {}), status: "queued", error: null });
  logEvent(jobId, targetStage, "手动重试");
  return true;
}
