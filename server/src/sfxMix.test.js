import test from "node:test";
import assert from "node:assert/strict";
import { sfxPlacements, sfxFilterChains, sfxSummary, sfxAssetPath, SFX_LIBRARY, bgmFilterChain, bgmAssetPath } from "./sfxMix.js";

test("sfxPlacements：换算/排序/过滤未知类型与负偏移", () => {
  const t0 = 1000;
  const placed = sfxPlacements([
    { type: "slam", at: 3000 },
    { type: "whip", at: 1500 },
    { type: "unknown", at: 2000 },
    { type: "counter", at: 500 }, // t0 之前 → 丢弃
  ], t0);
  assert.deepEqual(placed, [
    { type: "whip", offsetMs: 500 },
    { type: "slam", offsetMs: 2000 },
  ]);
});

test("sfxPlacements：全局最小间隔去重（Slam 包 Counter 同词场景保留先到强音）", () => {
  const placed = sfxPlacements([
    { type: "slam", at: 1150 },
    { type: "counter", at: 1250 }, // 与 slam 差 100ms < 150ms → 去掉
    { type: "counter", at: 1500 },
  ], 1000);
  assert.deepEqual(placed.map((p) => p.type), ["slam", "counter"]);
});

test("sfxPlacements：上限保护防刷屏", () => {
  const events = Array.from({ length: 500 }, (_, i) => ({ type: "whip", at: 1000 + i * 200 }));
  assert.equal(sfxPlacements(events, 0).length, 200);
});

test("sfxFilterChains：音量+adelay 链与输入序号对齐", () => {
  const { args, chains, labels } = sfxFilterChains([
    { type: "whip", offsetMs: 500 },
    { type: "slam", offsetMs: 2000 },
  ], 5);
  assert.equal(args.filter((a) => a === "-i").length, 2);
  assert.match(chains[0], /^\[5:a\]volume=0\.45,adelay=500\|500\[sfx0\]$/);
  assert.match(chains[1], /^\[6:a\]volume=0\.55,adelay=2000\|2000\[sfx1\]$/);
  assert.deepEqual(labels, ["[sfx0]", "[sfx1]"]);
});

test("sfx 资产存在且账目行可读", () => {
  for (const type of Object.keys(SFX_LIBRARY)) {
    assert.ok(sfxAssetPath(type), `缺少音效资产：${type}`);
  }
  assert.equal(sfxSummary([{ type: "whip" }, { type: "whip" }, { type: "slam" }]), "whip×2 slam×1");
});

test("bgmFilterChain：ducking 链形状与标签", () => {
  const { args, chains, outLabel, voiceOutLabel } = bgmFilterChain({ inputIndex: 7, voiceLabel: "[voice]", volume: 0.2 });
  assert.deepEqual(args, ["-stream_loop", "-1"]);
  assert.match(chains[0], /^\[7:a\]volume=0\.2\[bgmraw\]$/);
  assert.match(chains[1], /^\[voice\]asplit=2\[voice_out\]\[voice_sc\]$/);
  assert.match(chains[2], /sidechaincompress.*\[bgmduck\]$/);
  assert.equal(outLabel, "[bgmduck]");
  assert.equal(voiceOutLabel, "[voice_out]");
});

test("bgm 保底资产存在", () => {
  assert.ok(bgmAssetPath("ambient-dark"), "缺少 server/assets/bgm/ambient-dark.wav（node scripts/gen-bgm.mjs 生成）");
  assert.equal(bgmAssetPath("不存在的曲子"), null);
});
