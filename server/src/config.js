import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");

const DEFAULTS = {
  port: 5401,
  host: "127.0.0.1",
  workspacesRoot: join(ROOT, "workspaces"),
  theme: "midnight-press",
  agent: {
    command: "claude",
    args: ["-p", "--dangerously-skip-permissions", "--output-format", "text"],
    timeoutMs: 5400000,
    maxConcurrent: 1,
  },
  // 方法论真源 = 仓库内快照（skills/），不依赖任何机器的个人 skill 安装位。
  // 更新流程：改 F:\Projects\claude-skills 源码库 → 同步快照进本仓库 → 提交。
  skills: {
    webVideoPresentation: join(ROOT, "skills", "web-video-presentation"),
    videoAvatarSubtitles: join(ROOT, "skills", "video-avatar-subtitles"),
    article2video: join(ROOT, "skills", "article2video"),
  },
  tts: {
    provider: "minimax-http",
    apiKeyEnv: "MINIMAX_API_KEY",
    voiceId: "GongheJiucun02",
    // 与 skills/article2video/references/DEFAULTS.md 定稿一致（5 版 A/B 后用户选定）
    speed: 1.12,
  },
  devServerBasePort: 5300,
  previewMode: "static",
  discovery: { intervalMinutes: 120, autoStart: true },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? deepMerge(base[k] ?? {}, v)
        : v;
  }
  return out;
}

let fileConfig = {};
const configPath = join(ROOT, "config.json");
if (existsSync(configPath)) {
  fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
}

export const config = deepMerge(DEFAULTS, fileConfig);
