import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSubtitleCues, cueEvidence, CUE_HARD_LIMIT } from "./subtitleCheck.js";

function makeRegistry(obj) {
  const presDir = mkdtempSync(join(tmpdir(), "vf-cue-"));
  mkdirSync(join(presDir, "src", "registry"), { recursive: true });
  writeFileSync(
    join(presDir, "src", "registry", "subtitleCues.ts"),
    `export interface SubtitleCue { text: string; startMs: number; }\nexport const SUBTITLE_CUES: Record<string, SubtitleCue[][]> = ${JSON.stringify(obj)};\n`,
  );
  return presDir;
}

test("合规 cue 数据通过（10 字上限、时间递增）", () => {
  const presDir = makeRegistry({
    hook: [[{ text: "你正在选工具", startMs: 40 }, { text: "先看这三件事", startMs: 1800 }]],
  });
  const result = validateSubtitleCues(presDir);
  assert.equal(result.pass, true);
  assert.equal(result.findings.length, 0);
});

test("超长 cue 被判定为 error（job-13/14 回归缺陷）", () => {
  const presDir = makeRegistry({
    hook: [[{ text: "这是一条超过十个字上限的很长很长的字幕内容", startMs: 40 }]],
  });
  const result = validateSubtitleCues(presDir);
  assert.equal(result.pass, false);
  assert.match(cueEvidence(result)[0], /cue-too-long/);
  assert.ok(cueEvidence(result)[0].includes(`${CUE_HARD_LIMIT} 字硬上限`));
});

test("cue 尾部分隔标点判定为 error（？！豁免）", () => {
  const bad = makeRegistry({ hook: [[{ text: "先看这三件事，", startMs: 40 }]] });
  const badResult = validateSubtitleCues(bad);
  assert.equal(badResult.pass, false);
  assert.equal(badResult.findings[0].rule, "cue-trailing-punct");
  const ok = makeRegistry({ hook: [[{ text: "越亮越安全吗？", startMs: 40 }]] });
  assert.equal(validateSubtitleCues(ok).pass, true);
});

test("不可拆的纯拉丁整词豁免上限（如 Transformer）", () => {
  const presDir = makeRegistry({
    hook: [[{ text: "Transformer", startMs: 40 }, { text: "改变了一切", startMs: 900 }]],
  });
  const result = validateSubtitleCues(presDir);
  assert.equal(result.pass, true);
});

test("时间戳不递增被判定为 error", () => {
  const presDir = makeRegistry({
    hook: [[{ text: "第一句", startMs: 500 }, { text: "第二句", startMs: 300 }]],
  });
  const result = validateSubtitleCues(presDir);
  assert.equal(result.pass, false);
  assert.match(result.findings[0].rule, /cue-time-order/);
});

test("空 step 只警告不阻断（兜底路径接管）", () => {
  const presDir = makeRegistry({ hook: [[]] });
  const result = validateSubtitleCues(presDir);
  assert.equal(result.pass, true);
  assert.equal(result.warnings, 1);
});

test("registry 缺失判定为 error", () => {
  const presDir = mkdtempSync(join(tmpdir(), "vf-cue-none-"));
  const result = validateSubtitleCues(presDir);
  assert.equal(result.pass, false);
  assert.equal(result.findings[0].rule, "registry-missing");
});
