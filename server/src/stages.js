import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "./config.js";
import { logEvent, recordUsage } from "./db.js";
import { runAgent } from "./agentRunner.js";
import { health as heygemHealth, submitJob, taskStatus, downloadResult } from "./heygem.js";

/**
 * Pipeline definition. Each stage is either:
 *   kind: "work"  — has run(job) -> Promise<{ok, note?}>
 *   kind: "gate"  — pipeline parks the job as waiting_approval; the
 *                   dashboard's approve button advances it.
 */
export const STAGES = [
  { id: "script_outline", kind: "work", label: "口播稿 + Outline" },
  { id: "gate_script", kind: "gate", label: "稿件审批" },
  { id: "gate_style", kind: "gate", label: "风格与数字人占位确认" },
  { id: "scaffold", kind: "work", label: "脚手架" },
  { id: "chapter_gen", kind: "work", label: "章节生成" },
  { id: "gate_chapters", kind: "gate", label: "章节验收（可反馈调试）" },
  { id: "audio_synth", kind: "work", label: "音频合成" },
  { id: "subtitle_cues", kind: "work", label: "精确字幕" },
  { id: "avatar_gen", kind: "work", label: "数字人对口型" },
  { id: "render", kind: "work", label: "成片指引" },
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

function sh(cmd, args, cwd, jobId, stage) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: true, env: process.env });
    let out = "";
    const cap = (s) => (s.length > 20000 ? s.slice(-20000) : s);
    child.stdout.on("data", (d) => (out = cap(out + d)));
    child.stderr.on("data", (d) => (out = cap(out + d)));
    child.on("close", (code) => {
      logEvent(jobId, stage, `$ ${cmd} ${args.join(" ")}\nexit ${code}\n${out.slice(-1500)}`, code === 0 ? "info" : "error");
      resolve({ ok: code === 0, output: out });
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

function avatarProgress(jobId, percent, message) {
  logEvent(jobId, "avatar_gen", `progress|${Math.max(0, Math.min(100, Math.round(percent)))}|${message}`);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureNativeScaffold(skill, target, theme) {
  const templates = join(skill, "templates");
  const tokens = join(skill, "themes", theme, "tokens.css");
  if (!existsSync(tokens)) throw new Error(`找不到画面主题：${theme}`);

  const existing = existsSync(join(target, "package.json")) && existsSync(join(target, "src", "App.tsx"));
  mkdirSync(target, { recursive: true });
  if (!existing) {
    cpSync(join(templates, "src"), join(target, "src"), { recursive: true, force: true });
    cpSync(join(templates, "scripts"), join(target, "scripts"), { recursive: true, force: true });
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
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: {
        "@types/node": "^22.10.2",
        "@types/react": "^18.3.12",
        "@types/react-dom": "^18.3.1",
        "@vitejs/plugin-react": "^4.3.4",
        tsx: "^4.19.2",
        typescript: "^5.7.2",
        vite: "^6.0.0",
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
  rmSync(join(target, "src", "chapters", "01-example"), { recursive: true, force: true });
  writeFileSync(join(target, ".theme"), `${theme}\n`);
  return { existing };
}

function jobOptions(job) {
  try { return JSON.parse(job.meta || "{}"); } catch { return {}; }
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
      const { existing } = ensureNativeScaffold(skill, target, theme);
      logEvent(job.id, "scaffold", existing ? `已保留现有章节并切换主题：${theme}` : `已创建原生画面工程：${theme}`);
      if (!existsSync(join(target, "node_modules"))) {
        const install = await sh("npm", ["install"], target, job.id, "scaffold");
        if (!install.ok) return install;
      }
      return sh("npx", ["tsc", "--noEmit"], target, job.id, "scaffold");
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
    const prompt = [
      `你在一个视频生成流水线的无人值守环节中工作。当前目录是一个已完成 Phase 1 的 web-video-presentation 项目：`,
      `- ./article.md ./script.md ./outline.md 已定稿（不要改它们）`,
      `- ./presentation/ 已用主题 ${theme} 脚手架完成，01-example 已删除`,
      avatarLayout,
      ``,
      `任务：按 outline.md 把全部章节开发完成。规范（必须照做）：`,
      `- 每章开发前重读 ${skill}/references/CHAPTER-CRAFT.md（单一必读入口）`,
      `- 每章独立文件夹 + 独立 CSS 前缀 + narrations.ts（长度 = step 数）`,
      `- 全部注册进 src/registry/chapters.ts，每次结构变化 bump useStepper.ts 的 STORAGE_KEY`,
      `- 颜色/字体只用主题 token；正文字号 ≥ 20px（本项目用户明确偏好大字）`,
      `- kicker 用 .title-label 一类的大标题样式，不要小号说明文字`,
      `- 每章完成后自己跑完工自检并修复 FAIL 项；全项目 npx tsc --noEmit 必须 0 错误`,
      `- 可以并行使用子任务加速，但最终交付要整体一致`,
      `不要停下来向用户提问。全部做完、tsc 通过后退出。`,
    ].join("\n");
    return runAgent({ jobId: job.id, stage: "chapter_gen", cwd: job.workspace, prompt });
  },

  /**
   * Deterministic: extract narrations -> synthesize with MiniMax word-level
   * timestamps. Uses the template script (jq-free, incremental, rate-limited).
   */
  async audio_synth(job) {
    const apiKey = process.env[config.tts.apiKeyEnv];
    if (!apiKey) {
      return { ok: false, note: `环境变量 ${config.tts.apiKeyEnv} 未设置——在启动 server 的终端里 set 之后重试本阶段` };
    }
    const presDir = join(job.workspace, "presentation");
    const scriptsDir = join(presDir, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(join(ROOT, "server/templates/synthesize-audio-node.mjs"), join(scriptsDir, "synthesize-audio-node.mjs"));

    let r = await sh("npm", ["run", "extract-narrations"], presDir, job.id, "audio_synth");
    if (!r.ok) return r;
    r = await sh("node", ["scripts/synthesize-audio-node.mjs"], presDir, job.id, "audio_synth");
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
    const scriptsDir = join(presDir, "scripts");
    copyFileSync(join(ROOT, "server/templates/gen-subtitle-cues.mjs"), join(scriptsDir, "gen-subtitle-cues.mjs"));

    const r = await sh("node", ["scripts/gen-subtitle-cues.mjs"], presDir, job.id, "subtitle_cues");
    if (!r.ok) return r;

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
      return runAgent({ jobId: job.id, stage: "subtitle_cues", cwd: job.workspace, prompt });
    }
    return { ok: true };
  },

  async avatar_gen(job) {
    let meta = {};
    try { meta = JSON.parse(job.meta || "{}"); } catch {}
    if (!meta.avatar?.enabled) return { ok: true, note: "本作品未启用数字人" };
    avatarProgress(job.id, 2, "检查数字人服务和素材");
    const service = await heygemHealth();
    if (!service.ok || !service.ready) return { ok: false, note: "HeyGem 服务未启动或模型未就绪，请先在设置中确认数字人服务状态" };
    if (!meta.avatar.source) return { ok: false, note: "请先从素材库选择一段本人出镜视频" };
    const source = join(job.workspace, meta.avatar.source);
    if (!existsSync(source)) return { ok: false, note: "所选数字人视频不存在，请重新从素材库选择" };
    const presDir = join(job.workspace, "presentation");
    const audioRoot = join(presDir, "public", "audio");
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const p = join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : entry.name.endsWith(".mp3") ? [p] : [];
    });
    const files = walk(audioRoot).sort();
    if (!files.length) return { ok: false, note: "没有找到配音文件" };
    avatarProgress(job.id, 6, `整理 ${files.length} 段配音`);
    const avatarDir = join(presDir, "public", "avatar");
    mkdirSync(avatarDir, { recursive: true });
    const concatFile = join(avatarDir, "audio-list.txt");
    writeFileSync(concatFile, files.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    const merged = join(avatarDir, "narration.mp3");
    const merge = await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c:a", "libmp3lame", merged], presDir, job.id, "avatar_gen");
    if (!merge.ok) return merge;
    avatarProgress(job.id, 12, "配音合并完成，正在上传模型");
    const submitted = await submitJob({
      audioB64: readFileSync(merged).toString("base64"),
      videoB64: readFileSync(source).toString("base64"),
      videoFmt: source.toLowerCase().endsWith(".mov") ? "mov" : "mp4",
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
        const lipsync = join(avatarDir, "lipsync.mp4");
        writeFileSync(lipsync, await downloadResult(submitted.taskId));
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
          const cut = await sh("ffmpeg", ["-y", "-ss", cursor.toFixed(3), "-i", lipsync, "-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-an", output], presDir, job.id, "avatar_gen");
          if (!cut.ok) return cut;
          cursor += duration;
          chapterIndex += 1;
          avatarProgress(job.id, 91 + (chapterIndex / groups.size) * 4, `已生成章节预览 ${chapterIndex}/${groups.size}`);
        }
        const skill = config.skills.videoAvatarSubtitles;
        const position = meta.avatar.position === "right-top" ? "右上角小窗" : meta.avatar.position === "right-bottom" ? "右下角小窗" : "右侧讲师区（较标准三分之一区域缩小 30%）";
        const reserve = meta.avatar.position === "right-third" ? 448 : 360;
        const prompt = [
          `当前目录是已完成配音与字幕的网页演示，public/avatar/lipsync.mp4 是刚生成的全片数字人对口型视频。`,
          `严格按照 ${skill}/references/AVATAR-PIPELINE.md 接入讲师窗口：`,
          `- 本作品选择的位置是${position}，右侧预留宽度是 ${reserve}px；人物窗口 right 40px、圆角 28px，保持原右侧锚点，不得居中或向左移动`,
          `- 所有 PPT 正文永久为右侧预留 ${reserve}px，逐页重排，关键文字、图表不得进入这一区域`,
          `- video 必须 muted、playsInline，由当前音频时间轴驱动，不得让它自由播放`,
          `- 跟随每个 step 的真实累计音频位置同步，切换 step 时不得从视频开头重播`,
          `- 完成后运行 npx tsc --noEmit，修复全部错误后退出。`,
        ].join("\n");
        avatarProgress(job.id, 96, "正在把数字人接入每一页画面");
        const wired = await runAgent({ jobId: job.id, stage: "avatar_gen", cwd: presDir, prompt });
        if (wired.ok) avatarProgress(job.id, 100, "数字人生成和章节预览已完成");
        return wired.ok ? { ok: true, note: "数字人对口型视频已生成并接入右侧讲师区" } : wired;
      }
      if (state.status === "error") return { ok: false, note: state.error || "数字人生成失败" };
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return { ok: false, note: "数字人生成超时，可直接重试本环节" };
  },

  /**
   * v1 keeps recording manual (most reliable): write instructions. A later
   * version can drive Playwright + ffmpeg here.
   */
  async render(job) {
    const presDir = join(job.workspace, "presentation");
    const note = [
      "录制方法（Auto 模式一镜到底）：",
      "1. 在 presentation/ 目录 npm run dev（或用面板上的预览按钮起 dev server）",
      "2. 浏览器全屏打开 http://localhost:<端口>/?auto=1",
      "3. 先启动系统录屏（Win+G / OBS），再按一次 SPACE，整片自动播完",
      "4. 停止录制，掐掉头尾即成片。音画在页面内已同步，无需后期对轨。",
    ].join("\n");
    logEvent(job.id, "render", note);
    return { ok: existsSync(presDir), note };
  },
};

export async function runStage(job) {
  const runner = runners[job.stage];
  if (!runner) return { ok: false, note: `no runner for stage ${job.stage}` };
  return runner(job);
}

/** Feedback -> scoped debug agent run against one chapter (or global). */
export async function runFeedback(job, { chapter, message, phase, onProgress = () => {} }) {
  onProgress(10, "正在理解你的修改要求");
  const skill = config.skills.webVideoPresentation;
  let scopeLine = phase === "文案确认"
    ? `当前查看“文案确认”：只允许修改 article.md，不得修改其他文件。`
    : phase === "口播稿审阅"
      ? `当前查看“口播稿审阅”：只允许修改 script.md；若章节标题变化，可同步 outline.md 的对应标题。不得修改 presentation。`
      : phase === "选择风格"
        ? `当前查看“选择风格”：只解释可执行的风格调整，不修改稿件；具体主题和数字人占位由界面控件保存。`
        : chapter
          ? `本次只允许修改 presentation/src/chapters/${chapter}/ 内的文件（如结构变化才允许动 chapters.ts / useStepper.ts 的 STORAGE_KEY）。`
          : `当前查看“${phase || "画面"}”：只允许修改 presentation 内与反馈直接相关的文件，改动范围尽量小。`;
  if (phase === "配音字幕") {
    scopeLine = `当前环节只允许修改 narration、字幕和音频相关文件，不得修改 presentation 的布局、主题或章节正文。`;
  } else if (phase === "数字人") {
    scopeLine = `当前环节只允许修改数字人素材、口型视频接入和相关配置，不得修改文案、口播稿、主题或页面布局。`;
  }
  const prompt = [
    `当前目录是一个 VideoForge 作品工作区，用户正在“${phase || "画面调试"}”环节提出修改反馈。`,
    `用户反馈：${message}`,
    scopeLine,
    `严格执行最小改动：用户只要求样式时，禁止修改任何可见文案、narrations.ts、step 数和组件结构；用户只要求文案时，禁止改布局和样式。`,
    `如果作品启用了数字人，右侧讲师安全区必须保持为空，不得加入卡片、摘要、图表或装饰内容；只能放数字人视频或低对比度的占位提示。`,
    `修改前后必须自行检查 git diff（即使项目未纳入 git，也要逐文件核对），发现超出用户要求的改动必须撤回。`,
    `修改时遵守 ${skill}/references/CHAPTER-CRAFT.md 的规范（主题 token / 字号 ≥20px / 反AI味）。`,
    `完成后 npx tsc --noEmit 必须 0 错误。不要向用户提问，做完即退出。`,
    `最后必须用中文输出简短回执，严格包含三段：`,
    `具体修改：列出实际改动的文件或内容，不要只说“已优化”。`,
    `修改思路：说明为什么这样调整，以及它如何回应用户要求。`,
    `检查结果：列出实际执行的检查与结果；未执行的检查要如实说明。`,
  ].join("\n");
  onProgress(16, "已限定修改范围，正在启动模型");
  const usageOperation = ["文案确认", "口播稿审阅"].includes(phase)
    ? "text-refine"
    : phase === "配音字幕"
      ? "audio-refine"
      : ["选择风格", "逐页生成"].includes(phase)
        ? "visual-refine"
        : phase === "数字人"
          ? "avatar-refine"
          : "refine";
  return runAgent({ jobId: job.id, stage: "debug", cwd: job.workspace, prompt, onProgress, usageOperation });
}

export function readArticleTitle(workspace) {
  try {
    const md = readFileSync(join(workspace, "article.md"), "utf8");
    return md.match(/^#\s+(.+)$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}
