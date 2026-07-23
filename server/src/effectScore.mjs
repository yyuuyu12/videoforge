// 镜头效果自动打分器（2026-07-18）：走查一个作品每一步的真实渲染，
// 从"知识类博主观感"角度打分。与产品自带的结构分（inspectPreviewQuality，
// 管溢出/碰撞/字幕/安全区）互补——本器专管"镜头效果好不好"这一维。
//
// 用法：node server/src/effectScore.mjs <jobId> [previewBase]
// 输出：JSON 打分卡（stdout 最后一行是 {score, dimensions, defects}）
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const jobId = process.argv[2];
const base = process.argv[3] || "http://127.0.0.1:5401";
const previewUrl = `${base}/preview/${jobId}/`;
// 路径走 dataRoot 解析（B2 定稿）——不依赖 cwd 恰好是仓库根
const pres = join(config.workspacesRoot, `job-${jobId}`, "presentation");

function readStructure() {
  const src = readFileSync(join(pres, "src/registry/chapters.ts"), "utf8");
  const order = [...src.matchAll(/id:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const steps = order.map((id) => [
    ...readFileSync(join(pres, "src/chapters", id, "narrations.ts"), "utf8")
      .matchAll(/(["'])(?:[^"'\\\n]|\\.)*?\1/g),
  ].length);
  return { order, steps };
}
function readCues() {
  try {
    const m = readFileSync(join(pres, "src/registry/cameraCues.ts"), "utf8")
      .match(/CAMERA_CUES[^=]*=\s*(\{[\s\S]*?\});/);
    return m ? new Function(`return ${m[1]}`)() : {};
  } catch { return {}; }
}

const { order, steps } = readStructure();
const cues = readCues();
const total = steps.reduce((a, b) => a + b, 0);
const flat = [];
for (const id of order) for (let s = 0; s < steps[order.indexOf(id)]; s++) flat.push({ id, cue: (cues[id] || [])[s] || null });

const browser = await (async () => {
  for (const ch of ["chrome", "msedge"]) { try { return await chromium.launch({ channel: ch }); } catch {} }
  throw new Error("no browser");
})();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(previewUrl, { waitUntil: "load", timeout: 60000 });
await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]));
await page.waitForTimeout(700);

const perStep = [];
for (let g = 0; g < total; g++) {
  await page.waitForTimeout(1250); // 等测量(550)+过渡(900) 落定
  const cue = flat[g].cue;
  const m = await page.evaluate((sel) => {
    const layer = document.querySelector(".camera-layer");
    const vp = document.querySelector(".camera-viewport");
    const out = { zoomReal: 1, targetVisible: true, emptyAvatar: false, subtitleLen: 0, offstage: 0 };
    // 缩放真实倍率 + 目标完整可见
    if (sel && layer) {
      const target = layer.querySelector(sel);
      if (target) {
        const withT = target.getBoundingClientRect();
        const prev = layer.style.transform, pt = layer.style.transition;
        layer.style.transition = "none"; layer.style.transform = "none"; void layer.offsetWidth;
        const noT = target.getBoundingClientRect();
        layer.style.transform = prev; layer.style.transition = pt;
        if (noT.width > 0) out.zoomReal = withT.width / noT.width;
        const vpr = vp.getBoundingClientRect();
        out.targetVisible = withT.left >= vpr.left - 4 && withT.right <= vpr.right + 4 && withT.top >= vpr.top - 4 && withT.bottom <= vpr.bottom + 4;
      } else {
        out.targetMissing = true;
      }
    }
    // 内容效果件（博主标志：数字滚动/关键词点亮/圈注/金句卡/媒体容器）本步出现数
    out.fx = {
      counter: document.querySelectorAll(".fx-counter, .fx-slam").length,
      wordmark: document.querySelectorAll(".fx-wordmark").length,
      annotate: document.querySelectorAll(".fx-annotate, .fx-shine").length,
      card: document.querySelectorAll(".fx-quotecard, .fx-chaptercard").length,
      media: document.querySelectorAll(".fx-mediaframe").length,
    };
    // 空数字人窗（显示了但视频没画面）
    const av = document.querySelector(".avatar-presenter");
    if (av && Number(getComputedStyle(av).opacity) > 0.1) {
      const v = av.querySelector("video");
      if (!v || v.readyState < 2) out.emptyAvatar = true;
    }
    // 字幕长度
    const sub = document.querySelector(".subtitle__cue");
    if (sub) out.subtitleLen = [...(sub.textContent || "")].length;
    // 越界元素（可见文字块超出视口）
    const vpr2 = (vp || document.body).getBoundingClientRect();
    for (const n of (layer ? layer.querySelectorAll("*") : [])) {
      if (n.children.length > 0) continue;
      const t = (n.textContent || "").trim();
      if (t.length < 2) continue;
      const cs = getComputedStyle(n);
      if (parseFloat(cs.fontSize) < 16 || cs.visibility === "hidden" || Number(cs.opacity) < 0.1) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 8) continue;
      if (r.right < vpr2.left - 2 || r.left > vpr2.right + 2 || r.bottom < vpr2.top - 2 || r.top > vpr2.bottom + 2) continue; // 完全在外=推近排除，正常
      if (r.left < vpr2.left - 8 && r.right > vpr2.left + 8) out.offstage++; // 被左边缘切
      else if (r.right > vpr2.right + 8 && r.left < vpr2.right - 8) out.offstage++; // 被右边缘切
    }
    return out;
  }, cue && (cue.effect === "focus" || cue.effect === "magnify" || cue.effect === "pan") ? cue.target : null);
  perStep.push({ g, chapter: flat[g].id, effect: cue?.effect || "-", ...m });
  if (g < total - 1) await page.keyboard.press("ArrowRight");
}
const misses = await page.evaluate(() => (window.__vfCameraMisses || []).length);
await browser.close();

// ---- 评分 ----
const defects = [];
let cutCount = 0, emptyAv = 0, subLong = 0, offstage = 0, weakZoom = 0;
for (const s of perStep) {
  if ((s.effect === "focus" || s.effect === "magnify") && !s.targetVisible) { cutCount++; defects.push(`step${s.g}(${s.chapter}) ${s.effect} 目标被切`); }
  if ((s.effect === "focus" || s.effect === "magnify") && s.zoomReal < 1.3) { weakZoom++; defects.push(`step${s.g}(${s.chapter}) ${s.effect} 实际倍率仅 ${s.zoomReal.toFixed(2)}`); }
  if (s.emptyAvatar) { emptyAv++; }
  if (s.subtitleLen > 10) { subLong++; defects.push(`step${s.g} 字幕 ${s.subtitleLen} 字超限`); }
  if (s.offstage > 0) { offstage += s.offstage; defects.push(`step${s.g}(${s.chapter}) ${s.offstage} 处文字被取景框切`); }
}
// 效果密度：每章内容镜头数。含 host-full/host-split 开场时刻的章豁免密度线——
// 其视觉锚点是"人物出场"这个 host 事件本身，不该再硬塞内容推近（若强凑
// 反而挤占开场节奏）。host（章中/章尾讲述者时刻）不豁免。
const chapMoves = {};
const chapHasOpeningHost = {};
for (const s of perStep) {
  if (["focus", "magnify", "spotlight", "pan"].includes(s.effect)) chapMoves[s.chapter] = (chapMoves[s.chapter] || 0) + 1;
  if (s.effect === "host-full" || s.effect === "host-split") chapHasOpeningHost[s.chapter] = true;
}
const thinChapters = order.filter((id) => (chapMoves[id] || 0) < 2 && !chapHasOpeningHost[id]);
const contentMoves = Object.values(chapMoves).reduce((a, b) => a + b, 0);

// 扣分制（满分 100）
let score = 100;
score -= cutCount * 12;       // 切字最严重
score -= offstage * 8;
score -= emptyAv * 10;
score -= subLong * 6;
score -= weakZoom * 5;
score -= misses * 6;
score -= thinChapters.length * 4; // 效果太稀
score = Math.max(0, score);

if (thinChapters.length) defects.push(`${thinChapters.length} 章镜头密度<2：${thinChapters.join(",")}`);
if (misses) defects.push(`镜头未命中 ${misses} 次`);

// ---- 高阶表现力维度（2026-07-18：从"不出错"→"够博主水准"）----
// 强效果 = magnify/focus/spotlight/host*（真正抓眼球的），pan/none 算平淡。
const STRONG = new Set(["magnify", "focus", "spotlight", "host", "host-full", "host-split"]);
const effSeq = perStep.map((s) => s.effect);
const strongCount = effSeq.filter((e) => STRONG.has(e)).length;
const strongRatio = total ? strongCount / total : 0;
// 全片强推近（magnify/focus）数——博主片的"暴力特写"担当，太少则平
const punchCount = effSeq.filter((e) => e === "magnify" || e === "focus").length;
// 最长平淡游程（连续无强效果的步数）
let run = 0, maxFlatRun = 0;
for (const e of effSeq) { if (STRONG.has(e)) run = 0; else { run++; maxFlatRun = Math.max(maxFlatRun, run); } }

// 表现力扣分
if (strongRatio < 0.28) { const pen = Math.round((0.28 - strongRatio) * 60); score -= pen; defects.push(`强效果占比仅 ${(strongRatio * 100).toFixed(0)}%（<28%，画面偏平，扣${pen}）`); }
if (punchCount < Math.max(2, Math.ceil(order.length * 0.4))) { const need = Math.max(2, Math.ceil(order.length * 0.4)); const pen = (need - punchCount) * 5; score -= pen; defects.push(`强推近(magnify/focus)仅 ${punchCount} 个（应≥${need}，缺博主式特写，扣${pen}）`); }
if (maxFlatRun > 6) { const pen = (maxFlatRun - 6) * 3; score -= pen; defects.push(`最长平淡游程 ${maxFlatRun} 步（>6 连续无强效果，观感平淡，扣${pen}）`); }
// 效果多样性（博主不会全程一种效果）：内容镜头里若单一类型 >65% 判单调
const moveEffs = effSeq.filter((e) => ["focus", "magnify", "spotlight", "pan"].includes(e));
if (moveEffs.length >= 6) {
  const vc = {};
  for (const e of moveEffs) vc[e] = (vc[e] || 0) + 1;
  const topShare = Math.max(...Object.values(vc)) / moveEffs.length;
  if (topShare > 0.65) { const pen = Math.round((topShare - 0.65) * 40); score -= pen; defects.push(`镜头单一化：${(topShare * 100).toFixed(0)}% 同一种（>65% 显单调，扣${pen}）`); }
}

// 内容效果件密度（博主感核心）：数字滚动/关键词点亮/圈注是知识博主的
// 标志语言，全靠模型主动用，时多时少（job-26 每章 0.6 个 vs job-27 每章 5 个）。
// 按全片峰值出现数估采用度（同一效果件跨步重复出现只算其最大同屏数）。
const fxPeak = { counter: 0, wordmark: 0, annotate: 0, card: 0, media: 0 };
for (const s of perStep) if (s.fx) for (const k of Object.keys(fxPeak)) fxPeak[k] = Math.max(fxPeak[k], s.fx[k] || 0);
const fxUsers = perStep.filter((s) => s.fx && (s.fx.counter + s.fx.wordmark + s.fx.annotate + s.fx.card + (s.fx.media || 0)) > 0).length;
const fxDensity = total ? fxUsers / total : 0; // 有内容效果的步占比
if (fxDensity < 0.25) {
  const pen = Math.round((0.25 - fxDensity) * 40);
  score -= pen;
  defects.push(`内容效果件密度仅 ${(fxDensity * 100).toFixed(0)}%（数字滚动/关键词点亮/圈注偏少，缺博主质感，扣${pen}）`);
}
score = Math.max(0, score);

// 甩切采用数（效果 v2b）：竞品边界节奏的观测维度，暂不参与扣分
const whipCount = flat.filter((s) => s.cue?.enter === "whip").length;

console.log(JSON.stringify({
  jobId, score,
  dimensions: { cutCount, offstage, emptyAvatar: emptyAv, subtitleTooLong: subLong, weakZoom, cameraMisses: misses, thinChapters: thinChapters.length, contentMoves, totalSteps: total, chapters: order.length, strongRatio: Number(strongRatio.toFixed(2)), punchCount, maxFlatRun, fxDensity: Number(fxDensity.toFixed(2)), fxPeak, whipCount },
  defects,
}));
