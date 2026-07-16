import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 账本落 DATA_ROOT——测试前指到临时目录，并预置 node_modules 目录
// 跳过 provisioning 的大文件复制。必须在任何 config.js 导入之前设置。
const testRoot = mkdtempSync(join(tmpdir(), "vf-ledger-"));
mkdirSync(join(testRoot, "workspaces", "node_modules"), { recursive: true });
writeFileSync(join(testRoot, "data.db"), "");
process.env.VIDEOFORGE_DATA_DIR = testRoot;

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;
const { recordQualityEntry, ledgerStats, defectSummary } = await import("./qualityLedger.js");

test("defectSummary 从审计结果归因缺陷类型", () => {
  const audit = {
    steps: [
      { pass: true },
      { pass: false, visual: { collisions: 2, subtitleTextLength: 12 }, overflowCount: 1 },
      { pass: false, visual: { longContentBlocks: 1, subtitleLines: 2 } },
    ],
  };
  const defects = defectSummary(audit);
  assert.equal(defects.collision, 1);
  assert.equal(defects.overflow, 1);
  assert.equal(defects["subtitle-too-long"], 1);
  assert.equal(defects["long-content"], 1);
  assert.equal(defects["subtitle-multiline"], 1);
});

test("账本写入与统计闭环（含二次出现铁律触发器）", () => {
  recordQualityEntry({ kind: "audit", jobId: 901, phase: "first", score: 42, defects: { overflow: 3 } });
  recordQualityEntry({ kind: "audit", jobId: 902, phase: "first", score: 78, defects: { overflow: 1, collision: 1 } });
  recordQualityEntry({ kind: "repair-round", jobId: 901, round: 1, scoreBefore: 42, scoreAfter: 95 });
  const stats = ledgerStats(30);
  assert.equal(stats.jobs, 2);
  assert.equal(stats.firstScoreMedian, 78);
  assert.equal(stats.defectCounts.overflow, 4);
  // overflow 出现 ≥2 次 → 必须回写持久层
  assert.ok(stats.repeatOffenders.some((item) => item.type === "overflow"));
  assert.ok(!stats.repeatOffenders.some((item) => item.type === "collision"));
});
