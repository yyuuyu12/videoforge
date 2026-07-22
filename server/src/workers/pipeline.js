import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { clearCancel, isCancelling, requestCancel, throwIfCancelled } from "../cancellation.js";

// 取消入口的再导出：与 retryJob/approveGate 并列，routes 从 pipeline 统一取用。
export const cancelJob = requestCancel;

/**
 * DB-backed job runner. Picks queued jobs, runs their current stage,
 * advances until it hits a gate (waiting_approval) or a failure.
 * In-process set guards against double-running while a stage is async.
 */
const inFlight = new Set();
const MAX_PARALLEL_JOBS = 2;

// 质量修复循环的结构化实时态 sidecar：仿 .videoforge-chapter-progress.json，
// 经 routes 的 chapterGeneration.quality 下发给前端。best-effort、绝不 throw，
// 不得拖慢/中断循环；原子写（temp+rename）避免前端读到半截。
const QUALITY_PROGRESS_FILE = ".videoforge-quality-progress.json";
function writeQualityProgress(workspace, patch) {
  try {
    const path = join(workspace, "presentation", QUALITY_PROGRESS_FILE);
    let current = {};
    try { current = JSON.parse(readFileSync(path, "utf8")); } catch { /* 首次写或读到半截 */ }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...current, ...patch, updatedAt: new Date().toISOString() }));
    renameSync(tmp, path);
  } catch { /* 进度 sidecar 仅供展示，任何异常都不得影响质量循环 */ }
}

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
        if (err?.cancelled || isCancelling(jobId)) break; // 取消：不落 failed，finally 收敛为 cancelled
        result = { ok: false, note: String(err?.stack ?? err) };
      }
      const secs = Math.round((Date.now() - t0) / 1000);

      if (!result.ok) {
        if (isCancelling(jobId)) break; // 取消导致的 !ok 不写 failed
        const note = result.note || "当前步骤没有完成";
        // 网络类瞬时故障自动重排（2026-07-22 job-33/34 实证：上游 504/fetch
        // failed 耗尽调用内重试后阶段判 failed 等人工点重试，观感=莫名卡死）。
        // 每阶段最多自动重排 2 次、45s 退避；等待期保持 running，服务重启时
        // 恢复逻辑会照常回队列，不丢任务。非网络类错误照旧人工介入。
        const transient = /fetch failed|HTTP 5\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|上游返回非 JSON/i.test(note);
        if (transient) {
          let meta = {};
          try { meta = JSON.parse(getJob(jobId).meta || "{}"); } catch {}
          const retries = meta.autoRetries?.[job.stage] || 0;
          if (retries < 2) {
            updateJob(jobId, { meta: JSON.stringify({ ...meta, autoRetries: { ...(meta.autoRetries || {}), [job.stage]: retries + 1 } }) });
            logEvent(jobId, job.stage, `网络类故障，45s 后自动重试（第 ${retries + 1}/2 次）：${note.slice(0, 200)}`, "warning");
            setTimeout(() => {
              try {
                const current = getJob(jobId);
                if (current?.status === "running" && current.stage === job.stage) updateJob(jobId, { status: "queued" });
              } catch {}
            }, 45000);
            break;
          }
        }
        updateJob(jobId, { status: "failed", error: note });
        logEvent(jobId, job.stage, `stage FAILED after ${secs}s: ${note}`, "error");
        break;
      }
      if (job.stage === "chapter_gen") {
        const ws = getJob(jobId).workspace;
        // 逐屏审计的进度回调：把"正在校验第 X 章第 Y 屏"写进 sidecar
        const auditProgress = (phase) => ({ chapter, step }) => writeQualityProgress(ws, { phase, chapter, step });
        try {
          writeQualityProgress(ws, { phase: "lint", round: 0, maxRound: 2, chapter: null, step: null, score: null, targetScore: null, checkedSteps: null, startedAt: new Date().toISOString(), roundStartedAt: new Date().toISOString() });
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
              throwIfCancelled(jobId);
              writeQualityProgress(ws, { phase: "lint", round: attempt, maxRound: 2, roundStartedAt: new Date().toISOString() });
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
              throwIfCancelled(jobId);
              writeQualityProgress(ws, { phase: "camera", round: attempt, maxRound: 2, roundStartedAt: new Date().toISOString() });
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
            if (lintError?.cancelled) throw lintError; // 取消必须穿透，不得当作 linter 故障吞掉
            if (/处违规/.test(lintError.message)) throw lintError;
            logEvent(jobId, "quality", `静态 linter 未能运行：${lintError.message}`, "error");
          }
          writeQualityProgress(ws, { phase: "audit", round: 0, maxRound: 3, targetScore: 90, chapter: null, step: null, roundStartedAt: new Date().toISOString() });
          let audit = await inspectPreviewQuality(getJob(jobId), { onProgress: auditProgress("audit") });
          if (!audit.pass) audit = await auditPreviewQuality(getJob(jobId), { onProgress: auditProgress("audit") });
          recordQualityEntry({ kind: "audit", jobId, phase: "first", score: audit.score, pass: audit.pass, checkedSteps: audit.checkedSteps, defects: defectSummary(audit) });
          for (let attempt = 1; !audit.pass && attempt <= 3; attempt += 1) {
            throwIfCancelled(jobId);
            const worst = audit.worstStep;
            writeQualityProgress(ws, { phase: "repair", round: attempt, maxRound: 3, score: audit.score, targetScore: 90, chapter: worst ? worst.chapter + 1 : null, step: worst ? worst.step + 1 : null, checkedSteps: audit.checkedSteps, roundStartedAt: new Date().toISOString() });
            logEvent(jobId, "quality", `自动画面验收 ${audit.score}/100，开始第 ${attempt}/3 次修复${worst ? `（第 ${worst.chapter + 1} 章第 ${worst.step + 1} 屏）` : ""}`, "error");
            const repaired = await repairChapterQuality(getJob(jobId), audit);
            if (!repaired.ok) throw new Error(`第 ${attempt} 次自动修复失败：${repaired.note || "模型未完成修复"}`);
            await buildPresentation(getJob(jobId));
            const before = audit.score;
            audit = await inspectPreviewQuality(getJob(jobId), { onProgress: auditProgress("repair") });
            if (!audit.pass) audit = await auditPreviewQuality(getJob(jobId), { onProgress: auditProgress("repair") });
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
              throwIfCancelled(jobId);
              writeQualityProgress(ws, { phase: "effect", round: 0, maxRound: 1, score: null, targetScore: (config.effectScore.minScore ?? 72), chapter: null, step: null, roundStartedAt: new Date().toISOString() });
              const es = await runEffectScore(jobId, { port: config.port });
              if (!es.ok) {
                logEvent(jobId, "quality", `效果打分未能运行：${es.note}`, "warning");
              } else {
                const { score, defects = [], dimensions = {} } = es.card;
                recordQualityEntry({ kind: "effect-score", jobId, score, dimensions, defects: { "effect-defect": defects.length } });
                logEvent(jobId, "quality", `效果打分：${score}/100${defects.length ? `——${defects.slice(0, 4).join("；")}` : "（博主质感达标）"}`, score < (config.effectScore.minScore ?? 72) ? "warning" : "info");
                const minScore = config.effectScore.minScore ?? 72;
                if (config.effectScore.gate && score < minScore && defects.length) {
                  writeQualityProgress(ws, { phase: "effect", round: 1, maxRound: 1, score, targetScore: minScore, roundStartedAt: new Date().toISOString() });
                  logEvent(jobId, "quality", `效果分低于门禁 ${minScore}，自动回喂效果向修复`, "warning");
                  const fixed = await repairFromEvidence(getJob(jobId), { title: "博主质感不足（效果打分未达标）", evidence: defects.slice(0, 8), rule: "屏上数字用 <Counter>/<Slam> 且传 word 触发；每章≥2 处 <WordMark>；关键结论/对比用 <Annotate>/<Shine>；强推近(focus/magnify)踩在关键数字步；截图包 <MediaFrame>" });
                  let after = score;
                  if (fixed.ok) {
                    await buildPresentation(getJob(jobId));
                    const es2 = await runEffectScore(jobId, { port: config.port });
                    if (es2.ok) {
                      after = es2.card.score;
                      recordQualityEntry({ kind: "effect-score", jobId, phase: "repair-1", score: after, dimensions: es2.card.dimensions, defects: { "effect-defect": (es2.card.defects || []).length } });
                      logEvent(jobId, "quality", `效果修复后：${after}/100`, after < minScore ? "warning" : "info");
                    }
                  }
                  // 门禁语义（2026-07-22 开门）：修复一轮仍不达标 = 阶段失败，
                  // 与结构门同权重——绝不再把"画面偏平"的作品送到人工验收面前。
                  if (after < minScore) {
                    throw new Error(`效果打分 ${after}/100 低于门禁 ${minScore}（已自动修复一轮仍未达标）：${defects.slice(0, 3).join("；")}`);
                  }
                }
              }
            } catch (esError) {
              // 门禁失败必须穿透（与 lint 的 /处违规/ 同款）；只有打分器自身
              // 故障（起不来/超时）才降级为警告，不因测量工具挂了冤枉作品。
              if (esError?.cancelled) throw esError; // 取消同样必须穿透
              if (/低于门禁/.test(esError.message)) throw esError;
              logEvent(jobId, "quality", `效果打分异常：${esError.message}`, "warning");
            }
          }
          writeQualityProgress(ws, { phase: "done" });
        } catch (error) {
          if (error?.cancelled || isCancelling(jobId)) break; // 取消：交给 finally 收敛为 cancelled
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
    // 取消收尾：若仍停在 cancelling（协作检查点或在飞中止让循环退出），落定为
    // cancelled 终态、stage 原地不动（TTS/avatar/render 皆断点续跑幂等，从原阶段
    // 重试即续跑）。cancelled 既非 running 也非 queued，两条 resume 路径都不碰它。
    try {
      const fin = getJob(jobId);
      if (fin?.status === "cancelling") {
        updateJob(jobId, { status: "cancelled", error: "已被用户取消" });
        logEvent(jobId, fin.stage, "已取消：停在当前阶段并保留已完成产物，可从当前环节继续", "warning");
      }
    } catch { /* 收尾不得抛 */ }
    clearCancel(jobId);
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
  // 取消中途进程崩溃收敛：cancelling 未及落定 cancelled 的，重启时补落定，
  // 绝不回落 running/queued 被 resume 重跑。
  db.exec("UPDATE jobs SET status = 'cancelled' WHERE status = 'cancelling'");
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
