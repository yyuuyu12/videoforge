// BGM 保底资产：ffmpeg 合成 32s 可循环暗色氛围垫（低频 drone + 缓慢起伏）。
// 定位是"比纯静默好"的零版权兜底——正经 BGM 把 mp3/wav 丢进
// server/assets/bgm/ 并在 config.bgm.track 填文件名（不含扩展名）即可。
// 用法：node scripts/gen-bgm.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "assets", "bgm");
mkdirSync(OUT, { recursive: true });

// 三层：A1 基频 drone(55Hz) + A2 五度泛音(82.4Hz) + 高频空气感噪声，
// 各自不同周期的 tremolo 让 32s 内无明显重复感；整体 -26dB 级别的"垫"。
const r = spawnSync("ffmpeg", [
  "-y",
  "-f", "lavfi", "-i", "sine=f=55:d=32",
  "-f", "lavfi", "-i", "sine=f=82.4:d=32",
  "-f", "lavfi", "-i", "anoisesrc=d=32:c=brown:a=0.5",
  "-filter_complex",
  [
    "[0:a]tremolo=f=0.13:d=0.55,volume=0.5[a1]",
    "[1:a]tremolo=f=0.11:d=0.6,volume=0.32[a2]",
    "[2:a]lowpass=f=900,tremolo=f=0.17:d=0.5,volume=0.22[a3]",
    "[a1][a2][a3]amix=inputs=3:normalize=0,afade=t=in:d=1.5,afade=t=out:st=30:d=2,volume=0.9",
  ].join(";"),
  "-ar", "44100", "-ac", "2", join(OUT, "ambient-dark.wav"),
], { encoding: "utf8" });
if (r.status !== 0) { console.error("FAILED:", (r.stderr || "").slice(-300)); process.exit(1); }
console.log("generated ambient-dark.wav");
