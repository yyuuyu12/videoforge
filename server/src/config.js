import { readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..", "..");

/**
 * 数据目录与代码分离（PRODUCT-PLAN §六 B2）：
 * data.db / settings.local.json / workspaces / logs 全部归属 DATA_ROOT，
 * 代码类（skills/、server/templates/、dashboard/dist）留在安装目录 ROOT。
 *
 * 解析优先级：env VIDEOFORGE_DATA_DIR > config.json dataRoot >
 *   旧数据就地兼容（ROOT 下已有 data.db 则继续用 ROOT，本机开发零迁移）>
 *   %APPDATA%\VideoForge（打包分发的默认，安装目录保持只读可运行）。
 */
function resolveDataRoot(fileConfig) {
  if (process.env.VIDEOFORGE_DATA_DIR) return process.env.VIDEOFORGE_DATA_DIR;
  if (fileConfig.dataRoot) return fileConfig.dataRoot;
  if (existsSync(join(ROOT, "data.db"))) return ROOT;
  const appData = process.env.APPDATA || join(homedir(), ".videoforge");
  return join(appData, "VideoForge");
}

/** 首次使用新数据目录时的供给：建目录、铺共享演示依赖清单、接走旧密钥。 */
function provisionDataRoot(dataRoot) {
  if (dataRoot === ROOT) return; // 旧布局，无需供给
  mkdirSync(join(dataRoot, "workspaces"), { recursive: true });
  mkdirSync(join(dataRoot, "logs"), { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    const src = join(ROOT, "workspaces", name);
    const dst = join(dataRoot, "workspaces", name);
    if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
  }
  // 便携分发：随包携带的共享依赖一次性本地复制到数据目录（无需网络/npm）。
  const bundledModules = join(ROOT, "workspaces", "node_modules");
  const dataModules = join(dataRoot, "workspaces", "node_modules");
  if (!existsSync(dataModules) && existsSync(bundledModules)) {
    console.log("[dataRoot] 正在复制共享演示依赖（一次性，约 80MB）…");
    const copied = spawnSync("robocopy", [bundledModules, dataModules, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { shell: false });
    // robocopy 退出码 <8 均为成功（1=有文件复制）
    if (copied.status != null && copied.status >= 8) {
      console.warn(`[dataRoot] 依赖复制失败（robocopy ${copied.status}）——预览构建前请手动补齐 workspaces/node_modules`);
    }
  } else if (!existsSync(dataModules)) {
    console.warn(`[dataRoot] ${join(dataRoot, "workspaces")} 缺少 node_modules——` +
      `请执行一次：npm install --prefix "${join(dataRoot, "workspaces")}"（预览构建前需要）`);
  }
  // 旧机器切新数据目录：密钥与数据库只复制不移动，旧目录保持原样可回退
  for (const name of ["settings.local.json", "data.db"]) {
    const src = join(ROOT, name);
    const dst = join(dataRoot, name);
    if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
  }
}

const DEFAULTS = {
  port: 5401,
  host: "127.0.0.1",
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
  // 效果打分（博主质感维）接入管线：enabled=跑并记账；gate=分数低于 minScore
  // 时触发一次效果向修复（默认 false=只记账校准，稳定后再开门禁）。
  effectScore: { enabled: true, gate: false, minScore: 72 },
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

export const DATA_ROOT = resolveDataRoot(fileConfig);
provisionDataRoot(DATA_ROOT);

export const config = deepMerge(
  { ...DEFAULTS, workspacesRoot: join(DATA_ROOT, "workspaces") },
  fileConfig,
);
