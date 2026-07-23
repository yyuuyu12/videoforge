import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.js";

/**
 * P0-A 音效层（2026-07-22，多助理路线首件）：把效果件在真实播放中上报的
 * 触发时刻（window.__vfSfx，Date.now 时钟，与音频 playing 事件同源）换算
 * 到成片时间轴，低增益混入配音轨。
 *
 * 纯函数模块：不解析任何生成代码（形状假设缺陷已四次实证），时刻来自
 * 运行时真实触发——效果没真的播出来就没有声音，天然与画面严格同步。
 */

/** 类型 → 资产文件与相对人声的线性音量（人声恒为 1.0）。 */
export const SFX_LIBRARY = {
  whip: { file: "whip.wav", volume: 0.45 },
  slam: { file: "slam.wav", volume: 0.55 },
  counter: { file: "counter.wav", volume: 0.28 },
};

export function sfxAssetPath(type) {
  const entry = SFX_LIBRARY[type];
  if (!entry) return null;
  const path = join(ROOT, "server", "assets", "sfx", entry.file);
  return existsSync(path) ? path : null;
}

/**
 * 事件 → 混音摆位。
 * - 只认 SFX_LIBRARY 里的类型；按时刻排序
 * - 全局最小间隔去重（Slam 包 Counter 同词触发相差约 100ms，两声叠一起
 *   会糊成一坨——保留先到的强音效）
 * - 上限保护：异常刷屏（如效果件 bug 循环触发）绝不冲爆 ffmpeg 命令行
 */
export function sfxPlacements(events, t0Ms, { minGapMs = 150, maxCount = 200 } = {}) {
  const valid = (events || [])
    .filter((e) => e && SFX_LIBRARY[e.type] && Number.isFinite(e.at))
    .map((e) => ({ type: e.type, offsetMs: Math.round(e.at - t0Ms) }))
    .filter((e) => e.offsetMs >= 0)
    .sort((a, b) => a.offsetMs - b.offsetMs);
  const placed = [];
  for (const e of valid) {
    if (placed.length >= maxCount) break;
    if (placed.length && e.offsetMs - placed[placed.length - 1].offsetMs < minGapMs) continue;
    placed.push(e);
  }
  return placed;
}

/** 摆位 → ffmpeg 追加输入与 filter 链（与配音段的 adelay 管线同构）。 */
export function sfxFilterChains(placements, firstInputIndex) {
  const args = [];
  const chains = [];
  const labels = [];
  placements.forEach((p, i) => {
    const asset = sfxAssetPath(p.type);
    if (!asset) return;
    const inputIndex = firstInputIndex + labels.length;
    args.push("-i", asset);
    chains.push(`[${inputIndex}:a]volume=${SFX_LIBRARY[p.type].volume},adelay=${p.offsetMs}|${p.offsetMs}[sfx${labels.length}]`);
    labels.push(`[sfx${labels.length}]`);
  });
  return { args, chains, labels };
}

/** 账目行：whip×2 slam×3 counter×1 */
export function sfxSummary(placements) {
  const counts = {};
  for (const p of placements) counts[p.type] = (counts[p.type] || 0) + 1;
  return Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(" ") || "无";
}

/**
 * BGM 底乐层（2026-07-23 竞品频谱实证：对标账号全程底乐铺满语音间隙，
 * 我们的成片段间纯静默）。机制：BGM 无限循环铺满全片 + 人声 sidechain
 * ducking——人声出现时垫乐自动压低，间隙时浮回来。
 * 曲库 server/assets/bgm/<track>.wav|mp3：合成氛围垫为保底，放同目录
 * 新文件并改 config.bgm.track 即换正经曲子。
 */
export function bgmAssetPath(track) {
  for (const ext of ["wav", "mp3", "m4a"]) {
    const p = join(ROOT, "server", "assets", "bgm", `${track}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 生成 BGM 的 ffmpeg 输入参数与 filter 链。
 * - voiceLabel：已混好的人声轨标签（如 "[voice]"）
 * - 返回 outLabel = duck 后的 BGM 轨标签；调用方把两轨再 amix。
 * sidechaincompress：threshold 低、ratio 高、release 长——人声一响垫乐即让位，
 * 句间自然浮回，竞品听感的关键。level_sc 提升侦测灵敏度。
 */
export function bgmFilterChain({ inputIndex, voiceLabel, volume = 0.16 }) {
  const chains = [
    `[${inputIndex}:a]volume=${volume}[bgmraw]`,
    `${voiceLabel}asplit=2[voice_out][voice_sc]`,
    `[bgmraw][voice_sc]sidechaincompress=threshold=0.02:ratio=12:attack=60:release=800:level_sc=4[bgmduck]`,
  ];
  return { args: ["-stream_loop", "-1"], chains, outLabel: "[bgmduck]", voiceOutLabel: "[voice_out]" };
}
