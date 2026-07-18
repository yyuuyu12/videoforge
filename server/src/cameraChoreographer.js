import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * 确定性镜头编排器（2026-07-17，用户定稿"AI 自动必须等于手排质量"）。
 *
 * 原理：手排镜头用的本来就是规则，不是品味——大数字→特写/放大镜、列表→
 * 聚光、正文→轻 pan 呼吸、章首/中段/章尾→数字人时刻、相邻步不连强推、
 * 密度下限保底。把这段规则跑在**渲染后的真实 DOM** 上（无头逐步走查），
 * 对任何章节代码风格都通用（不依赖数据 schema）；AI 在 registry 里声明的
 * 镜头视为"有意设计"优先保留，机器只补空位到密度下限。
 *
 * 产出：src/registry/cameraCues.ts（与手排同一格式，过同一校验）。
 */

const DENSITY_TARGET = { restrained: 1, standard: 2, dense: 2 }; // 每章下限
const DENSITY_CAP = { restrained: 2, standard: 3, dense: 4 };    // 每章上限

async function launchBrowser() {
  const { chromium } = require("playwright-core");
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, args: ["--force-device-scale-factor=1"] });
    } catch {}
  }
  throw new Error("未找到系统 Chrome/Edge");
}

/** 每步的 DOM 信号提取（在页面内执行）。返回可序列化的候选目标。 */
function extractSignalsInPage() {
  const root = document.querySelector(".camera-breath") || document.querySelector(".scene");
  if (!root) return null;

  // 生成"从 root 到元素"的确定性选择器（nth-child 链，逐层可复现）
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== root) {
      const parent = node.parentElement;
      if (!parent) break;
      const index = Array.prototype.indexOf.call(parent.children, node) + 1;
      const cls = [...node.classList].find((c) => /^[a-z][\w-]*$/i.test(c));
      parts.unshift(cls ? `.${CSS.escape(cls)}:nth-child(${index})` : `:nth-child(${index})`);
      node = parent;
    }
    // CameraLayer 运行时用 layer.querySelector(target)（layer = .camera-layer），
    // 以 .camera-breath 为锚起链，两边坐标系一致
    return parts.length ? `.camera-breath > ${parts.join(" > ")}` : null;
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };

  // 信号一：大数字块（含数字、字号大、文本短）
  let numeric = null;
  for (const el of root.querySelectorAll("*")) {
    if (!visible(el) || el.children.length > 3) continue;
    const text = (el.textContent || "").trim();
    if (!/[0-9]/.test(text) || text.length < 1 || text.length > 14) continue;
    const fontSize = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (fontSize < 40) continue;
    const r = el.getBoundingClientRect();
    const score = fontSize * Math.sqrt(r.width * r.height);
    if (!numeric || score > numeric.score) numeric = { score, path: pathOf(el) };
  }

  // 信号二：列表簇（同类子元素 ≥3 的容器）
  let list = null;
  for (const el of root.querySelectorAll("*")) {
    if (!visible(el) || el.children.length < 3) continue;
    const tags = [...el.children].map((c) => c.tagName + "." + c.className);
    if (new Set(tags).size !== 1) continue;
    const r = el.getBoundingClientRect();
    const score = r.width * r.height;
    if (!list || score > list.score) list = { score, path: pathOf(el) };
  }

  // 信号三：主内容块（h1 的最近块容器，pan 呼吸目标）
  // 信号四：主标题 h1 本身（强 focus 目标——没大数字时的特写担当）
  let copy = null;
  let heading = null;
  const h1 = [...root.querySelectorAll("h1")].find(visible);
  if (h1) {
    const container = h1.closest("div, main, section") || h1;
    copy = { path: pathOf(container === root ? h1 : container) };
    const hr = h1.getBoundingClientRect();
    if (hr.width >= 40 && hr.height >= 30) heading = { path: pathOf(h1) };
  }

  return {
    numeric: numeric?.path ?? null,
    list: list?.path ?? null,
    copy: copy?.path ?? null,
    heading: heading?.path ?? null,
  };
}

/** 读章节顺序与每章步数（narrations 为真相源）。
 *  兼容单/双引号与压缩格式——job-25 实测用户模型写 id:'xxx' 紧凑风格，
 *  只认双引号会读出 0 章、编排整体空转。 */
function readStructure(presDir) {
  const chaptersTs = readFileSync(join(presDir, "src/registry/chapters.ts"), "utf8");
  const order = [...chaptersTs.matchAll(/id:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const steps = order.map((id) => {
    const n = readFileSync(join(presDir, "src/chapters", id, "narrations.ts"), "utf8");
    return [...n.matchAll(/(["'])(?:[^"'\\\n]|\\.)*?\1/g)].length;
  });
  return { order, steps };
}

function readExistingCues(presDir) {
  const path = join(presDir, "src/registry/cameraCues.ts");
  if (!existsSync(path)) return {};
  const match = readFileSync(path, "utf8").match(/CAMERA_CUES[^=]*=\s*(\{[\s\S]*?\});/);
  if (!match) return {};
  try { return new Function(`return ${match[1]}`)(); } catch { return {}; }
}

/**
 * 主入口：走查每一步的真实 DOM，产出/补齐镜头声明。
 * @param presDir 演示工程目录
 * @param previewUrl 已构建的静态预览地址
 * @param options { density, avatarEnabled }
 */
export async function choreographCameras(presDir, previewUrl, { density = "dense", avatarEnabled = true } = {}) {
  const { order, steps } = readStructure(presDir);
  const existing = readExistingCues(presDir);
  const cap = DENSITY_CAP[density] ?? 4;
  const floor = DENSITY_TARGET[density] ?? 2;

  const browser = await launchBrowser();
  const signals = []; // [chapterIdx][stepIdx] -> {numeric,list,copy}
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(previewUrl, { waitUntil: "load", timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    for (let ci = 0; ci < order.length; ci++) signals.push(new Array(steps[ci]).fill(null));
    let ci = 0, si = 0;
    const total = steps.reduce((a, b) => a + b, 0);
    for (let g = 0; g < total; g++) {
      await page.waitForTimeout(g === 0 ? 600 : 240); // 等入场动画大致落定
      signals[ci][si] = await page.evaluate(extractSignalsInPage);
      si += 1;
      if (si >= steps[ci]) { ci += 1; si = 0; }
      if (g < total - 1) await page.keyboard.press("ArrowRight");
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // —— 规则编排（与手排同一套） ——
  let magFlip = false;
  const cues = {};
  order.forEach((id, ci) => {
    const stepCount = steps[ci];
    const arr = new Array(stepCount).fill(null);
    const aiArr = existing[id] ?? [];
    // AI 有意声明的先落位（视为设计意图）
    for (let si = 0; si < stepCount; si++) if (aiArr[si]) arr[si] = aiArr[si];

    const strongAt = new Set();
    arr.forEach((c, si) => { if (c && (c.effect === "magnify" || (c.effect === "focus" && (c.zoom ?? 2) >= 2))) strongAt.add(si); });
    const canStrong = (si) => !strongAt.has(si - 1) && !strongAt.has(si + 1);
    let moves = arr.filter((c) => c && ["focus", "pan", "spotlight", "magnify"].includes(c.effect)).length;

    // 数字特写（每章一处，交替 magnify/focus）
    for (let si = 0; si < stepCount && moves < cap; si++) {
      if (arr[si] || !signals[ci][si]?.numeric || !canStrong(si)) continue;
      if (ci === 0 && si === 0 && avatarEnabled) continue; // 留给 host-full
      magFlip = !magFlip;
      arr[si] = magFlip
        ? { effect: "magnify", target: signals[ci][si].numeric, zoom: 2.8 }
        : { effect: "focus", target: signals[ci][si].numeric, zoom: 2.2 };
      strongAt.add(si); moves += 1;
      break;
    }
    // 列表聚光（每章一处）
    for (let si = 0; si < stepCount && moves < cap; si++) {
      if (arr[si] || !signals[ci][si]?.list) continue;
      arr[si] = { effect: "spotlight", target: signals[ci][si].list };
      moves += 1;
      break;
    }
    // 每章保底一个强特写（2026-07-18）：本章还没有 magnify/focus/spotlight
    // 且不是纯 host 开场章时，focus 主标题 2.0×——根治"全是软 pan 没 punch"
    //（job-26 实测：无大数字的章全退化成 1.25 轻推，观感平）。
    const hasStrong = () => arr.some((c) => c && (c.effect === "magnify" || c.effect === "focus" || c.effect === "spotlight"));
    const hasOpeningHost = arr.some((c) => c && (c.effect === "host-full" || c.effect === "host-split"));
    if (!hasStrong() && !hasOpeningHost && moves < cap) {
      for (let si = 0; si < stepCount; si++) {
        if (arr[si] || !signals[ci][si]?.heading || !canStrong(si)) continue;
        if (ci === 0 && si === 0 && avatarEnabled) continue;
        arr[si] = { effect: "focus", target: signals[ci][si].heading, zoom: 2.0 };
        strongAt.add(si); moves += 1;
        break;
      }
    }
    // 呼吸 pan 补到下限
    for (let si = 1; si < stepCount - 1 && moves < Math.max(floor, 2) && moves < cap; si++) {
      if (arr[si] || !signals[ci][si]?.copy || !canStrong(si)) continue;
      arr[si] = { effect: "pan", target: signals[ci][si].copy, zoom: 1.25 };
      moves += 1;
    }
    cues[id] = arr;
  });

  // 全局打断长平淡游程（2026-07-18）：连续 >6 步无强效果（magnify/focus/
  // spotlight/host*）就在游程中段注入一个 focus，根治"12 步一路平"（job-26）。
  const STRONG_EFF = new Set(["magnify", "focus", "spotlight", "host", "host-full", "host-split"]);
  const flatRef = []; // {ci, si}
  order.forEach((id, ci) => { for (let si = 0; si < steps[ci]; si++) flatRef.push({ ci, si }); });
  let flatRun = 0;
  for (let g = 0; g < flatRef.length; g++) {
    const { ci, si } = flatRef[g];
    const eff = cues[order[ci]][si]?.effect;
    if (eff && STRONG_EFF.has(eff)) { flatRun = 0; continue; }
    flatRun++;
    if (flatRun > 5) {
      const arr = cues[order[ci]];
      const neighborStrong = (arr[si - 1] && STRONG_EFF.has(arr[si - 1].effect)) || (arr[si + 1] && STRONG_EFF.has(arr[si + 1].effect));
      if (!neighborStrong) {
        if (arr[si] && arr[si].effect === "pan" && arr[si].target) {
          // 已有软 pan：直接升级成 focus（零成本，同时消游程+加 punch）
          arr[si] = { effect: "focus", target: arr[si].target, zoom: 2.0 };
          flatRun = 0;
        } else if (!arr[si]) {
          // 空步：按信号注入 focus（heading/copy）
          const sig = signals[ci][si];
          const tgt = sig?.heading || sig?.copy;
          if (tgt) { arr[si] = { effect: "focus", target: tgt, zoom: 2.0 }; flatRun = 0; }
        }
      }
    }
  }

  // 数字人时刻布点（AI 未布时机器兜底）
  if (avatarEnabled && order.length) {
    const hasHostFull = Object.values(cues).some((arr) => arr.some((c) => c?.effect === "host-full" || c?.effect === "host-split"));
    if (!hasHostFull) cues[order[0]][0] = { effect: "host-full" };
    const mid = order[Math.floor(order.length / 2)];
    if (!cues[mid].some((c) => c?.effect === "host")) cues[mid][0] = { effect: "host" };
    const last = order[order.length - 1];
    const lastArr = cues[last];
    if (!lastArr.some((c) => c?.effect === "host")) lastArr[lastArr.length - 1] = { effect: "host" };
  }

  const lines = [];
  lines.push("// AUTO-GENERATED by VideoForge cameraChoreographer — 确定性镜头编排。");
  lines.push("// AI 声明的镜头已保留；机器按 DOM 信号补齐到密度下限。可对话调整。");
  // ⚠️ 该联合必须与模板 registry/cameraCues.ts 完全一致（job-25 实翻车：
  // 漏 host-split → 与 App 比较类型撕裂 → 整个章节质量步失败）
  lines.push('export type CameraEffect="focus"|"pan"|"spotlight"|"magnify"|"overview"|"host"|"host-full"|"host-split";');
  lines.push("export interface CameraCue{effect:CameraEffect;target?:string;zoom?:number;}");
  lines.push(`export const CAMERA_CUES: Record<string,(CameraCue|null)[]> = ${JSON.stringify(cues, null, 1)};`);
  writeFileSync(join(presDir, "src/registry/cameraCues.ts"), lines.join("\n") + "\n");

  const stats = {};
  for (const arr of Object.values(cues)) for (const c of arr) if (c) stats[c.effect] = (stats[c.effect] || 0) + 1;
  return { chapters: order.length, totalSteps: steps.reduce((a, b) => a + b, 0), stats };
}
