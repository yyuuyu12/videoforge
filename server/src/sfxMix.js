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
