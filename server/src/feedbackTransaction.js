import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { logEvent } from "./db.js";
import { runFeedback } from "./stages.js";
import { buildPresentation, typecheckPresentation } from "./preview.js";
import { inspectPreviewQuality } from "./render.js";
import { recordQualityEntry } from "./qualityLedger.js";

/**
 * 受保护事务（QUALITY-ARCHITECTURE §4 / §9 R2）。
 *
 * 把右侧对话的 Agent 修改包成事务：改前快照 + 基线分 → Agent 最小修改
 * → 服务端按真实文件差异校验白名单（不信模型自述）→ typecheck + build
 * → 结构门禁重跑 → 分数不降才保留，否则整体还原。
 * 保证修改"最多无效、不会变坏"。
 */

const SNAPSHOT_DIR = ".feedback-snapshot";

function walkFiles(root, base = root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return walkFiles(path, base);
    return [relative(base, path).replace(/\\/g, "/")];
  });
}

function hashFile(path) {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

/** src 目录快照：文件复制 + 内容哈希清单。返回 manifest。 */
export function snapshotPresentationSrc(presDir) {
  const srcDir = join(presDir, "src");
  const snapDir = join(presDir, SNAPSHOT_DIR);
  rmSync(snapDir, { recursive: true, force: true });
  const manifest = {};
  for (const rel of walkFiles(srcDir)) {
    const from = join(srcDir, rel);
    const to = join(snapDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    manifest[rel] = hashFile(from);
  }
  return manifest;
}

/** 与快照对比真实差异：改动/新增/删除的相对路径列表。 */
export function diffAgainstSnapshot(presDir, manifest) {
  const srcDir = join(presDir, "src");
  const current = new Set(walkFiles(srcDir));
  const changed = [];
  for (const rel of current) {
    const hash = hashFile(join(srcDir, rel));
    if (manifest[rel] !== hash) changed.push(rel);
  }
  for (const rel of Object.keys(manifest)) {
    if (!current.has(rel)) changed.push(rel);
  }
  return changed.sort();
}

/** 白名单：chapter 反馈只允许写选中章节目录和明确注册文件。 */
export function isPathAllowed(rel, chapterKey) {
  if (!chapterKey) return true; // 全局反馈：范围由分数与构建保护
  const allowedExact = new Set(["registry/chapters.ts", "hooks/useStepper.ts"]);
  return rel.startsWith(`chapters/${chapterKey}/`) || allowedExact.has(rel);
}

/** 从快照还原指定文件（或全部）。 */
export function restoreFromSnapshot(presDir, manifest, files = null) {
  const srcDir = join(presDir, "src");
  const snapDir = join(presDir, SNAPSHOT_DIR);
  const targets = files ?? [...new Set([...Object.keys(manifest), ...walkFiles(srcDir)])];
  for (const rel of targets) {
    const snap = join(snapDir, rel);
    const live = join(srcDir, rel);
    if (existsSync(snap)) {
      mkdirSync(dirname(live), { recursive: true });
      copyFileSync(snap, live);
    } else if (existsSync(live)) {
      unlinkSync(live); // 快照里没有 = Agent 新增的文件，越界即删除
    }
  }
}

export function dropSnapshot(presDir) {
  rmSync(join(presDir, SNAPSHOT_DIR), { recursive: true, force: true });
}

function readBaselineScore(presDir) {
  try {
    const audit = JSON.parse(readFileSync(join(presDir, "public", "quality-audit.json"), "utf8"));
    return Number.isFinite(audit.score) ? audit.score : null;
  } catch {
    return null;
  }
}

/**
 * 事务化执行一次影响画面的反馈修改。
 * 返回 runFeedback 兼容结构 + { rolledBack, violations, scoreBefore, scoreAfter }。
 */
export async function runProtectedFeedback(job, params) {
  const { chapter, onProgress = () => {} } = params;
  const presDir = join(job.workspace, "presentation");
  const chapterKey = chapter ? chapter.replace(/\\/g, "/").split("/").pop() : null;

  onProgress(6, "正在建立修改前快照与质量基线");
  const manifest = snapshotPresentationSrc(presDir);
  const scoreBefore = readBaselineScore(presDir);

  const rollback = async (reason) => {
    restoreFromSnapshot(presDir, manifest);
    dropSnapshot(presDir);
    try { await buildPresentation(job); } catch {}
    logEvent(job.id, "feedback", `受保护事务回滚：${reason}`, "error");
    recordQualityEntry({ kind: "feedback-tx", jobId: job.id, chapter: chapterKey, outcome: "rolled-back", reason: String(reason).slice(0, 200), scoreBefore });
    return { ok: false, output: "", note: `修改已自动还原（${reason}）。作品保持修改前的状态，可换一种说法重试。`, rolledBack: true };
  };

  let agentResult;
  try {
    agentResult = await runFeedback(job, params);
  } catch (error) {
    return rollback(`模型执行异常：${error.message}`);
  }
  if (!agentResult.ok) {
    return rollback(agentResult.note || "模型没有完成修改");
  }

  // 服务端按真实文件差异校验白名单——不信任模型自述
  const changed = diffAgainstSnapshot(presDir, manifest);
  const violations = changed.filter((rel) => !isPathAllowed(rel, chapterKey));
  if (violations.length) {
    restoreFromSnapshot(presDir, manifest, violations);
    logEvent(job.id, "feedback", `越界修改已还原 ${violations.length} 个文件：${violations.slice(0, 5).join("、")}${violations.length > 5 ? "…" : ""}`, "error");
  }
  const kept = changed.filter((rel) => isPathAllowed(rel, chapterKey));
  if (!kept.length) {
    dropSnapshot(presDir);
    return { ok: true, output: `${agentResult.output || ""}\n（本次没有产生允许范围内的文件改动）`, violations: violations.length };
  }

  onProgress(72, "正在验证修改（类型检查与构建）");
  const checked = await typecheckPresentation(presDir, job.id, "feedback");
  if (!checked.ok) return rollback("TypeScript 检查未通过");
  try {
    await buildPresentation(job);
  } catch (error) {
    return rollback(`构建失败：${error.message}`);
  }

  onProgress(82, "正在重跑结构质量门禁对比分数");
  let scoreAfter = null;
  try {
    const audit = await inspectPreviewQuality(job);
    scoreAfter = audit.score;
  } catch (error) {
    // 门禁自身故障不没收用户的合法修改，但要留痕
    logEvent(job.id, "feedback", `事务后质量门禁未能运行：${error.message}`, "error");
  }
  if (scoreBefore != null && scoreAfter != null && scoreAfter < scoreBefore) {
    return rollback(`质量分从 ${scoreBefore} 降到 ${scoreAfter}`);
  }

  dropSnapshot(presDir);
  recordQualityEntry({ kind: "feedback-tx", jobId: job.id, chapter: chapterKey, outcome: "kept", scoreBefore, scoreAfter, changedFiles: kept.length, violations: violations.length });
  logEvent(job.id, "feedback", `受保护事务通过：改动 ${kept.length} 个文件${violations.length ? `（另有 ${violations.length} 个越界改动已还原）` : ""}，质量分 ${scoreBefore ?? "?"} → ${scoreAfter ?? "?"}`);
  return { ...agentResult, violations: violations.length, scoreBefore, scoreAfter };
}
