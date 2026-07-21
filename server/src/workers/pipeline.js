import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, getJob, logEvent, updateJob } from "../db.js";
import { nextStage, repairChapterQuality, repairFromEvidence, runStage, stageDef } from "../stages.js";
import { buildPresentation } from "../preview.js";
import { auditPreviewQuality, inspectPreviewQuality } from "../render.js";
import { defectSummary, recordQualityEntry } from "../qualityLedger.js";
import { lintChapters, lintDefectSummary, lintEvidence } from "../chapterLint.js";
import { cameraEvidence, validateCameraCues } from "../cameraCheck.js";
import { choreographCameras } from "../cameraChoreographer.js";
import { runEffectScore } from "../effectScoreRunner.js";
import { config } from "../config.js";
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
            const presDir = () => join(getJob(jobId).workspace, "presentation");
            // 静态规则（字号/媒体裸放等）：error 违规先自动回喂修复（≤2 轮），
            // 仍不过才判失败（2026-07-20：把"失败等人工点重试"升级为自动闭环）。
            let lint = lintChapters(presDir());
            writeFileSync(join(presDir(), "public", "quality-lint.json"), `${JSON.stringify(lint, null, 2)}\n`);
            if (lint.findings.length) {
              recordQualityEntry({ kind: "lint", jobId, errors: lint.errors, warnings: lint.warnings, defects: lintDefectSummary(lint) });
              logEvent(jobId, "quality", `静态规则：${lint.errors} 处违规、${lint.warnings} 处提醒（详见 quality-lint.json）`, lint.errors ? "error" : "info");
            }
            for (let attempt = 1; lint.errors > 0 && attempt <= 2; attempt += 1) {
              logEvent(jobId, "quality", `静态规则 ${lint.errors} 处违规，自动第 ${attempt}/2 次回喂修复`, "warning");
              const fixed = await repairFromEvidence(getJob(jobId), { title: "章节静态规则违规", evidence: lintEvidence(lint, 8), rule: "字号≥20px、颜色/字体走主题 token、截图媒体必须包 <MediaFrame> 不得裸放" });
              if (!fixed.ok) break;
              await buildPresentation(getJob(jobId));
              lint = lintChapters(presDir());
              recordQualityEntry({ kind: "lint", jobId, phase: `repair-${attempt}`, errors: lint.errors, warnings: lint.warnings, defects: lintDefectSummary(lint) });
            }
            if (lint.errors > 0) {
              throw new Error(`静态规则 ${lint.errors} 处违规（已自动修复仍未过）：${lintEvidence(lint, 3).join("；")}`);
            }
            let cameraDensity = "dense";
            let avatarEnabled = false;
            try {
              const meta = JSON.parse(getJob(jobId).meta || "{}");
              cameraDensity = meta.camera?.density || "dense";
              avatarEnabled = Boolean(meta.avatar?.enabled);
            } catch {}
            // 确定性镜头编排（2026-07-17：AI 自动 = 手排质量的保证）——
            // 走查真实 DOM 按信号编排，AI 有意声明的镜头保留、机器补齐到下限
            try {
              const plan = await choreographCameras(
                presDir(),
                `http://127.0.0.1:${config.port}/preview/${jobId}/`,
                { density: cameraDensity, avatarEnabled },
              );
              logEvent(jobId, "quality", `镜头编排完成：${Object.entries(plan.stats).map(([k, v]) => `${k}×${v}`).join(" ")}（${plan.chapters} 章 ${plan.totalSteps} 步）`);
              await buildPresentation(getJob(jobId)); // registry 变更需重建
            } catch (choreoError) {
              logEvent(jobId, "quality", `镜头编排未能运行（保留 AI 声明）：${choreoError.message}`, "warning");
            }
            // 镜头声明：error 违规同样自动回喂修复（≤2 轮）再判失败
            let camera = validateCameraCues(presDir(), { density: cameraDensity });
            for (let attempt = 1; !camera.pass && attempt <= 2; attempt += 1) {
              recordQualityEntry({ kind: "camera-check", jobId, phase: `repair-${attempt}`, errors: camera.errors, defects: { "camera-violation": camera.errors } });
              logEvent(jobId, "quality", `镜头声明 ${camera.errors} 处违规，自动第 ${attempt}/2 次回喂修复`, "warning");
              const fixed = await repairFromEvidence(getJob(jobId), { title: "镜头声明违规", evidence: cameraEvidence(camera, 8), rule: "只用词表内 effect；focus/pan/spotlight 必带真实 target；zoom∈[1.1,3.0]、focus≥1.4；每章内容镜头≤密度预算；whip 每章≤1" });
              if (!fixed.ok) break;
              await buildPresentation(getJob(jobId));
              camera = validateCameraCues(presDir(), { density: cameraDensity });
            }
            if (!camera.pass) {
              recordQualityEntry({ kind: "camera-check", jobId, errors: camera.errors, defects: { "camera-violation": camera.errors } });
              throw new Error(`镜头声明 ${camera.errors} 处违规（已自动修复仍未过）：${cameraEvidence(camera, 3).join("；")}`);
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
          // 效果打分（博主质感维）：结构分只管"不出错"，本器管"够不够博主水准"
          // （fx密度/强效果占比/平淡游程/切字）。默认只记账校准；config.effectScore.gate
          // 开启且低于 minScore 时，触发一次效果向自动修复。
          if (config.effectScore?.enabled) {
            try {
              const es = await runEffectScore(jobId, { port: config.port });
              if (!es.ok) {
                logEvent(jobId, "quality", `效果打分未能运行：${es.note}`, "warning");
              } else {
                const { score, defects = [], dimensions = {} } = es.card;
                recordQualityEntry({ kind: "effect-score", jobId, score, dimensions, defects: { "effect-defect": defects.length } });
                logEvent(jobId, "quality", `效果打分：${score}/100${defects.length ? `——${defects.slice(0, 4).join("；")}` : "（博主质感达标）"}`, score < (config.effectScore.minScore ?? 72) ? "warning" : "info");
                if (config.effectScore.gate && score < (config.effectScore.minScore ?? 72) && defects.length) {
                  logEvent(jobId, "quality", `效果分低于门禁 ${config.effectScore.minScore}，自动回喂效果向修复`, "warning");
                  const fixed = await repairFromEvidence(getJob(jobId), { title: "博主质感不足（效果打分未达标）", evidence: defects.slice(0, 8), rule: "屏上数字用 <Counter>/<Slam> 且传 word 触发；每章≥2 处 <WordMark>；关键结论/对比用 <Annotate>/<Shine>；强推近(focus/magnify)踩在关键数字步；截图包 <MediaFrame>" });
                  if (fixed.ok) {
                    await buildPresentation(getJob(jobId));
                    const es2 = await runEffectScore(jobId, { port: config.port });
                    if (es2.ok) {
                      recordQualityEntry({ kind: "effect-score", jobId, phase: "repair-1", score: es2.card.score, dimensions: es2.card.dimensions, defects: { "effect-defect": (es2.card.defects || []).length } });
                      logEvent(jobId, "quality", `效果修复后：${es2.card.score}/100`, "info");
                    }
                  }
                }
              }
            } catch (esError) {
              logEvent(jobId, "quality", `效果打分异常：${esError.message}`, "warning");
            }
          }
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

/** Approve current gate -> move to next stage and requeue.
 *  相邻门之间（无工作阶段，如 gate_avatar→gate_render）直接同步 settle 成
 *  waiting_approval，消除"queued 中转窗口"——该窗口下连续放行会静默返回
 *  false，导致作品卡在门上不动、无任何报错（2026-07-19 job-27 实翻车：
 *  成片门放行返回 false 却没被察觉，渲染从未启动，静静卡住）。 */
export function approveGate(jobId) {
  const job = getJob(jobId);
  if (!job || job.status !== "waiting_approval") return false;
  const next = nextStage(job.stage);
  const nextDef = stageDef(next);
  logEvent(jobId, job.stage, "审批通过");
  if (next === "done") {
    updateJob(jobId, { stage: "done", status: "done", error: null });
  } else if (nextDef?.kind === "gate") {
    updateJob(jobId, { stage: next, status: "waiting_approval", error: null });
    logEvent(jobId, next, `到达审批门：${nextDef.label}`);
  } else {
    updateJob(jobId, { stage: next, status: "queued", error: null });
  }
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
