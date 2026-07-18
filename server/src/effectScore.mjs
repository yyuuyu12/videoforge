// 镜头效果自动打分器（2026-07-18）：走查一个作品每一步的真实渲染，
// 从"知识类博主观感"角度打分。与产品自带的结构分（inspectPreviewQuality，
// 管溢出/碰撞/字幕/安全区）互补——本器专管"镜头效果好不好"这一维。
//
// 用法：node server/src/effectScore.mjs <jobId> [previewBase]
// 输出：JSON 打分卡（stdout 最后一行是 {score, dimensions, defects}）
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const jobId = process.argv[2];
const base = process.argv[3] || "http://127.0.0.1:5401";
const previewUrl = `${base}/preview/${jobId}/`;
const pres = join(process.cwd(), "workspaces", `job-${jobId}`, "presentation");

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
await page.evaluate(() => document.fonts.ready);
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

console.log(JSON.stringify({
  jobId, score,
  dimensions: { cutCount, offstage, emptyAvatar: emptyAv, subtitleTooLong: subLong, weakZoom, cameraMisses: misses, thinChapters: thinChapters.length, contentMoves, totalSteps: total, chapters: order.length },
  defects,
}));
