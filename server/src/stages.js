import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config, ROOT } from "./config.js";
import { db, logEvent, recordUsage, updateJob } from "./db.js";
import { runAgent } from "./agentRunner.js";
import { captureJobCover, renderJob } from "./render.js";
import { loadSettings, minimaxKey } from "./settings.js";
import { typecheckPresentation } from "./preview.js";
import { validateSubtitleCues, cueEvidence } from "./subtitleCheck.js";
import { recordQualityEntry } from "./qualityLedger.js";
import { health as heygemHealth, submitJob, taskStatus, downloadResult } from "./heygem.js";

/**
 * Pipeline definition. Each stage is either:
 *   kind: "work"  — has run(job) -> Promise<{ok, note?}>
 *   kind: "gate"  — pipeline parks the job as waiting_approval; the
 *                   dashboard's approve button advances it.
 */
export const STAGES = [
  { id: "gate_source", kind: "gate", label: "原文确认" },
  { id: "script_outline", kind: "work", label: "口播稿 + Outline" },
  { id: "gate_script", kind: "gate", label: "稿件审批" },
  { id: "gate_style", kind: "gate", label: "风格与数字人占位确认" },
  { id: "scaffold", kind: "work", label: "脚手架" },
  { id: "chapter_gen", kind: "work", label: "章节生成" },
  { id: "gate_chapters", kind: "gate", label: "章节验收（可反馈调试）" },
  { id: "audio_synth", kind: "work", label: "音频合成" },
  { id: "gate_audio", kind: "gate", label: "配音验收" },
  { id: "subtitle_cues", kind: "work", label: "精确字幕" },
  { id: "gate_subtitles", kind: "gate", label: "字幕验收" },
  { id: "avatar_media", kind: "work", label: "数字人生成" },
  { id: "avatar_wire", kind: "work", label: "数字人接线" },
  { id: "gate_avatar", kind: "gate", label: "数字人验收" },
  { id: "gate_render", kind: "gate", label: "成片确认" },
  { id: "render", kind: "work", label: "成片渲染" },
  { id: "done", kind: "gate", label: "完成" },
];

export function nextStage(stageId) {
  const i = STAGES.findIndex((s) => s.id === stageId);
  return STAGES[i + 1]?.id ?? "done";
}

export function stageDef(stageId) {
  return STAGES.find((s) => s.id === stageId);
}

// ---------------------------------------------------------------------------

function sh(cmd, args, cwd, jobId, stage, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: true, env: { ...process.env, ...envExtra } });
    let out = "";
    let settled = false;
    const cap = (s) => (s.length > 20000 ? s.slice(-20000) : s);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (d) => (out = cap(out + d)));
    child.stderr.on("data", (d) => (out = cap(out + d)));
    child.on("error", (error) => {
      const note = `Unable to start ${cmd}: ${error.message}`;
      logEvent(jobId, stage, note, "error");
      finish({ ok: false, output: out, note });
    });
    child.on("close", (code) => {
      logEvent(jobId, stage, `$ ${cmd} ${args.join(" ")}\nexit ${code}\n${out.slice(-1500)}`, code === 0 ? "info" : "error");
      finish({ ok: code === 0, output: out, note: code === 0 ? "" : `Command exited with code ${code}` });
    });
  });
}

function mediaDuration(path) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { shell: false });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.on("close", (code) => code === 0 ? resolve(Number(output.trim())) : reject(new Error(`ffprobe failed: ${path}`)));
  });
}

function videoCodec(path) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", path], { shell: false });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`ffprobe failed: ${path}`)));
  });
}

function avatarProgress(jobId, percent, message, stage = "avatar_media") {
  logEvent(jobId, stage, `progress|${Math.max(0, Math.min(100, Math.round(percent)))}|${message}`);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureCssImport(componentPath, cssName) {
  if (!existsSync(componentPath)) return false;
  const source = readFileSync(componentPath, "utf8");
  const statement = `import "./${cssName}";`;
  if (source.includes(statement)) return false;
  writeFileSync(componentPath, `${statement}\n${source}`);
  return true;
}

function subtitleStyle(options) {
  const subtitle = options.subtitle || {};
  if (subtitle.enabled === false) {
    return `\n/* VideoForge product preset: generated from jobs.meta. */\n.subtitle { display: none !important; }\n`;
  }
  const theme = options.theme || config.theme;
  const darkThemes = new Set(["midnight-press", "dark-botanical", "neon-cyber", "terminal-green", "electric-studio"]);
  const lightText = darkThemes.has(theme);
  const color = lightText ? "#f8fafc" : "#111827";
  const shadow = lightText
    ? "0 2px 10px rgba(0,0,0,.72)"
    : "0 2px 10px rgba(255,255,255,.68)";
  const position = subtitle.position || "bottom";
  const placement = position === "top"
    ? "top: 72px; bottom: auto;"
    : position === "lower-third"
      ? "bottom: 156px;"
      : "bottom: 58px;";
  const preset = subtitle.preset || "auto-contrast";
  const panel = preset === "soft-panel"
    ? "background: rgba(8, 12, 20, .72); color: #fff; padding: 12px 20px; border-radius: 8px; box-shadow: 0 12px 34px rgba(0,0,0,.22);"
    : preset === "outline"
      ? `color: ${color}; text-shadow: -2px -2px 0 ${lightText ? "#111" : "#fff"}, 2px -2px 0 ${lightText ? "#111" : "#fff"}, -2px 2px 0 ${lightText ? "#111" : "#fff"}, 2px 2px 0 ${lightText ? "#111" : "#fff"};`
      : `color: ${color}; text-shadow: ${shadow};`;
  // 字幕永远相对整个画面居中（用户定稿 2026-07-16）：数字人是右下角
  // 小窗，10 字单行字幕居中后右缘远够不到它，不需要偏移避让——
  // 之前 avatar 启用时 right:460px 造成"整体偏左"的观感缺陷。
  return `\n/* VideoForge product preset: generated from jobs.meta. */\n.subtitle {\n  left: 60px;\n  right: 60px;\n  ${placement}\n  ${panel}\n}\n`;
}

function applySubtitlePreset(presDir, options) {
  const component = join(presDir, "src", "components", "Subtitle.tsx");
  const css = join(presDir, "src", "components", "Subtitle.css");
  ensureCssImport(component, "Subtitle.css");
  if (!existsSync(css)) return;
  const source = readFileSync(css, "utf8").replace(/\n\/\* VideoForge product preset:[\s\S]*$/m, "");
  writeFileSync(css, `${source.trimEnd()}${subtitleStyle(options)}`);
}

function fingerprintFiles(files) {
  const hash = createHash("sha1");
  for (const file of files) {
    const stat = statSync(file);
    hash.update(`${file}|${stat.size}|${stat.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

function fingerprintFileContents(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function splitAvatarPreviews(job, files, lipsync, avatarDir, presDir) {
  avatarProgress(job.id, 91, "正在按章节切分预览视频");
  const chapterDir = join(avatarDir, "chapters");
  mkdirSync(chapterDir, { recursive: true });
  const groups = new Map();
  for (const file of files) {
    const chapter = file.replace(/\\/g, "/").split("/").slice(-2, -1)[0];
    if (!groups.has(chapter)) groups.set(chapter, []);
    groups.get(chapter).push(file);
  }
  let cursor = 0;
  let chapterIndex = 0;
  for (const [chapter, chapterFiles] of groups) {
    let duration = 0;
    for (const file of chapterFiles) duration += await mediaDuration(file);
    const output = join(chapterDir, `${chapter}.mp4`);
    const cut = await sh("ffmpeg", ["-y", "-ss", cursor.toFixed(3), "-i", lipsync, "-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-g", "25", "-an", output], presDir, job.id, "avatar_media");
    if (!cut.ok) return cut;
    cursor += duration;
    chapterIndex += 1;
    avatarProgress(job.id, 91 + (chapterIndex / groups.size) * 4, `已生成章节预览 ${chapterIndex}/${groups.size}`);
  }
  return { ok: true };
}

export function orderedAvatarAudioFiles(presDir, audioRoot) {
  const manifest = join(presDir, "audio-segments.json");
  if (existsSync(manifest)) {
    try {
      const segments = JSON.parse(readFileSync(manifest, "utf8"));
      const ordered = segments
        .map((segment) => join(audioRoot, String(segment.audio || "")))
        .filter((file) => existsSync(file));
      if (ordered.length === segments.length && ordered.length > 0) return ordered;
    } catch {
      // Fall through to deterministic discovery for legacy presentations.
    }
  }
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".mp3") ? [path] : [];
  });
  return walk(audioRoot).sort();
}

async function wireAvatarWithAgent(job, meta, presDir) {
  const skill = config.skills.videoAvatarSubtitles;
  const positionKey = meta.avatar?.position || "right-third";
  const position = positionKey === "right-top" ? "右上角小窗" : positionKey === "right-bottom" ? "右下角小窗" : "右侧讲师区（较标准三分之一区域缩小 30%）";
  const reserve = positionKey === "right-third" ? 448 : 360;
  const windowWidth = positionKey === "right-third" ? 314 : 252;
  const prompt = [
    `- Avatar window width is ${windowWidth}px with 10px inner padding; keep the existing right anchor.`,
    `当前目录是已完成配音与字幕的网页演示，public/avatar/lipsync.mp4 是已生成的全片数字人对口型视频。`,
    `严格按照 ${skill}/references/AVATAR-PIPELINE.md 接入讲师窗口：`,
    `- 本作品选择的位置是${position}，右侧预留宽度是 ${reserve}px；人物窗口 right 40px、圆角 28px，保持原右侧锚点，不得居中或向左移动`,
    `- 所有 PPT 正文永久为右侧预留 ${reserve}px，逐页重排，关键文字、图表不得进入这一区域`,
    `- video 必须 muted、playsInline，由当前音频时间轴驱动，不得让它自由播放`,
    `- 跟随每个 step 的真实累计音频位置同步，切换 step 时不得从视频开头重播`,
    `- 所有新建组件的同名 CSS 必须由组件显式 import，不允许只创建 CSS 文件`,
    `- 完成后运行 npx tsc --noEmit，修复全部错误后退出。`,
  ].join("\n");
  avatarProgress(job.id, 96, "正在把数字人接入每一页画面（旧版脚手架 LLM 回退）", "avatar_wire");
  const wired = await runAgent({ jobId: job.id, stage: "avatar_wire", cwd: presDir, prompt });
  const componentDir = join(presDir, "src", "components");
  if (existsSync(componentDir)) {
    for (const name of readdirSync(componentDir).filter((entry) => /^Avatar.*\.tsx$/.test(entry))) {
      const cssName = name.replace(/\.tsx$/, ".css");
      if (existsSync(join(componentDir, cssName))) ensureCssImport(join(componentDir, name), cssName);
    }
  }
  applySubtitlePreset(presDir, meta);
  if (!wired.ok) return wired;
  const checked = await typecheckPresentation(presDir, job.id, "avatar_wire");
  if (!checked.ok) return checked;
  try {
    await captureJobCover(job, { requireAvatar: true });
  } catch (error) {
    logEvent(job.id, "cover", `数字人已完成，但封面更新失败：${error.message}`, "warning");
  }
  updateJob(job.id, {
    meta: JSON.stringify({
      ...meta,
      avatar: { ...(meta.avatar ?? {}), pendingRegeneration: false },
    }),
  });
  avatarProgress(job.id, 100, "数字人生成、章节预览和作品封面已完成", "avatar_wire");
  return { ok: true, note: "数字人对口型视频已生成并接入右侧讲师区，作品封面已同步更新" };
}

// Node 24 on this Windows host can terminate without an exception inside
// fs.cpSync(). Copying this tiny template tree ourselves keeps scaffold
// failures observable and works on all supported Node versions.
function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

function ensureNativeScaffold(skill, target, theme) {
  const templates = join(skill, "templates");
  const tokens = join(skill, "themes", theme, "tokens.css");
  if (!existsSync(tokens)) throw new Error(`找不到画面主题：${theme}`);

  const existing = existsSync(join(target, "package.json")) && existsSync(join(target, "src", "App.tsx"));
  mkdirSync(target, { recursive: true });
  if (!existing) {
    copyTree(join(templates, "src"), join(target, "src"));
    copyTree(join(templates, "scripts"), join(target, "scripts"));
    copyFileSync(join(templates, "index.html"), join(target, "index.html"));
    copyFileSync(join(templates, "vite.config.ts"), join(target, "vite.config.ts"));
    writeJson(join(target, "package.json"), {
      name: "presentation",
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc -b && vite build",
        "extract-narrations": "tsx scripts/extract-narrations.ts",
      },
      dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: {
        "@types/node": "22.20.1",
        "@types/react": "18.3.31",
        "@types/react-dom": "18.3.7",
        "@vitejs/plugin-react": "4.7.0",
        tsx: "4.23.1",
        typescript: "5.9.3",
        vite: "6.4.3",
      },
    });
    writeJson(join(target, "tsconfig.json"), {
      files: [],
      references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }],
    });
    writeJson(join(target, "tsconfig.app.json"), {
      compilerOptions: {
        target: "ES2020", lib: ["ES2020", "DOM", "DOM.Iterable"], module: "ESNext",
        skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true,
        isolatedModules: true, moduleDetection: "force", noEmit: true, jsx: "react-jsx",
        strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true,
      },
      include: ["src"],
    });
    writeJson(join(target, "tsconfig.node.json"), {
      compilerOptions: {
        target: "ES2022", lib: ["ES2023"], module: "ESNext", skipLibCheck: true,
        moduleResolution: "bundler", allowImportingTsExtensions: true, isolatedModules: true,
        moduleDetection: "force", noEmit: true, strict: true,
      },
      include: ["vite.config.ts"],
    });
    writeFileSync(join(target, ".gitignore"), "node_modules\ndist\n");
  }

  mkdirSync(join(target, "src", "styles"), { recursive: true });
  mkdirSync(join(target, "public"), { recursive: true });
  copyFileSync(tokens, join(target, "src", "styles", "tokens.css"));
  const chapterRegistry = join(target, "src", "registry", "chapters.ts");
  if (existsSync(chapterRegistry)) {
    const registrySource = readFileSync(chapterRegistry, "utf8");
    if (registrySource.includes("../chapters/01-example/")) {
      writeFileSync(chapterRegistry, [
        'import type { ChapterDef } from "./types";',
        "",
        "// Real chapters are registered incrementally during chapter generation.",
        "export const CHAPTERS: ChapterDef[] = [];",
        "",
      ].join("\n"));
    }
  }
  rmSync(join(target, "src", "chapters", "01-example"), { recursive: true, force: true });
  rmSync(join(target, ".videoforge-chapter-progress.json"), { force: true });
  rmSync(join(target, "dist", ".build-fingerprint"), { force: true });
  writeFileSync(join(target, ".theme"), `${theme}\n`);
  return { existing };
}

function jobOptions(job) {
  try { return JSON.parse(job.meta || "{}"); } catch { return {}; }
}

/**
 * Keep the product-selected theme authoritative after an agent run. Agents
 * may edit any file in the presentation workspace, so the selected token file
 * and theme markers are restored deterministically before preview validation.
 */
export function synchronizePresentationThemeFiles({ workspace, skillRoot, theme }) {
  const presentation = join(workspace, "presentation");
  const sourceTokens = join(skillRoot, "themes", theme, "tokens.css");
  const targetTokens = join(presentation, "src", "styles", "tokens.css");
  const themeMarker = join(presentation, ".theme");
  const outlinePath = join(workspace, "outline.md");
  if (!existsSync(sourceTokens)) throw new Error(`找不到画面主题：${theme}`);

  const previousMarker = existsSync(themeMarker) ? readFileSync(themeMarker, "utf8").trim() : "";
  const sourceCss = readFileSync(sourceTokens);
  const previousCss = existsSync(targetTokens) ? readFileSync(targetTokens) : null;
  const cssDrifted = previousCss == null || !previousCss.equals(sourceCss);
  const markerDrifted = previousMarker !== theme;

  mkdirSync(join(presentation, "src", "styles"), { recursive: true });
  copyFileSync(sourceTokens, targetTokens);
  writeFileSync(themeMarker, `${theme}\n`, "utf8");

  let outlineDrifted = false;
  if (existsSync(outlinePath)) {
    const original = readFileSync(outlinePath, "utf8");
    let updated = original;
    if (/^theme:\s*.*$/m.test(updated)) {
      updated = updated.replace(/^theme:\s*.*$/m, `theme: ${theme}`);
    } else {
      updated = `theme: ${theme}\n\n${updated}`;
    }
    updated = updated.replace(/^(\*\*主题[：:]\*\*\s*).*$/m, `$1${theme}`);
    outlineDrifted = updated !== original;
    if (outlineDrifted) writeFileSync(outlinePath, updated, "utf8");
  }

  rmSync(join(presentation, "dist", ".build-fingerprint"), { force: true });
  return { drifted: cssDrifted || markerDrifted || outlineDrifted, cssDrifted, markerDrifted, outlineDrifted };
}

const runners = {
  /**
   * article.md (written at job creation) -> script.md + outline.md.
   * Mirrors web-video-presentation Phase 1, but told to run its own
   * self-check loop and NOT to wait for interactive confirmation — the
   * approval gate lives in the dashboard instead.
   */
  async script_outline(job) {
    const skill = config.skills.webVideoPresentation;
    const theme = jobOptions(job).theme || config.theme;
    const prompt = [
      `你在一个视频生成流水线的无人值守环节中工作，当前目录是一个视频项目工作区。`,
      `输入文章在 ./article.md。`,
      `请严格按照这个 Skill 的 Phase 1 规范工作：${skill}/SKILL.md`,
      `（必读其中引用的 references/SCRIPT-STYLE.md 与 references/OUTLINE-FORMAT.md）`,
      ``,
      `任务：产出 ./script.md（口播稿）和 ./outline.md（开发计划）。`,
      `outline.md 顶部主题字段直接写 \`${theme}\`。`,
      `两份文件都必须自己走完各自的自检清单并修复所有 FAIL 项后才算完成。`,
      `不要停下来向用户提问——审批在流水线外部完成。做完即退出。`,
    ].join("\n");
    return runAgent({ jobId: job.id, stage: "script_outline", cwd: job.workspace, prompt });
  },

  async scaffold(job) {
    const skill = config.skills.webVideoPresentation;
    const theme = jobOptions(job).theme || config.theme;
    const target = join(job.workspace, "presentation");
    try {
      db.prepare("DELETE FROM chapter_reviews WHERE job_id = ?").run(job.id);
      const { existing } = ensureNativeScaffold(skill, target, theme);
      logEvent(job.id, "scaffold", existing ? `已保留现有章节并切换主题：${theme}` : `已创建原生画面工程：${theme}`);
      return typecheckPresentation(target, job.id, "scaffold");
    } catch (error) {
      return { ok: false, note: error.message };
    }
  },

  /**
   * Build every chapter per outline.md. One agent session drives the whole
   * build (it may use its own subagents); it must register chapters, keep
   * narrations.ts as the source of truth, run tsc, and self-check each
   * chapter against CHAPTER-CRAFT.md.
   */
  async chapter_gen(job) {
    const skill = config.skills.webVideoPresentation;
    const options = jobOptions(job);
    const theme = options.theme || config.theme;
    const avatar = options.avatar || {};
    const avatarPosition = avatar.position === "right-top" ? "右上角小窗" : avatar.position === "right-bottom" ? "右下角小窗" : "右侧讲师区（较标准三分之一区域缩小 30%）";
    const avatarReserve = avatar.position === "right-third" ? 448 : 360;
    const avatarLayout = options.avatar?.enabled
      ? `本片启用讲师数字人：人物位于${avatarPosition}，所有章节正文必须为右侧讲师窗口预留 ${avatarReserve}px，不得把关键文字或图表放入该区域。讲师窗口保持右侧原锚点，宽度不得放大、不得居中或向左移动。逐章检查并重新排版所有已经存在的页面，不能只加一个视频浮层。`
      : "本片暂未启用讲师数字人。";
    const subtitlePosition = options.subtitle?.position || "bottom";
    const subtitleLayout = options.subtitle?.enabled === false
      ? "本片未启用字幕，无需预留字幕安全带。"
      : subtitlePosition === "top"
        ? "本片启用顶部字幕：舞台顶部 170px 是字幕安全带，正文、关键数字、图表和高对比装饰不得进入；字幕层除外。"
        : subtitlePosition === "lower-third"
          ? "本片启用下三分之一字幕：舞台底部 290px 是字幕安全带，正文、关键数字、图表和高对比装饰不得进入；字幕层除外。"
          : "本片启用底部字幕：舞台底部 190px 是字幕安全带，正文、关键数字、图表和高对比装饰不得进入；字幕层除外。";
    const typography = options.typography || {};
    const fontPreset = typography.fontSize || "large";
    const densityPreset = typography.density || "balanced";
    const fontRule = fontPreset === "compact"
      ? "正文字号不低于 22px，标题按信息量适度收紧"
      : fontPreset === "extra-large"
        ? "正文字号不低于 30px，标题优先 72px 以上，内容过多必须拆 step"
        : "正文字号不低于 26px，标题与关键数字明显拉开层级";
    const densityRule = densityPreset === "dense"
      ? "每屏最多 6 个信息单元，允许紧凑网格但必须留出清晰组间距"
      : densityPreset === "airy"
        ? "每屏最多 3 个信息单元，优先大留白和单观点表达"
        : "每屏最多 4 个信息单元，信息量与留白保持均衡";
    const prompt = [
      `你在一个视频生成流水线的无人值守环节中工作。当前目录是一个已完成 Phase 1 的 web-video-presentation 项目：`,
      `- ./article.md ./script.md ./outline.md 已定稿（不要改它们）`,
      `- ./presentation/ 已用主题 ${theme} 脚手架完成，01-example 已删除`,
      avatarLayout,
      subtitleLayout,
      `数字人与字幕同时启用时，正文可用区域必须同时避开两者安全区，取安全区并集。`,
      `本作品排版预设：${fontRule}；${densityRule}。这是产品配置，不修改 Skill 真源。`,
      ``,
      `任务：按 outline.md 把全部章节开发完成。规范（必须照做）：`,
      `- 每章开发前重读 ${skill}/references/CHAPTER-CRAFT.md（单一必读入口）`,
      `- 开始每章前必须更新 presentation/.videoforge-chapter-progress.json，格式为 {"current":当前序号,"total":总章节数,"chapter":"章节目录名","status":"generating","message":"正在生成本章画面"}`,
      `- 进度文件必须通过 write_file 工具按 UTF-8 写入；禁止用 run_command、PowerShell、cmd 重定向或 Out-File 写这个文件`,
      `- 每章代码与自检完成后，立刻把本章注册进 src/registry/chapters.ts 并运行 npx tsc --noEmit；注册成功后才能开始下一章，确保用户可以逐章预览，不得等全部章节生成后才统一注册`,
      `- 每章代码与自检完成后把同一文件的 status 改为 "checking"、message 改为 "本章完成，正在检查"，再开始下一章；全部完成后写 status "done"`,
      `- 每章独立文件夹 + 独立 CSS 前缀 + narrations.ts（长度 = step 数）`,
      `- 全部注册进 src/registry/chapters.ts，每次结构变化 bump useStepper.ts 的 STORAGE_KEY`,
      `- 颜色/字体只用主题 token；严格遵守上面的作品级字号与排版密度预设`,
      `- 首次生成必须满足 CHAPTER-CRAFT 的“首次生成质量契约”：先拆分超预算内容，不得依赖生成后的截图修复来补救拥挤、溢出、短标题三行或安全区冲突`,
      `- 动笔前先读 ${skill}/references/EXEMPLARS.md（真实作品首次验收 100 分的三个章节骨架）：安全区写死在容器、数据驱动 step、滚动窗口列表——借鉴骨架，内容原创`,
      `- 效果件按 CHAPTER-CRAFT「镜头与效果件」使用：镜头在 registry/cameraCues.ts 声明（每章 ≤3）、WordMark 跟读高亮（每屏 ≤2）、Counter 数字滚动、Annotate 圈注（每屏 ≤1）——只能用库里的件，违规会被确定性校验拦下`,
      `- 效果采用度是硬要求（CHAPTER-CRAFT「采用度下限」）：数字人作品第一章第一步必须 {effect:"host-full"}、全片至少 1 个 host 时刻；内容镜头（focus/spotlight）总数至少为章节数一半，focus zoom ≥1.4；核心数字用 <Counter> 呈现；密度按 CHAPTER-CRAFT「镜头密度档位」执行（默认 dense：每章 2-4 个内容镜头 + 相邻步不连强推的平滑纪律）——用得太保守观众等于没看到效果`,
      `- kicker 用 .title-label 一类的大标题样式，不要小号说明文字`,
      `- 每章完成后自己跑完工自检并修复 FAIL 项；全项目 npx tsc --noEmit 必须 0 错误`,
      `- 可以并行使用子任务加速，但最终交付要整体一致`,
      `不要停下来向用户提问。全部做完、tsc 通过后退出。`,
    ].join("\n");
    const generated = await runAgent({ jobId: job.id, stage: "chapter_gen", cwd: job.workspace, prompt });
    if (!generated.ok) return generated;
    try {
      const synchronized = synchronizePresentationThemeFiles({
        workspace: job.workspace,
        skillRoot: skill,
        theme,
      });
      if (synchronized.drifted) {
        logEvent(job.id, "chapter_gen", `检测到生成结果主题漂移，已强制恢复为产品选定主题：${theme}`);
      }
      const checked = await typecheckPresentation(join(job.workspace, "presentation"), job.id, "chapter_gen");
      return checked.ok ? generated : checked;
    } catch (error) {
      return { ok: false, note: `主题一致性校验失败：${error.message}` };
    }
  },

  /**
   * Deterministic: extract narrations -> synthesize with MiniMax word-level
   * timestamps. Uses the template script (jq-free, incremental, rate-limited).
   */
  async audio_synth(job) {
    const apiKey = minimaxKey();
    if (!apiKey) {
      return { ok: false, note: `环境变量 ${config.tts.apiKeyEnv} 未设置——在启动 server 的终端里 set 之后重试本阶段` };
    }
    const presDir = join(job.workspace, "presentation");
    const scriptsDir = join(presDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(join(ROOT, "server/templates/synthesize-audio-node.mjs"), join(scriptsDir, "synthesize-audio-node.mjs"));

    let r = await sh("npm", ["run", "extract-narrations"], presDir, job.id, "audio_synth");
    if (!r.ok) return r;
    r = await sh("node", ["scripts/synthesize-audio-node.mjs"], presDir, job.id, "audio_synth", { [config.tts.apiKeyEnv]: apiKey });
    const usageMatch = r.output?.match(/VF_USAGE\s+(\{[^\n]+\})/);
    if (usageMatch) {
      try {
        const usage = JSON.parse(usageMatch[1]);
        if (usage.requests > 0) recordUsage({ service: "minimax", operation: "pipeline-tts", jobId: job.id, requests: usage.requests, units: usage.characters, unit: "characters", status: r.ok ? "success" : "failed", detail: "audio_synth" });
      } catch {}
    }
    return r;
  },

  /**
   * Deterministic cue generation from .words.json + an agent micro-task to
   * wire the Subtitle component in (once per project).
   */
  async subtitle_cues(job) {
    const presDir = join(job.workspace, "presentation");
    const options = jobOptions(job);
    if (options.subtitle?.enabled === false) {
      applySubtitlePreset(presDir, options);
      return { ok: true, note: "本作品已关闭字幕" };
    }
    const scriptsDir = join(presDir, "scripts");
    copyFileSync(join(ROOT, "server/templates/gen-subtitle-cues.mjs"), join(scriptsDir, "gen-subtitle-cues.mjs"));

    const r = await sh("node", ["scripts/gen-subtitle-cues.mjs"], presDir, job.id, "subtitle_cues");
    if (!r.ok) return r;

    // 确定性契约执法：cue ≤10 字、时间递增（job-13/14 超长 cue 缺陷的回写规则）
    const cueCheck = validateSubtitleCues(presDir);
    if (!cueCheck.pass) {
      recordQualityEntry({ kind: "subtitle-check", jobId: job.id, errors: cueCheck.errors, warnings: cueCheck.warnings, defects: { "cue-violation": cueCheck.errors } });
      return { ok: false, note: `字幕 cue 数据违规 ${cueCheck.errors} 处：${cueEvidence(cueCheck, 3).join("；")}。请重试本环节（切分器会重新生成）。` };
    }
    if (cueCheck.warnings) {
      logEvent(job.id, "subtitle_cues", `字幕契约提醒 ${cueCheck.warnings} 处（无 cue 的 step 将走一句一句的兜底展示）`);
    }

    if (!existsSync(join(presDir, "src/components/Subtitle.tsx"))) {
      const skill = config.skills.videoAvatarSubtitles;
      const prompt = [
        `当前目录是一个 web-video-presentation 项目。src/registry/subtitleCues.ts 已由脚本生成（真实逐字时间戳分组成的 cues）。`,
        `任务：按 ${skill}/references/SUBTITLE-SYNC.md 的"运行时同步"和"UI 呈现"规范，实现底部滚动字幕：`,
        `- 新建 src/components/Subtitle.tsx + Subtitle.css：一次一行大字号 cue，rAF 轮询音频 currentTime（不要用 timeupdate），无 cue 数据时回退整段文本但 line-clamp 2 行`,
        `- useAudioPlayer 暴露一个 getAudioEl()，App.tsx 把 Subtitle 挂进 Stage 内`,
        `⚠️ 注意 React hooks 规则：不要改变 App 里现有 hooks 的调用顺序（useAutoMode/useStepper/useAudioPlayer 的相对顺序保持不变），只在末尾追加。`,
        `完成后 npx tsc --noEmit 必须 0 错误，然后退出。`,
      ].join("\n");
      const wired = await runAgent({ jobId: job.id, stage: "subtitle_cues", cwd: job.workspace, prompt });
      if (!wired.ok) return wired;
    }
    applySubtitlePreset(presDir, options);
    return typecheckPresentation(presDir, job.id, "subtitle_cues");
  },

  /** 媒体段：HeyGem 推理 + 章节预览，按输入指纹 checkpoint；不做接线。 */
  async avatar_media(job) {
    let meta = {};
    try { meta = JSON.parse(job.meta || "{}"); } catch {}
    if (!meta.avatar?.enabled) return { ok: true, note: "本作品未启用数字人" };
    avatarProgress(job.id, 2, "检查数字人服务和素材");
    if (!meta.avatar.source) {
      // 未选素材时自动带出默认数字人（最近一次选择即默认）
      const defaultFilename = loadSettings().avatar?.defaultFilename;
      const libraryFile = defaultFilename ? join(config.workspacesRoot, "_assets", "avatars", basename(defaultFilename)) : "";
      if (libraryFile && existsSync(libraryFile)) {
        const dir = join(job.workspace, "assets");
        mkdirSync(dir, { recursive: true });
        const saved = `presenter.${defaultFilename.toLowerCase().endsWith(".mov") ? "mov" : "mp4"}`;
        copyFileSync(libraryFile, join(dir, saved));
        meta.avatar = { ...meta.avatar, source: `assets/${saved}`, filename: defaultFilename };
        updateJob(job.id, { meta: JSON.stringify(meta) });
        logEvent(job.id, "avatar_media", `已自动使用默认数字人素材：${defaultFilename}`);
      } else {
        return { ok: false, note: "请先从素材库选择一段本人出镜视频（选择一次后会自动记为默认）" };
      }
    }
    const source = join(job.workspace, meta.avatar.source);
    if (!existsSync(source)) return { ok: false, note: "所选数字人视频不存在，请重新从素材库选择" };
    const presDir = join(job.workspace, "presentation");
    const audioRoot = join(presDir, "public", "audio");
    // The avatar video must use the exact presentation timeline. Alphabetic
    // directory sorting puts "accumulate" before "hook" and makes every
    // subsequent lip-sync offset wrong even though all files exist.
    const files = orderedAvatarAudioFiles(presDir, audioRoot);
    if (!files.length) return { ok: false, note: "没有找到配音文件" };
    avatarProgress(job.id, 6, `整理 ${files.length} 段配音`);
    const avatarDir = join(presDir, "public", "avatar");
    mkdirSync(avatarDir, { recursive: true });
    const lipsync = join(avatarDir, "lipsync.mp4");
    const markerPath = join(avatarDir, "build.json");
    const sourceFingerprint = await fingerprintFileContents(source);
    const fingerprint = fingerprintFiles([source, ...files]);
    let reusable = false;
    if (existsSync(lipsync) && existsSync(markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        reusable = marker.fingerprint === fingerprint && marker.sourceFingerprint === sourceFingerprint;
      } catch {}
    }
    if (reusable) {
      avatarProgress(job.id, 88, "数字人媒体已生成，跳过重复模型计算");
      const split = await splitAvatarPreviews(job, files, lipsync, avatarDir, presDir);
      if (!split.ok) return split;
      return { ok: true, note: "数字人媒体命中 checkpoint（未重复推理），进入接线" };
    }
    const service = await heygemHealth();
    if (!service.ok || !service.ready) return { ok: false, note: "HeyGem 服务未启动或模型未就绪，请先在设置中确认数字人服务状态" };
    const concatFile = join(avatarDir, "audio-list.txt");
    writeFileSync(concatFile, files.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const merged = join(avatarDir, "narration.mp3");
    const merge = await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", merged], presDir, job.id, "avatar_media");
    if (!merge.ok) return merge;
    // HeyGem 服务端用 cv2 逐帧读上传的视频，HEVC/H.265 源会让 VideoCapture.read
    // 直接抛异常（job#11 实测：推理到 28% 崩）。非 H.264 源先转码，结果缓存复用。
    let uploadPath = source;
    const codec = await videoCodec(source).catch(() => "unknown");
    if (codec !== "h264") {
      const normalized = join(avatarDir, `presenter-${sourceFingerprint.slice(0, 16)}-h264.mp4`);
      if (!existsSync(normalized)) {
        avatarProgress(job.id, 9, `出镜视频编码为 ${codec}，正在转码为 HeyGem 兼容的 H.264`);
        const trans = await sh("ffmpeg", ["-y", "-i", source, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", normalized], presDir, job.id, "avatar_media");
        if (!trans.ok) return trans;
      }
      uploadPath = normalized;
    }
    avatarProgress(job.id, 12, "配音合并完成，正在上传模型");
    const submitted = await submitJob({
      audioB64: readFileSync(merged).toString("base64"),
      videoB64: readFileSync(uploadPath).toString("base64"),
      videoFmt: uploadPath.toLowerCase().endsWith(".mov") ? "mov" : "mp4",
    });
    avatarProgress(job.id, 18, "HeyGem 已接收任务，开始口型推理");
    let lastProgress = -1;
    for (let i = 0; i < 360; i += 1) {
      const state = await taskStatus(submitted.taskId);
      const progress = Number(state.progress ?? 0);
      if (progress >= lastProgress + 5) {
        lastProgress = progress;
        avatarProgress(job.id, 18 + progress * 0.68, `模型推理 ${Math.min(100, Math.round(progress))}%`);
      }
      if (state.status === "done") {
        avatarProgress(job.id, 88, "模型完成，正在下载数字人视频");
        const rawLipsync = join(avatarDir, "lipsync-raw.mp4");
        writeFileSync(rawLipsync, await downloadResult(submitted.taskId));
        // HeyGem 输出关键帧间隔 10s，浏览器 seek 要从关键帧起解码、卡成幻灯片
        //（job-20 实测）；重编码为 1s 关键帧让换步/换章 seek 瞬间完成。
        avatarProgress(job.id, 89, "正在优化关键帧间隔（流畅换页）");
        const gop = await sh("ffmpeg", ["-y", "-i", rawLipsync, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-g", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "copy", lipsync], presDir, job.id, "avatar_media");
        if (!gop.ok) return gop;
        rmSync(rawLipsync, { force: true });
        writeJson(markerPath, { fingerprint, sourceFingerprint, generatedAt: new Date().toISOString() });
        const split = await splitAvatarPreviews(job, files, lipsync, avatarDir, presDir);
        if (!split.ok) return split;
        return { ok: true, note: "数字人媒体生成完成，进入接线" };
      }
      if (state.status === "error") return { ok: false, note: state.error || "数字人生成失败" };
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return { ok: false, note: "数字人生成超时，可直接重试本环节" };
  },

  /** 接线段：确定性写 registry 配置驱动模板组件；旧脚手架回退 LLM 接线。 */
  async avatar_wire(job) {
    let meta = {};
    try { meta = JSON.parse(job.meta || "{}"); } catch {}
    const presDir = join(job.workspace, "presentation");
    if (!meta.avatar?.enabled) {
      applySubtitlePreset(presDir, jobOptions(job));
      return { ok: true, note: "本作品未启用数字人，跳过接线" };
    }
    const appPath = join(presDir, "src", "App.tsx");
    const hasContract = existsSync(appPath) && readFileSync(appPath, "utf8").includes("avatar-mount:v1");
    if (!hasContract) {
      logEvent(job.id, "avatar_wire", "旧版脚手架（无 avatar-mount:v1 契约），回退 LLM 接线");
      return wireAvatarWithAgent(job, meta, presDir);
    }
    avatarProgress(job.id, 30, "按确定性契约写入数字人配置", "avatar_wire");
    const positionKey = meta.avatar?.position || "right-third";
    // 尺寸定稿依据 PROJECT-MEMORY：右侧讲师区 = 标准 360×640 竖窗缩小 30%
    // → 252×448，正文预留 448px；角落小窗预留 360px。
    const sizes = positionKey === "right-third"
      ? { reservePx: 448, windowWidthPx: 252, windowHeightPx: 448 }
      : { reservePx: 360, windowWidthPx: 252, windowHeightPx: 448 };
    const avatarConfig = { enabled: true, position: positionKey, ...sizes };
    writeFileSync(join(presDir, "src", "registry", "avatarConfig.ts"), [
      "// AUTO-GENERATED by VideoForge avatar_wire — do not hand-edit.",
      'export type AvatarPosition = "right-third" | "right-top" | "right-bottom";',
      "",
      "export interface AvatarConfig {",
      "  enabled: boolean;",
      "  position: AvatarPosition;",
      "  reservePx: number;",
      "  windowWidthPx: number;",
      "  windowHeightPx: number;",
      "}",
      "",
      `export const AVATAR_CONFIG: AvatarConfig = ${JSON.stringify(avatarConfig, null, 2)};`,
      "",
    ].join("\n"));
    applySubtitlePreset(presDir, jobOptions(job));
    avatarProgress(job.id, 60, "TypeScript 检查", "avatar_wire");
    const checked = await typecheckPresentation(presDir, job.id, "avatar_wire");
    if (!checked.ok) return checked;
    avatarProgress(job.id, 85, "更新作品封面", "avatar_wire");
    try {
      await captureJobCover(job, { requireAvatar: true });
    } catch (error) {
      logEvent(job.id, "cover", `数字人已接线，但封面更新失败：${error.message}`, "warning");
    }
    updateJob(job.id, {
      meta: JSON.stringify({ ...meta, avatar: { ...(meta.avatar ?? {}), pendingRegeneration: false } }),
    });
    avatarProgress(job.id, 100, "数字人接线完成（registry 数据驱动，无 LLM 参与）", "avatar_wire");
    return { ok: true, note: "数字人已按确定性契约接入右侧讲师区" };
  },

  /** 服务端一键成片（无头浏览器 + ffmpeg）；失败时给出手动录制兜底方法。 */
  async render(job) {
    const presDir = join(job.workspace, "presentation");
    if (!existsSync(presDir)) return { ok: false, note: "presentation 尚未生成" };
    try {
      return await renderJob(job);
    } catch (err) {
      const fallback = [
        `服务端渲染失败：${err.message}`,
        "可先用手动录制兜底（Auto 模式一镜到底）：",
        "1. 用面板预览按钮起 dev server，浏览器全屏打开 http://localhost:<端口>/?auto=1",
        "2. 启动系统录屏（Win+G / OBS），按一次 SPACE，整片自动播完后停止录制",
        "修复问题后可在导出环节重试服务端渲染。",
      ].join("\n");
      logEvent(job.id, "render", fallback, "error");
      return { ok: false, note: fallback };
    }
  },
};

export async function runStage(job) {
  const runner = runners[job.stage];
  if (!runner) return { ok: false, note: `no runner for stage ${job.stage}` };
  return runner(job);
}

/** Repair the lowest-scoring rendered steps using the audit screenshots as
 * multimodal evidence. The pipeline calls this only after a complete build,
 * then rebuilds and audits again before allowing chapter approval. */
export async function repairChapterQuality(job, audit) {
  const skill = config.skills.webVideoPresentation;
  const failed = [...(audit.steps || [])]
    .filter((step) => !step.pass)
    .sort((a, b) => a.score - b.score)
    .slice(0, 6);
  if (!failed.length) return { ok: true, note: "没有需要修复的低分画面" };
  const imagePaths = failed.map((step) => join(
    job.workspace,
    "presentation",
    "public",
    "quality-audit",
    step.screenshot,
  )).filter(existsSync);
  const findings = failed.map((step) => ({
    chapter: step.chapter + 1,
    step: step.step + 1,
    score: step.score,
    screenshot: step.screenshot,
    collisions: step.visual?.collisions || 0,
    overflow: step.overflowCount || 0,
    subtitleChars: step.visual?.subtitleTextLength || 0,
    subtitleLines: step.visual?.subtitleLines || 0,
    longContentBlocks: step.visual?.longContentBlocks || 0,
  }));
  const prompt = [
    "当前目录是 VideoForge 网页演示项目。自动逐屏截图验收未达到 90 分，必须直接修改 presentation 代码并修复，不要只解释或输出自检清单。",
    `必须重新阅读 ${skill}/references/CHAPTER-CRAFT.md，并把它作为硬性验收标准。`,
    "已附上最低分画面的真实 1920×1080 截图。先逐张观察重叠、拥挤、字幕遮挡、文字密度和安全区问题，再定位对应章节代码。",
    `失败明细：${JSON.stringify(findings)}`,
    "硬性要求：每屏只保留一个主结论；正文说明最多两条且每条一行；单块中文正文超过 28 字必须删减或拆 step，禁止缩小字号硬塞。",
    "字幕必须与对应 narration/音频 step 一一对应，每次只显示一行短句，中文目标 8 字、硬上限 10 字，下一句出现时上一句消失。",
    "字幕安全带和数字人安全区内不得放正文、图表、关键数字或高对比装饰。任何非设计性重叠都必须消除。",
    "如果拆分或合并 step，必须同步维护组件条件、narrations.ts、chapters.ts 和 useStepper STORAGE_KEY；不得只改字幕或只改声音造成音画错位。",
    "完成后运行 npx tsc --noEmit。不要向用户提问，修完即退出。",
  ].join("\n");
  return runAgent({
    jobId: job.id,
    stage: "quality_repair",
    cwd: job.workspace,
    prompt,
    usageOperation: "visual-quality-repair",
    imagePaths,
  });
}

/** Feedback -> scoped debug agent run against one chapter (or global). */
export async function runFeedback(job, { chapter, message, phase, attachmentPath = null, onProgress = () => {} }) {
  onProgress(10, "正在理解你的修改要求");
  const skill = config.skills.webVideoPresentation;
  const options = jobOptions(job);
  let scopeLine = phase === "口播稿审阅"
      ? `当前查看“口播稿审阅”：只允许修改 script.md；若章节标题变化，可同步 outline.md 的对应标题。不得修改 presentation。`
      : phase === "选择风格"
        ? `当前查看“选择风格”：只解释可执行的风格调整，不修改稿件；具体主题和数字人占位由界面控件保存。`
        : chapter
          ? `本次只允许修改 presentation/src/chapters/${chapter}/ 内的文件（如结构变化才允许动 chapters.ts / useStepper.ts 的 STORAGE_KEY）。`
          : phase === "逐页生成"
            ? `本次是全局画面修改：检查 presentation/src/chapters/ 下全部章节，只修改与用户要求直接相关的页面；每个受影响章节都要完成类型检查。`
            : `当前查看“${phase || "画面"}”：只允许修改 presentation 内与反馈直接相关的文件，改动范围尽量小。`;
  // 给 Agent 喂最近一次质量审计证据（QUALITY-ARCHITECTURE §9 R3）：盲修变有据可依
  try {
    const audit = JSON.parse(readFileSync(join(job.workspace, "presentation", "public", "quality-audit.json"), "utf8"));
    const failing = (audit.steps || []).filter((s) => !s.pass).slice(0, 8)
      .map((s) => `第${s.chapter + 1}章第${s.step + 1}屏 ${s.score}分(碰撞${s.visual?.collisions || 0}/溢出${s.overflowCount || 0})`);
    scopeLine += `\n最近一次质量审计：整体 ${audit.score}/100${failing.length ? `；低分屏：${failing.join("、")}` : "，全部通过"}。你的修改不得让这些指标变差。`;
  } catch {}

  if (phase === "配音字幕") {
    scopeLine = `当前环节只允许修改 narration、字幕和音频相关文件，不得修改 presentation 的布局、主题或章节正文。`;
  } else if (phase === "数字人") {
    scopeLine = `当前环节只允许修改数字人素材、口型视频接入和相关配置，不得修改文案、口播稿、主题或页面布局。`;
  }
  const subtitlePosition = options.subtitle?.position || "bottom";
  const subtitleSafety = options.subtitle?.enabled === false
    ? "本作品未启用字幕，无字幕安全带要求。"
    : subtitlePosition === "top"
      ? "本作品启用顶部字幕，顶部 170px 必须保持为无正文安全带。"
      : subtitlePosition === "lower-third"
        ? "本作品启用下三分之一字幕，底部 290px 必须保持为无正文安全带。"
        : "本作品启用底部字幕，底部 190px 必须保持为无正文安全带。";
  const prompt = [
    `当前目录是一个 VideoForge 作品工作区，用户正在“${phase || "画面调试"}”环节提出修改反馈。`,
    `用户反馈：${message}`,
    attachmentPath ? `用户同时提供了参考截图：${attachmentPath}。必须先读取并分析图片中的拥挤、重叠、字号、字幕或音画对应问题，再修改代码；回执中说明从截图观察到了什么。` : "",
    scopeLine,
    `严格执行最小改动：用户只要求样式时，禁止修改任何可见文案、narrations.ts、step 数和组件结构；用户只要求文案时，禁止改布局和样式。`,
    `如果用户反馈“拥挤、重叠、字太多、堆在一起、看不清”，这属于结构问题而不是纯样式问题：允许删减次要屏幕文字、重排组件或拆分 step，并同步维护 narrations.ts 与 step 数；禁止通过缩小字号硬塞。`,
    `${subtitleSafety} 安全带内不得放正文、关键数字、图表或高对比装饰；数字人与字幕同时启用时取两者安全区并集。`,
    `如果作品启用了数字人，右侧讲师安全区必须保持为空，不得加入卡片、摘要、图表或装饰内容；只能放数字人视频或低对比度的占位提示。`,
    `修改前后必须自行检查 git diff（即使项目未纳入 git，也要逐文件核对），发现超出用户要求的改动必须撤回。`,
    `修改时遵守 ${skill}/references/CHAPTER-CRAFT.md 的规范（单屏信息预算 / 无重叠 / 主题 token / 反AI味）。`,
    `完成后 npx tsc --noEmit 必须 0 错误。不要向用户提问，做完即退出。`,
    `最后必须用中文输出简短回执，严格包含三段：`,
    `具体修改：列出实际改动的文件或内容，不要只说“已优化”。`,
    `修改思路：说明为什么这样调整，以及它如何回应用户要求。`,
    `检查结果：列出实际执行的检查与结果；未执行的检查要如实说明。`,
  ].join("\n");
  onProgress(16, "已限定修改范围，正在启动模型");
  const usageOperation = phase === "口播稿审阅"
    ? "text-refine"
    : phase === "配音字幕"
      ? "audio-refine"
      : ["选择风格", "逐页生成"].includes(phase)
        ? "visual-refine"
        : phase === "数字人"
          ? "avatar-refine"
          : "refine";
  return runAgent({ engine: loadSettings().llm.feedbackEngine, jobId: job.id, stage: "debug", cwd: job.workspace, prompt, onProgress, usageOperation, imagePaths: attachmentPath ? [join(job.workspace, attachmentPath)] : [] });
}

export function readArticleTitle(workspace) {
  try {
    const md = readFileSync(join(workspace, "article.md"), "utf8");
    return md.match(/^#\s+(.+)$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}
