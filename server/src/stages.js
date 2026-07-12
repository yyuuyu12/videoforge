import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, ROOT } from "./config.js";
import { logEvent } from "./db.js";
import { runAgent } from "./agentRunner.js";

/**
 * Pipeline definition. Each stage is either:
 *   kind: "work"  — has run(job) -> Promise<{ok, note?}>
 *   kind: "gate"  — pipeline parks the job as waiting_approval; the
 *                   dashboard's approve button advances it.
 */
export const STAGES = [
  { id: "script_outline", kind: "work", label: "口播稿 + Outline" },
  { id: "gate_script", kind: "gate", label: "稿件审批" },
  { id: "scaffold", kind: "work", label: "脚手架" },
  { id: "chapter_gen", kind: "work", label: "章节生成" },
  { id: "gate_chapters", kind: "gate", label: "章节验收（可反馈调试）" },
  { id: "audio_synth", kind: "work", label: "音频合成" },
  { id: "subtitle_cues", kind: "work", label: "精确字幕" },
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

const runners = {
  /**
   * article.md (written at job creation) -> script.md + outline.md.
   * Mirrors web-video-presentation Phase 1, but told to run its own
   * self-check loop and NOT to wait for interactive confirmation — the
   * approval gate lives in the dashboard instead.
   */
  async script_outline(job) {
    const skill = config.skills.webVideoPresentation;
    const prompt = [
      `你在一个视频生成流水线的无人值守环节中工作，当前目录是一个视频项目工作区。`,
      `输入文章在 ./article.md。`,
      `请严格按照这个 Skill 的 Phase 1 规范工作：${skill}/SKILL.md`,
      `（必读其中引用的 references/SCRIPT-STYLE.md 与 references/OUTLINE-FORMAT.md）`,
      ``,
      `任务：产出 ./script.md（口播稿）和 ./outline.md（开发计划）。`,
      `outline.md 顶部主题字段直接写 \`${config.theme}\`。`,
      `两份文件都必须自己走完各自的自检清单并修复所有 FAIL 项后才算完成。`,
      `不要停下来向用户提问——审批在流水线外部完成。做完即退出。`,
    ].join("\n");
    return runAgent({ jobId: job.id, stage: "script_outline", cwd: job.workspace, prompt });
  },

  async scaffold(job) {
    const skill = config.skills.webVideoPresentation;
    const scaffoldSh = `${skill}/scripts/scaffold.sh`.replace(/\\/g, "/");
    const r = await sh(
      "bash",
      [JSON.stringify(scaffoldSh), "./presentation", `--theme=${config.theme}`],
      job.workspace,
      job.id,
      "scaffold",
    );
    if (!r.ok) return r;
    // Remove the demo chapter so chapter_gen starts clean.
    await sh("bash", ["-c", '"rm -rf presentation/src/chapters/01-example"'], job.workspace, job.id, "scaffold");
    return { ok: true };
  },

  /**
   * Build every chapter per outline.md. One agent session drives the whole
   * build (it may use its own subagents); it must register chapters, keep
   * narrations.ts as the source of truth, run tsc, and self-check each
   * chapter against CHAPTER-CRAFT.md.
   */
  async chapter_gen(job) {
    const skill = config.skills.webVideoPresentation;
    const prompt = [
      `你在一个视频生成流水线的无人值守环节中工作。当前目录是一个已完成 Phase 1 的 web-video-presentation 项目：`,
      `- ./article.md ./script.md ./outline.md 已定稿（不要改它们）`,
      `- ./presentation/ 已用主题 ${config.theme} 脚手架完成，01-example 已删除`,
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
export async function runFeedback(job, { chapter, message }) {
  const skill = config.skills.webVideoPresentation;
  const scopeLine = chapter
    ? `本次只允许修改 presentation/src/chapters/${chapter}/ 内的文件（如结构变化才允许动 chapters.ts / useStepper.ts 的 STORAGE_KEY）。`
    : `根据反馈判断涉及哪些文件，改动范围尽量小。`;
  const prompt = [
    `当前目录是一个 web-video-presentation 项目，用户对当前成品提出了修改反馈。`,
    `用户反馈：${message}`,
    scopeLine,
    `修改时遵守 ${skill}/references/CHAPTER-CRAFT.md 的规范（主题 token / 字号 ≥20px / 反AI味）。`,
    `完成后 npx tsc --noEmit 必须 0 错误。不要向用户提问，做完即退出。`,
  ].join("\n");
  return runAgent({ jobId: job.id, stage: "debug", cwd: job.workspace, prompt });
}

export function readArticleTitle(workspace) {
  try {
    const md = readFileSync(join(workspace, "article.md"), "utf8");
    return md.match(/^#\s+(.+)$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}
