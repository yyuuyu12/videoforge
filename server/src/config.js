import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");

const DEFAULTS = {
  port: 5401,
  workspacesRoot: join(ROOT, "workspaces"),
  theme: "midnight-press",
  agent: {
    command: "claude",
    args: ["-p", "--dangerously-skip-permissions", "--output-format", "text"],
    timeoutMs: 5400000,
    maxConcurrent: 1,
  },
  skills: {
    webVideoPresentation: "C:/Users/木木/.claude/skills/web-video-presentation",
    videoAvatarSubtitles: "C:/Users/木木/.claude/skills/video-avatar-subtitles",
  },
  tts: {
    provider: "minimax-http",
    apiKeyEnv: "MINIMAX_API_KEY",
    voiceId: "GongheJiucun02",
    speed: 1.0,
  },
  devServerBasePort: 5300,
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
