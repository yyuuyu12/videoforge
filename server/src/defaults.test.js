import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { CUE_HARD_LIMIT } from "./subtitleCheck.js";

/**
 * 个人定稿一致性守卫（2026-07-20）：server 运行时默认值必须与
 * skills/article2video/references/defaults.json（DEFAULTS.md 的机器可读镜像）
 * 一致，防止代码默认值与个人规范悄悄漂移。数字人尺寸已按 2026-07-17
 * 用户拍板（277×493/reserve480）统一，DEFAULTS.md 正文同步更正（2026-07-22）。
 * 尺寸值散落在 stages.js（avatar_wire）与模板 avatarConfig.ts 的字面量里，
 * 用文本断言守卫——目的是抓"顺手改了一处忘了其他处"的漂移。
 */
const defaults = JSON.parse(
  readFileSync(join(config.skills.article2video, "references", "defaults.json"), "utf8"),
);

test("TTS 语速与个人定稿一致（1.12）", () => {
  assert.equal(config.tts.speed, defaults.tts.speed);
});

test("TTS 音色与个人定稿一致（GongheJiucun02，严禁重克隆）", () => {
  assert.equal(config.tts.voiceId, defaults.tts.voiceId);
});

test("TTS 密钥环境变量名一致", () => {
  assert.equal(config.tts.apiKeyEnv, defaults.tts.apiKeyEnv);
});

test("字幕硬上限与个人定稿一致（10 字）", () => {
  assert.equal(CUE_HARD_LIMIT, defaults.subtitle.hardMaxChars);
});

test("数字人窗口尺寸与个人定稿一致（277×493 / reserve480，2026-07-17 拍板）", () => {
  const { windowWidthPx, windowHeightPx, reservePx } = defaults.avatar;
  const stages = readFileSync(join(import.meta.dirname, "stages.js"), "utf8");
  assert.match(
    stages,
    new RegExp(`reservePx:\\s*${reservePx},\\s*windowWidthPx:\\s*${windowWidthPx},\\s*windowHeightPx:\\s*${windowHeightPx}`),
    "stages.js avatar_wire 的 right-third 尺寸与 defaults.json 漂移",
  );
  const templateConfig = readFileSync(
    join(config.skills.webVideoPresentation, "templates", "src", "registry", "avatarConfig.ts"),
    "utf8",
  );
  assert.match(templateConfig, new RegExp(`windowWidthPx:\\s*${windowWidthPx}`), "模板 avatarConfig.ts 宽度漂移");
  assert.match(templateConfig, new RegExp(`windowHeightPx:\\s*${windowHeightPx}`), "模板 avatarConfig.ts 高度漂移");
});
