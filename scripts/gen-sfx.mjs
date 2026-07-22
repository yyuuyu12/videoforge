// P0-A 音效层：用 ffmpeg 合成三个基础音效（零版权风险的保底资产）。
// 想换更好的音效：直接用同名 wav 覆盖 server/assets/sfx/ 下的文件即可，
// 混音端只认文件名。用法：node scripts/gen-sfx.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "server", "assets", "sfx");
mkdirSync(OUT, { recursive: true });

const jobs = [
  // whip 甩切：短促风声——粉噪声带通 + 快进快出
  ["whip.wav", [
    "-f", "lavfi", "-i", "anoisesrc=d=0.32:c=pink:a=0.7",
    "-af", "highpass=f=350,lowpass=f=5200,afade=t=in:d=0.05,afade=t=out:st=0.14:d=0.18,volume=0.9",
  ]],
  // slam 重锤：低频正弦衰减 + 起手噪声瞬态
  ["slam.wav", [
    "-f", "lavfi", "-i", "sine=f=68:d=0.5",
    "-f", "lavfi", "-i", "anoisesrc=d=0.04:c=white:a=0.5",
    "-filter_complex", "[0:a]afade=t=out:st=0.03:d=0.45,volume=1.0[low];[1:a]highpass=f=800,afade=t=out:d=0.04[click];[low][click]amix=inputs=2:normalize=0,volume=1.2",
  ]],
  // counter 滚动：轻软上行铺底——低通噪声弱声
  ["counter.wav", [
    "-f", "lavfi", "-i", "anoisesrc=d=0.8:c=brown:a=0.6",
    "-af", "lowpass=f=1600,afade=t=in:d=0.15,afade=t=out:st=0.4:d=0.4,volume=0.5",
  ]],
];

for (const [name, args] of jobs) {
  const r = spawnSync("ffmpeg", ["-y", ...args, "-ar", "44100", "-ac", "2", join(OUT, name)], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`FAILED ${name}:`, (r.stderr || "").slice(-300));
    process.exit(1);
  }
  console.log("generated", name);
}
