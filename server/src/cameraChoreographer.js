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

  // 信号统一携带无变换态矩形（2026-07-22）：编排落 focus 前先算可行倍率，
  // 否则宽目标声明 1.45 会被切字守卫砍到 ~1.1 = effectScore 弱缩放病（job-31 实证）。
  // 坐标系铁律：必须换算到舞台本地像素（÷letterbox 缩放），守卫用的是
  // 1920×1080 舞台坐标——直接用屏幕像素在 720p 走查下会把宽目标算窄一半。
  const camLayer = document.querySelector(".camera-layer");
  const layerScale = camLayer
    ? (camLayer.getBoundingClientRect().width / camLayer.offsetWidth || 1)
    : 1;
  const sig = (el, extra = {}) => {
    const r = el.getBoundingClientRect();
    return { path: pathOf(el), w: Math.round(r.width / layerScale), h: Math.round(r.height / layerScale), ...extra };
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
    if (!numeric || score > numeric.score) numeric = sig(el, { score });
  }

  // 信号二：列表簇（同类子元素 ≥3 的容器）
  let list = null;
  for (const el of root.querySelectorAll("*")) {
    if (!visible(el) || el.children.length < 3) continue;
    const tags = [...el.children].map((c) => c.tagName + "." + c.className);
    if (new Set(tags).size !== 1) continue;
    const r = el.getBoundingClientRect();
    const score = r.width * r.height;
    if (!list || score > list.score) list = sig(el, { score });
  }

  // 信号三：主内容块（h1 的最近块容器，pan 呼吸目标）
  // 信号四：主标题 h1 本身（强 focus 目标——没大数字时的特写担当）
  let copy = null;
  let heading = null;
  const h1 = [...root.querySelectorAll("h1")].find(visible);
  if (h1) {
    const container = h1.closest("div, main, section") || h1;
    copy = sig(container === root ? h1 : container);
    const hr = h1.getBoundingClientRect();
    if (hr.width >= 40 && hr.height >= 30) heading = sig(h1);
  }

  return {
    numeric,
    list,
    copy,
    heading,
    // 章节卡在场（效果 v2b）：章首仪式步——甩切边界的判定信号
    chapterCard: !!root.querySelector(".fx-chaptercard"),
  };
}

/** 读章节顺序与每章步数（narrations 为真相源）。
 *  这是"解析 AI 代码不能猜形状"教训的集中地，已实证四种合法写法：
 *  ①id:"xxx" 双引号 ②id:'xxx' 单引号/压缩（job-25）③扁平文件布局（job-29）
 *  ④id 从章节模块 re-export，registry 里没有 id 字面量（job-32:
 *    `import C3,{id as i3} from "../chapters/03-coldstart"`，且模块导出的
 *    id="coldstart" ≠ 目录名"03-coldstart"）。
 *  策略：registry 字面量优先；否则按 import 路径顺序逐个读模块自己的
 *  `export const id`。读不出章节时调用方必须大声失败，绝不允许 0 章空转。 */
export function readChapterStructure(presDir) {
  const chaptersTs = readFileSync(join(presDir, "src/registry/chapters.ts"), "utf8");
  const chaptersDir = join(presDir, "src/chapters");
  // 形状①②：数组字面量里的 id 字段（此时 id 即目录/文件名约定）
  let entries = [...chaptersTs.matchAll(/id:\s*["']([^"']+)["']/g)].map((m) => ({ id: m[1], dir: m[1] }));
  // 形状④：registry 无 id 字面量 → 按 import 路径顺序读模块导出的 id
  if (!entries.length) {
    const dirs = [...chaptersTs.matchAll(/from\s*["']\.{1,2}\/chapters\/([^"']+)["']/g)]
      .map((m) => m[1].replace(/\/(index)?(\.tsx?)?$/, "").split("/")[0]);
    entries = dirs.map((dir) => {
      let id = dir;
      const moduleFiles = [
        join(chaptersDir, dir, "index.tsx"),
        join(chaptersDir, dir, "index.ts"),
        join(chaptersDir, `${dir}.tsx`),
      ];
      for (const f of moduleFiles) {
        if (!existsSync(f)) continue;
        const m = readFileSync(f, "utf8").match(/export\s+const\s+id\s*=\s*["']([^"']+)["']/);
        if (m) { id = m[1]; break; }
      }
      return { id, dir };
    });
  }
  const steps = entries.map(({ dir }) => {
    // 兼容子目录(<dir>/narrations.ts)与扁平文件(<dir>.narrations.ts)布局
    const candidates = [join(chaptersDir, dir, "narrations.ts"), join(chaptersDir, `${dir}.narrations.ts`)];
    const f = candidates.find((p) => existsSync(p));
    if (!f) return 0;
    const n = readFileSync(f, "utf8");
    return [...n.matchAll(/(["'])(?:[^"'\\\n]|\\.)*?\1/g)].length;
  });
  return { order: entries.map((e) => e.id), dirs: entries.map((e) => e.dir), steps };
}

function readStructure(presDir) {
  return readChapterStructure(presDir);
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
  // 0 章 = 结构读取失败，必须大声失败（job-32 实证：静默空转 → 全片零镜头，
  // 只有 effectScore 记账里能看出来）。新形状出现时这里的报错就是修复线索。
  if (!order.length || steps.every((n) => n === 0)) {
    throw new Error("章节结构读取失败（registry/chapters.ts 形状不识别或 narrations 缺失）——拒绝 0 章空转，需检查 readChapterStructure 的形状兼容");
  }
  // AI 意图快照（2026-07-22 根治重排破坏性幂等）：编排器输出会覆写 registry，
  // 直接回读会把自己上一轮的机器 cue 当"AI 声明"逐轮固化（job-31 实证：
  // 降级后的 spotlight 再也升不回 focus）。首轮把纯 AI 声明存快照，后续
  // 各轮一律以快照为意图真相源，重排从此幂等可重入。
  const aiSnapshotPath = join(presDir, "src", "registry", "cameraCues.ai.json");
  let existing;
  if (existsSync(aiSnapshotPath)) {
    existing = JSON.parse(readFileSync(aiSnapshotPath, "utf8"));
  } else {
    existing = readExistingCues(presDir);
    writeFileSync(aiSnapshotPath, `${JSON.stringify(existing, null, 1)}\n`);
  }
  const cap = DENSITY_CAP[density] ?? 4;
  const floor = DENSITY_TARGET[density] ?? 2;

  const VIEW_W = 1280;
  const VIEW_H = 720; // 走查视口（信号矩形的坐标系，可行倍率按它换算）
  const browser = await launchBrowser();
  const signals = []; // [chapterIdx][stepIdx] -> {numeric,list,copy}
  const aiTargetRects = []; // [ci][si] -> {w,h}｜AI 声明 focus 目标的实测矩形
  try {
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } });
    await page.goto(previewUrl, { waitUntil: "load", timeout: 60000 });
    // 素颜态测量（2026-07-22，与审计同源纪律）：重排时页面带着上一轮镜头
    // 在实时变换，信号/目标矩形会被放大态污染 → 可行倍率全算歪。中和之。
    await page.addStyleTag({ content: ".camera-layer,.camera-punch,.camera-breath{transform:none!important;animation:none!important;transition:none!important}" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    for (let ci = 0; ci < order.length; ci++) {
      signals.push(new Array(steps[ci]).fill(null));
      aiTargetRects.push(new Array(steps[ci]).fill(null));
    }
    let ci = 0, si = 0;
    const total = steps.reduce((a, b) => a + b, 0);
    for (let g = 0; g < total; g++) {
      await page.waitForTimeout(g === 0 ? 600 : 240);
      // 入场动画结算到终态再测量（与审计同源：中间态矩形不可信）
      await page.evaluate(() => {
        document.getAnimations?.().forEach((animation) => {
          try { animation.finish(); } catch { animation.cancel(); }
        });
      });
      signals[ci][si] = await page.evaluate(extractSignalsInPage);
      // AI 声明的 focus 目标同样量矩形——意图保留但机制受可行倍率约束
      const aiCue = existing[order[ci]]?.[si];
      if ((aiCue?.effect === "focus" || aiCue?.effect === "magnify") && aiCue.target) {
        aiTargetRects[ci][si] = await page.evaluate((sel) => {
          let el = null;
          try { el = document.querySelector(sel); } catch {}
          if (!el) return null;
          // 舞台本地坐标（与守卫同坐标系），不是屏幕像素
          const layer = document.querySelector(".camera-layer");
          const s0 = layer ? (layer.getBoundingClientRect().width / layer.offsetWidth || 1) : 1;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { w: Math.round(r.width / s0), h: Math.round(r.height / s0) } : null;
        }, aiCue.target);
      }
      si += 1;
      if (si >= steps[ci]) { ci += 1; si = 0; }
      if (g < total - 1) await page.keyboard.press("ArrowRight");
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (process.env.VF_CHOREO_DEBUG) {
    writeFileSync(process.env.VF_CHOREO_DEBUG, JSON.stringify({ order, steps, signals, aiTargetRects, existing }, null, 1));
  }

  // —— 规则编排（与手排同一套） ——
  // 可行倍率预检（2026-07-22）：目标推近后须整体留在取景安全区内（与
  // CameraLayer 切字守卫同源约束）。focus 推不到词表下限 1.4 就改 spotlight
  // ——同为强效果但零缩放，不产生"声明 1.45 实际 1.1"的弱缩放账。
  // 与 CameraLayer 守卫同源公式（舞台 1920×1080 坐标 + MARGIN 12×2），
  // 再打 0.95 位置折扣（守卫还有贴边降档，预检位置盲）
  const feasibleZoom = (s) => (s?.w > 0 && s?.h > 0
    ? Math.min(1920 / (s.w + 24), 1080 / (s.h + 24)) * 0.95
    : Infinity);
  const focusOr = (s, wantZoom) => {
    const fz = Math.min(wantZoom, feasibleZoom(s));
    return fz >= 1.4
      ? { effect: "focus", target: s.path, zoom: Math.round(fz * 100) / 100 }
      : { effect: "spotlight", target: s.path };
  };
  // 宽目标的博主式替代：容器推不动就推它里面的窄主角（数字 > 标题），
  // 全宽也没有窄主角才退聚光——保住真实的 zoom punch，不让画面全是压暗。
  const narrowAlternative = (ci, si) => {
    const s = signals[ci]?.[si];
    for (const cand of [s?.numeric, s?.heading]) {
      if (cand && feasibleZoom(cand) >= 1.4) return cand;
    }
    return null;
  };
  let magFlip = false;
  const cues = {};
  order.forEach((id, ci) => {
    const stepCount = steps[ci];
    const arr = new Array(stepCount).fill(null);
    const aiArr = existing[id] ?? [];
    // AI 有意声明的先落位（视为设计意图）。focus 的强调意图保留，但机制过
    // 可行倍率预检：宽目标推不到 1.4 转 spotlight（否则守卫砍成弱缩放）
    for (let si = 0; si < stepCount; si++) {
      const c = aiArr[si];
      if (!c) continue;
      const rect = aiTargetRects[ci]?.[si];
      if (c.effect === "focus" && c.target && rect) {
        const fz = Math.min(c.zoom ?? 2, feasibleZoom(rect));
        if (fz >= 1.4) {
          arr[si] = { ...c, zoom: Math.round(fz * 100) / 100 };
        } else {
          // 容器太宽推不动：换推里面的窄主角（数字/标题），保住 punch
          const alt = narrowAlternative(ci, si);
          arr[si] = alt
            ? { ...focusOr(alt, c.zoom ?? 2), ...(c.enter ? { enter: c.enter } : {}) }
            : { effect: "spotlight", target: c.target, ...(c.enter ? { enter: c.enter } : {}) };
        }
      } else if (c.effect === "magnify" && c.target && rect && Math.min(c.zoom ?? 2.8, feasibleZoom(rect)) < 2.0) {
        // magnify 推不到 2.0 就失去"放大镜"意义（守卫会砍成 1.1 级弱缩放）：
        // 换窄主角 focus 或退聚光，同样是意图保留、机制受约束
        const alt = narrowAlternative(ci, si);
        arr[si] = alt
          ? { ...focusOr(alt, 2.2), ...(c.enter ? { enter: c.enter } : {}) }
          : { effect: "spotlight", target: c.target, ...(c.enter ? { enter: c.enter } : {}) };
      } else {
        arr[si] = c;
      }
    }

    const strongAt = new Set();
    arr.forEach((c, si) => { if (c && (c.effect === "magnify" || (c.effect === "focus" && (c.zoom ?? 2) >= 2))) strongAt.add(si); });
    const canStrong = (si) => !strongAt.has(si - 1) && !strongAt.has(si + 1);
    let moves = arr.filter((c) => c && ["focus", "pan", "spotlight", "magnify"].includes(c.effect)).length;

    // 数字特写（每章一处，交替 magnify/focus）
    for (let si = 0; si < stepCount && moves < cap; si++) {
      if (arr[si] || !signals[ci][si]?.numeric || !canStrong(si)) continue;
      if (ci === 0 && si === 0 && avatarEnabled) continue; // 留给 host-full
      magFlip = !magFlip;
      // magnify 是强推近+镜片圈，推不到 2.0 就没有"放大镜"意义——目标太宽时走 focus/spotlight 路线
      arr[si] = magFlip && feasibleZoom(signals[ci][si].numeric) >= 2.0
        ? { effect: "magnify", target: signals[ci][si].numeric.path, zoom: 2.8 }
        : focusOr(signals[ci][si].numeric, 2.2);
      strongAt.add(si); moves += 1;
      break;
    }
    // 列表聚光（每章一处）
    for (let si = 0; si < stepCount && moves < cap; si++) {
      if (arr[si] || !signals[ci][si]?.list) continue;
      arr[si] = { effect: "spotlight", target: signals[ci][si].list.path };
      moves += 1;
      break;
    }
    // 每章保底一个强特写（2026-07-18；2026-07-22 收紧）：保底只认真 zoom
    // punch（magnify/focus）——spotlight 是压暗不是推近，算进保底会让整章
    // 只剩聚光没有镜头运动（job-31 实证 35 spotlight/1 focus 观感全平）。
    const hasStrong = () => arr.some((c) => c && (c.effect === "magnify" || c.effect === "focus"));
    const hasOpeningHost = arr.some((c) => c && (c.effect === "host-full" || c.effect === "host-split"));
    if (!hasStrong() && !hasOpeningHost) {
      let placed = false;
      if (moves < cap) {
        for (let si = 0; si < stepCount; si++) {
          if (arr[si] || !canStrong(si)) continue;
          if (ci === 0 && si === 0 && avatarEnabled) continue;
          const tgt = narrowAlternative(ci, si) || signals[ci][si]?.heading;
          if (!tgt) continue;
          const cue = focusOr(tgt, 2.0);
          if (cue.effect !== "focus") continue; // 保底必须是真 zoom punch
          arr[si] = cue; strongAt.add(si); moves += 1; placed = true;
          break;
        }
      }
      if (!placed) {
        // 预算已满或没有可推的空步：把一个已有 spotlight 原地升级成窄目标
        // focus——不加预算、同强度档位，只是把"压暗"换成"推近"
        for (let si = 0; si < stepCount; si++) {
          if (!arr[si] || arr[si].effect !== "spotlight" || !canStrong(si)) continue;
          const alt = narrowAlternative(ci, si);
          if (!alt) continue;
          const cue = focusOr(alt, 2.0);
          if (cue.effect !== "focus") continue;
          arr[si] = { ...cue, ...(arr[si].enter ? { enter: arr[si].enter } : {}) };
          strongAt.add(si);
          break;
        }
      }
    }
    // 呼吸 pan 补到下限
    for (let si = 1; si < stepCount - 1 && moves < Math.max(floor, 2) && moves < cap; si++) {
      if (arr[si] || !signals[ci][si]?.copy || !canStrong(si)) continue;
      arr[si] = { effect: "pan", target: signals[ci][si].copy.path, zoom: 1.25 };
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
          // 已有软 pan：升级成强效果消游程。pan 目标多为宽内容块，先按信号
          // 矩形做可行倍率预检，推不动就 spotlight（同为强效果零弱缩放账）
          const alt = narrowAlternative(ci, si);
          const sigMatch = [signals[ci][si]?.heading, signals[ci][si]?.copy, signals[ci][si]?.numeric]
            .find((s) => s?.path === arr[si].target);
          arr[si] = alt
            ? focusOr(alt, 2.0)
            : sigMatch
              ? focusOr(sigMatch, 2.0)
              : { effect: "spotlight", target: arr[si].target };
          flatRun = 0;
        } else if (!arr[si]) {
          // 空步：按信号注入强效果（窄主角优先，带可行倍率预检）
          const sig = signals[ci][si];
          const tgt = narrowAlternative(ci, si) || sig?.heading || sig?.copy;
          if (tgt) { arr[si] = focusOr(tgt, 2.0); flatRun = 0; }
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

  // 甩切布点（效果 v2b，竞品实证：甩切只出现在"人↔素材"情绪升档边界）：
  // 非首章的章首步，若是数字人时刻或章节卡仪式步，就是最强的边界——
  // 补一个 enter:"whip"（AI 已声明的保留；每章 ≤1 由 cameraCheck 强制）。
  const OPENING_HOST = new Set(["host", "host-full", "host-split"]);
  order.forEach((id, ci) => {
    if (ci === 0) return; // 全片第一步之前没有素材，无边界可甩
    const arr = cues[id];
    if (arr.some((c) => c?.enter === "whip")) return; // AI 有意声明的优先
    const first = arr[0];
    const isRitualOpen = (first && OPENING_HOST.has(first.effect)) || signals[ci][0]?.chapterCard;
    if (!isRitualOpen) return;
    if (first) first.enter = "whip";
    else arr[0] = { effect: "overview", enter: "whip" };
  });

  const lines = [];
  lines.push("// AUTO-GENERATED by VideoForge cameraChoreographer — 确定性镜头编排。");
  lines.push("// AI 声明的镜头已保留；机器按 DOM 信号补齐到密度下限。可对话调整。");
  // ⚠️ 该联合必须与模板 registry/cameraCues.ts 完全一致（job-25 实翻车：
  // 漏 host-split → 与 App 比较类型撕裂 → 整个章节质量步失败）
  lines.push('export type CameraEffect="focus"|"pan"|"spotlight"|"magnify"|"overview"|"host"|"host-full"|"host-split";');
  lines.push('export type CameraEnter="whip";');
  lines.push("export interface CameraCue{effect:CameraEffect;target?:string;zoom?:number;enter?:CameraEnter;}");
  lines.push(`export const CAMERA_CUES: Record<string,(CameraCue|null)[]> = ${JSON.stringify(cues, null, 1)};`);
  writeFileSync(join(presDir, "src/registry/cameraCues.ts"), lines.join("\n") + "\n");

  const stats = {};
  for (const arr of Object.values(cues)) for (const c of arr) if (c) stats[c.effect] = (stats[c.effect] || 0) + 1;
  return { chapters: order.length, totalSteps: steps.reduce((a, b) => a + b, 0), stats };
}
