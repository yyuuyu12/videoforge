import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "./config.js";

/**
 * 质量记账本（QUALITY-ARCHITECTURE §8 L1）。
 *
 * 每次审计、修复轮和反馈事务追加一条 JSONL 账目到 DATA_ROOT/quality-ledger.jsonl
 * （本机旧布局 = 仓库根）。它是"同类缺陷第二次出现必须回写持久层"铁律的
 * 判定依据，也是"首次生成分数是否在提升"的唯一统计来源。
 * 账本是本机遥测，不进 Git；每周汇总结论写 docs/ 报告。
 */
const LEDGER_PATH = join(DATA_ROOT, "quality-ledger.jsonl");

export function recordQualityEntry(entry) {
  try {
    appendFileSync(LEDGER_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    console.warn(`quality-ledger 写入失败：${error.message}`);
  }
}

/** 从审计结果提取可归因的缺陷类型计数（回写决策的输入）。 */
export function defectSummary(audit) {
  const defects = {};
  const bump = (key) => { defects[key] = (defects[key] || 0) + 1; };
  for (const step of audit?.steps || []) {
    if (step.pass) continue;
    if ((step.visual?.collisions || 0) > 0) bump("collision");
    if ((step.overflowCount || 0) > 0) bump("overflow");
    if ((step.visual?.subtitleLines || 0) > 1) bump("subtitle-multiline");
    if ((step.visual?.subtitleTextLength || 0) > 10) bump("subtitle-too-long");
    if ((step.visual?.longContentBlocks || 0) > 0) bump("long-content");
    if ((step.visual?.titleLines || 0) > 2) bump("title-lines");
  }
  return defects;
}

/** 聚合统计：按周看首次分中位数与缺陷类型频次（回写铁律的仪表盘）。 */
export function ledgerStats(days = 30) {
  if (!existsSync(LEDGER_PATH)) return { entries: 0, firstScores: [], defectCounts: {}, repeatOffenders: [] };
  const since = Date.now() - days * 86400000;
  const lines = readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (new Date(item.at).getTime() >= since) entries.push(item);
    } catch {}
  }
  const firstAuditByJob = new Map();
  const defectCounts = {};
  for (const item of entries) {
    if (item.kind === "audit" && item.jobId != null && !firstAuditByJob.has(item.jobId)) {
      firstAuditByJob.set(item.jobId, item.score);
    }
    for (const [key, count] of Object.entries(item.defects || {})) {
      defectCounts[key] = (defectCounts[key] || 0) + count;
    }
  }
  const firstScores = [...firstAuditByJob.values()].sort((a, b) => a - b);
  const median = firstScores.length
    ? firstScores[Math.floor(firstScores.length / 2)]
    : null;
  // 铁律触发器：30 天内出现 ≥2 次的缺陷类型 = 必须回写持久层
  const repeatOffenders = Object.entries(defectCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));
  return { entries: entries.length, jobs: firstAuditByJob.size, firstScoreMedian: median, firstScores, defectCounts, repeatOffenders };
}
