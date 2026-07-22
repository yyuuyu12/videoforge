import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { chromium } from "playwright-core";
import { logEvent } from "./db.js";
import { preparePreview } from "./preview.js";

/**
 * 服务端一键成片：无头 Chromium 以 ?auto=1 真实播放整片，
 *  - CDP screencast 按真实时间戳采帧（变长帧，静止画面不浪费）
 *  - 页面内拦截每段配音的 `playing` 事件拿到精确开始时刻
 *  - ffmpeg：帧序列 → 30fps H.264；每段 mp3 按 adelay 精确摆放后混音
 * 帧时间戳（CDP epoch 秒）与音频事件（页面 Date.now()）同源同机，对齐误差在毫秒级。
 */

function progress(jobId, pct, message) {
  logEvent(jobId, "render", `progress|${Math.max(0, Math.min(100, Math.round(pct)))}|${message}`);
}

/** shell:false 版执行器——filter_complex 里的 | ; , 不需要任何转义。 */
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let out = "";
    const cap = (s) => (s.length > 20000 ? s.slice(-20000) : s);
    child.stdout.on("data", (d) => (out = cap(out + d)));
    child.stderr.on("data", (d) => (out = cap(out + d)));
    child.on("error", (error) => resolve({ ok: false, output: `${out}\n${error.message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, output: out }));
  });
}

function mediaDuration(path) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { shell: false });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.on("close", (code) => (code === 0 ? resolve(Number(output.trim())) : reject(new Error(`ffprobe failed: ${path}`))));
  });
}

function walkMp3(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    return entry.isDirectory() ? walkMp3(p) : entry.name.endsWith(".mp3") ? [p] : [];
  });
}

async function inspectVisualQuality(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0" && !el.closest("[data-no-advance]");
    };
    const boxes = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((el) => el.children.length === 0 || /subtitle|caption|title|headline|text/i.test(el.className || ""))
      .map((el) => ({
        el,
        tag: el.tagName,
        cls: String(el.className || ""),
        text: (el.textContent || "").trim().slice(0, 80),
        r: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
        // 退后层识别（幽灵底文/装饰字）：低有效不透明度（≤3 层祖先连乘）
        // 或前景色对背景对比度 <3:1（WCAG 大字下限以下 = 装饰级，主题无关）
        deemphasized: (() => {
          let o = Number.parseFloat(getComputedStyle(el).opacity) || 1;
          let node = el.parentElement;
          for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
            o *= Number.parseFloat(getComputedStyle(node).opacity) || 1;
          }
          if (o <= 0.55) return true;
          const parse = (c) => {
            const m = String(c).match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const [r, g, b, a = 1] = m[1].split(",").map(Number);
            return { r, g, b, a };
          };
          const lum = ({ r, g, b }) => {
            const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const fg = parse(getComputedStyle(el).color);
          if (!fg) return false;
          let bgNode = el;
          let bg = null;
          while (bgNode && bgNode !== document.documentElement) {
            const c = parse(getComputedStyle(bgNode).backgroundColor);
            if (c && c.a > 0.01) { bg = c; break; }
            bgNode = bgNode.parentElement;
          }
          if (!bg) return false;
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
          return (hi + 0.05) / (lo + 0.05) < 3;
        })(),
      }));
    const overlap = (a, b) => {
      const x = Math.max(0, Math.min(a.r.x + a.r.w, b.r.x + b.r.w) - Math.max(a.r.x, b.r.x));
      const y = Math.max(0, Math.min(a.r.y + a.r.h, b.r.y + b.r.h) - Math.max(a.r.y, b.r.y));
      return x * y;
    };
    let collisions = 0;
    const collisionPairs = []; // 修复回喂的靶子：谁压了谁（截图之外的机器可读证据）
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      // Parent containers and their text descendants occupy the same pixels by
      // design; counting those pairs makes otherwise valid slides fail audit.
      if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue;
      // Lines, chart nodes and decorative blocks intentionally intersect in
      // diagrams. Only treat an intersection as a readability collision when
      // both sides contain visible text; structural overflow is audited below.
      if (!boxes[i].text || !boxes[j].text) continue;
      // 幽灵底文豁免（2026-07-22 校准）："其余信息主动退后"式的退后层与
      // 主体重叠是设计语言（如 rh-ghost×大数字），不伤可读性。
      if (boxes[i].deemphasized || boxes[j].deemphasized) continue;
      const area = overlap(boxes[i], boxes[j]);
      if (area > 80 && area / Math.min(boxes[i].r.w * boxes[i].r.h, boxes[j].r.w * boxes[j].r.h) > 0.15) {
        collisions += 1;
        if (collisionPairs.length < 5) {
          const label = (b) => `${b.tag}${b.cls ? `.${b.cls.split(/\s+/)[0]}` : ""}«${b.text.slice(0, 14)}»`;
          collisionPairs.push({ a: label(boxes[i]), b: label(boxes[j]), area: Math.round(area) });
        }
      }
    }
    const subtitle = boxes.filter((b) => /subtitle|caption/i.test(b.cls));
    const subtitleSafe = subtitle.every((b) => b.r.y >= 0 && b.r.y + b.r.h <= innerHeight - 20);
    const subtitleEl = document.querySelector(".subtitle");
    const subtitleText = (subtitleEl?.textContent || "").replace(/\s+/g, "").trim();
    const subtitleStyle = subtitleEl ? getComputedStyle(subtitleEl) : null;
    const subtitleRect = subtitleEl?.getBoundingClientRect();
    const subtitleLineHeight = subtitleStyle ? Number.parseFloat(subtitleStyle.lineHeight) : 0;
    const subtitleLines = subtitleRect && subtitleLineHeight > 0 ? Math.ceil(subtitleRect.height / subtitleLineHeight) : 0;
    const subtitleTooLong = subtitleText.length > 10;
    const subtitleMultiline = subtitleLines > 1;
    const contentLeaves = boxes.filter((b) => b.text && !/subtitle|caption/i.test(b.cls));
    const longestContentText = contentLeaves.reduce((max, b) => Math.max(max, b.text.replace(/\s+/g, "").length), 0);
    const longContentBlocks = contentLeaves.filter((b) => b.text.replace(/\s+/g, "").length > 28).length;
    // 文字压图（2026-07-20 补盲区）：文字叶子盖在位图媒体（img/video/canvas）
    // 上 = 不可读。svg 不算媒体（手绘图表的 HTML 标签叠放是设计内）；
    // figcaption（媒体容器角标本来骑在边框上）与数字人窗内媒体豁免。
    const mediaBoxes = [...document.querySelectorAll("img, video, canvas")]
      .filter(visible)
      .filter((el) => !el.closest(".avatar-presenter"))
      // 全出血背景媒体豁免（2026-07-22 校准）：host-full 的模糊填充视频等
      // 占满舞台的背景层不是"内容媒体"——文字压背景是电影式设计不是缺陷
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height < innerWidth * innerHeight * 0.7; })
      .map((el) => { const r = el.getBoundingClientRect(); return { el, r: { x: r.x, y: r.y, w: r.width, h: r.height } }; });
    let textOnMedia = 0;
    for (const b of contentLeaves) {
      if (b.tag === "FIGCAPTION" || b.el.closest("figcaption")) continue;
      for (const m of mediaBoxes) {
        if (m.el.contains(b.el) || b.el.contains(m.el)) continue;
        const area = overlap(b, m);
        if (area > 80 && area / Math.max(1, b.r.w * b.r.h) > 0.5) { textOnMedia += 1; break; }
      }
    }
    // 字撑破容器（补盲区）：文字叶子超出最近的"有形容器"（带背景/边框的
    // 卡片）边界 >6px——即使整体还在视口内也算破版。
    let containerOverflow = 0;
    const containerOverflowDetails = []; // 同 collisionPairs：给修复回喂的机器可读靶子
    for (const b of contentLeaves) {
      // 纯符号装饰（箭头/斜杠等连接件，无字母数字汉字）骑在容器边界上是
      // 图示设计，不是"字撑破容器"（2026-07-22 校准：I«→» 误报）
      if (!/[\p{L}\p{N}]/u.test(b.text)) continue;
      // 自带底板的芯片（叶子自己有背景/边框）骑容器边界是分层图示设计
      // （如轨道环上的节点芯片），本规则只抓"裸文字破版"（job-31 校准）
      const leafStyle = getComputedStyle(b.el);
      if (leafStyle.backgroundColor !== "rgba(0, 0, 0, 0)" || (Number.parseFloat(leafStyle.borderTopWidth) || 0) > 0) continue;
      let node = b.el.parentElement;
      for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
        const cs = getComputedStyle(node);
        const boxed = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || (Number.parseFloat(cs.borderTopWidth) || 0) > 0;
        if (!boxed) continue;
        const cr = node.getBoundingClientRect();
        if (b.r.x < cr.left - 6 || b.r.x + b.r.w > cr.right + 6 || b.r.y < cr.top - 6 || b.r.y + b.r.h > cr.bottom + 6) {
          containerOverflow += 1;
          if (containerOverflowDetails.length < 5) {
            containerOverflowDetails.push({
              leaf: `${b.tag}${b.cls ? `.${b.cls.split(/\s+/)[0]}` : ""}«${b.text.slice(0, 14)}»`,
              container: `${node.tagName}${node.className ? `.${String(node.className).split(/\s+/)[0]}` : ""}`,
            });
          }
        }
        break; // 只对最近的有形容器判定一次
      }
    }
    // 短标签意外换行（补盲区）：≤16 字的标签/数字被 flex 挤成两行 =
    // 布局被压缩的信号（正文长段落的多行是正常的，不在此列）。
    const wrapViolations = contentLeaves.filter((b) => {
      const chars = b.text.replace(/\s+/g, "").length;
      if (chars < 2 || chars > 16) return false;
      const lineHeight = Number.parseFloat(getComputedStyle(b.el).lineHeight);
      return lineHeight > 0 && b.r.h / lineHeight >= 1.9;
    }).length;
    const headingViolations = boxes.filter((b) => {
      if (!b.text || (!/^H[1-3]$/.test(b.tag) && !/headline|hero-title|main-title/i.test(b.cls))) return false;
      const style = getComputedStyle(b.el);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const lines = lineHeight > 0 ? Math.ceil(b.r.h / lineHeight) : 1;
      return lines > 2;
    }).map((b) => ({ text: b.text, lines: Math.ceil(b.r.h / Number.parseFloat(getComputedStyle(b.el).lineHeight)) }));
    const score = Math.max(0, Math.min(100,
      100
      - collisions * 12
      - (subtitleSafe ? 0 : 25)
      - (subtitleTooLong ? 25 : 0)
      - (subtitleMultiline ? 25 : 0)
      - longContentBlocks * 10
      - headingViolations.length * 20
      - textOnMedia * 12
      - containerOverflow * 8
      - wrapViolations * 5
    ));
    return {
      score, collisions, collisionPairs, subtitleSafe, subtitleTextLength: subtitleText.length,
      subtitleLines, subtitleTooLong, subtitleMultiline, longestContentText,
      longContentBlocks, headingViolations, textOnMedia, containerOverflow,
      containerOverflowDetails, wrapViolations, sampledElements: boxes.length,
    };
  });
}

async function readPreviewCursor(page) {
  return page.evaluate(() => {
    const chapters = [...document.querySelectorAll(".pb-chapter")];
    const chapter = chapters.findIndex((node) => node.classList.contains("pb-active"));
    const active = chapter >= 0 ? chapters[chapter] : null;
    const step = active ? active.querySelectorAll(".pb-pip-on").length - 1 : -1;
    const steps = active ? active.querySelectorAll(".pb-pip").length : 0;
    return { chapter, step, chapters: chapters.length, steps };
  });
}

async function inspectCurrentPreviewStep(page) {
  const audit = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 测量前把所有动画结算到终态（2026-07-22）：scene-lift 分层入场/whip 甩切
    // 在 120ms 走查节奏下必然处于半路，元素中间位置互相压住 → 碰撞/容器溢出
    // 全是瞬态误报。审计只对"落定版式"负责；finish 对无限循环动画会抛，退 cancel。
    document.getAnimations?.().forEach((animation) => {
      try { animation.finish(); } catch { animation.cancel(); }
    });
    const offenders = [];
    for (const node of Array.from(document.querySelectorAll("body *"))) {
      if (!(node instanceof HTMLElement) || node.offsetParent === null || node.closest("[data-no-advance]")) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const overflow = r.left < -2 || r.top < -2 || r.right > vw + 2 || r.bottom > vh + 2;
      if (overflow) offenders.push({ selector: node.className ? `.${String(node.className).split(/\\s+/)[0]}` : node.tagName.toLowerCase(), rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) } });
    }
    const subtitle = document.querySelector(".subtitle");
    const sr = subtitle?.getBoundingClientRect();
    const subtitleInFrame = !sr || (sr.left >= -2 && sr.right <= vw + 2 && sr.top >= -2 && sr.bottom <= vh + 2);
    const avatar = document.querySelector(".avatar-presenter");
    const ar = avatar?.getBoundingClientRect();
    const avatarInFrame = !ar || (ar.left >= -2 && ar.right <= vw + 2 && ar.top >= -2 && ar.bottom <= vh + 2);
    const textNodes = Array.from(document.querySelectorAll("h1,h2,h3,p,span,li"));
    const emptyText = textNodes.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && !el.textContent?.trim();
    }).length;
    // 版式几何签名（2026-07-22 job-32 同质化盲区）：只取"有形结构件"——
    // 带背景/边框的卡片记量化位置+尺寸、H1-H3 记量化位置；纯文本不进签名
    // （文字宽度随文案抖动会把视觉相同的模板屏误判为不同，job-32 实测校准）。
    // 与类名无关：共享组件套模板时几何必然相同，换类名照抄布局也逃不掉。
    let layoutSignature = "";
    {
      const scene = document.querySelector(".camera-breath") || document.body;
      const parts = [];
      for (const el of scene.querySelectorAll("*")) {
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const boxed = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || (Number.parseFloat(cs.borderTopWidth) || 0) > 0;
        if (boxed) {
          parts.push(`B:${Math.round(r.x / 64)},${Math.round(r.y / 64)},${Math.round(r.width / 64)},${Math.round(r.height / 64)}`);
        } else if (/^H[1-3]$/.test(el.tagName)) {
          parts.push(`${el.tagName}:${Math.round(r.x / 64)},${Math.round(r.y / 64)}`);
        }
      }
      // 极简屏豁免（job-27 校准：满分作品 90% 屏是"居中大字"，几何天然趋同
      // ——那是风格不是偷懒）：结构件 <3 不构成"模板骨架"，不参与垄断统计。
      const boxedCount = parts.filter((p) => p.startsWith("B:")).length;
      if (boxedCount >= 3) {
        const joined = parts.sort().join("|");
        let hash = 5381;
        for (let i = 0; i < joined.length; i += 1) hash = ((hash * 33) ^ joined.charCodeAt(i)) >>> 0;
        layoutSignature = hash.toString(16);
      }
    }
    return { offenders: offenders.slice(0, 20), overflowCount: offenders.length, subtitleInFrame, avatarInFrame, emptyText, layoutSignature };
  });
  const visual = await inspectVisualQuality(page);
  const structuralPenalty = audit.overflowCount * 8 + (audit.subtitleInFrame ? 0 : 15) + (audit.avatarInFrame ? 0 : 10) + Math.min(5, audit.emptyText) + (visual.subtitleSafe ? 0 : 25);
  const score = Math.max(0, Math.min(visual.score, 100 - structuralPenalty));
  return { score, pass: score >= 90, ...audit, visual };
}

async function launchBrowser() {
  const errors = [];
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({
        channel,
        headless: true,
        args: ["--autoplay-policy=no-user-gesture-required", "--force-device-scale-factor=1", "--hide-scrollbars"],
      });
    } catch (err) {
      errors.push(`${channel}: ${err.message.split("\n")[0]}`);
    }
  }
  throw new Error(`没有可用的 Chrome/Edge 浏览器（${errors.join("; ")}）`);
}

/**
 * Refresh the work-list cover from the current interactive presentation.
 * This is called after late visual stages (especially avatar wiring), so the
 * cover represents what the user can currently preview instead of the early
 * chapter-generation snapshot.
 */
export async function captureJobCover(job, { requireAvatar = false } = {}) {
  const presDir = join(job.workspace, "presentation");
  if (!existsSync(join(presDir, "package.json"))) throw new Error("presentation has not been generated");

  const previewUrl = await preparePreview(job);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(previewUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);

    if (requireAvatar) {
      await page.waitForFunction(() => {
        const video = document.querySelector(".avatar-presenter video");
        return video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth > 0;
      }, null, { timeout: 30000 });
    }

    await page.waitForTimeout(1000);
    const cover = join(presDir, "public", "cover.png");
    mkdirSync(join(presDir, "public"), { recursive: true });
    await page.screenshot({ path: cover, type: "png" });
    logEvent(job.id, "cover", requireAvatar ? "作品封面已更新为数字人合成预览" : "作品封面已按最新预览更新");
    return cover;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Audit the rendered presentation at the canonical export viewport. This is
 * intentionally DOM-based so failures identify the offending element instead
 * of relying on brittle pixel thresholds.
 */
async function inspectPreviewQualityInternal(job, { captureScreenshots }) {
  const presDir = join(job.workspace, "presentation");
  if (!existsSync(join(presDir, "package.json"))) throw new Error("presentation has not been generated");
  const previewUrl = await preparePreview(job);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(`${previewUrl}?chapter=0`, { waitUntil: "networkidle", timeout: 60000 });
    // 结构审计测"素颜版式"（2026-07-22 根治 job-30 假 0 分）：镜头推近/呼吸层
    // 的变换本来就该越出视口，运动质量归 effectScore 管辖；这里中和相机变换后
    // 再测量，否则走查节奏一旦踩中镜头生效窗口，溢出/碰撞全是误报（job-27 得
    // 100 的真相是走查时镜头恰好未生效——本修复把同一口径变成确定性行为）。
    await page.addStyleTag({ content: ".camera-layer,.camera-punch,.camera-breath{transform:none!important;animation:none!important;transition:none!important}" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    const outDir = join(presDir, "public");
    mkdirSync(outDir, { recursive: true });
    const shotsDir = join(outDir, "quality-audit");
    if (captureScreenshots) {
      rmSync(shotsDir, { recursive: true, force: true });
      mkdirSync(shotsDir, { recursive: true });
    }
    const steps = [];
    for (let index = 0; index < 250; index += 1) {
      const cursor = await readPreviewCursor(page);
      if (cursor.chapter < 0 || cursor.step < 0) throw new Error("preview progress controls are unavailable");
      const audit = await inspectCurrentPreviewStep(page);
      const screenshot = captureScreenshots
        ? `${String(index + 1).padStart(3, "0")}-c${cursor.chapter + 1}-s${cursor.step + 1}.png`
        : null;
      if (screenshot) await page.screenshot({ path: join(shotsDir, screenshot), type: "png" });
      steps.push({ index, ...cursor, ...audit, ...(screenshot ? { screenshot } : {}) });
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(120);
      const next = await readPreviewCursor(page);
      if (next.chapter === cursor.chapter && next.step === cursor.step) break;
    }
    const worst = steps.reduce((lowest, item) => item.score < lowest.score ? item : lowest, steps[0]);
    let score = worst?.score ?? 0;
    let pass = steps.length > 0 && steps.every((step) => step.pass);
    // 跨屏同质化门（2026-07-22 job-32 实证：13 章 66 屏一个模板刻出来，逐屏
    // 几何全干净 → 90 分通过——"每屏单看都对"看不见"整片一个样"）。
    // 判定：≥12 屏、单一版式签名占比 >60%、且横跨 ≥3 章 = 违规压分。
    const signatureStats = new Map();
    for (const step of steps) {
      if (!step.layoutSignature) continue;
      const entry = signatureStats.get(step.layoutSignature) || { count: 0, chapters: new Set() };
      entry.count += 1;
      entry.chapters.add(step.chapter);
      signatureStats.set(step.layoutSignature, entry);
    }
    const dominant = [...signatureStats.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    const layoutDiversity = {
      uniqueSignatures: signatureStats.size,
      dominantShare: dominant ? Math.round((dominant[1].count / Math.max(1, steps.length)) * 100) / 100 : 0,
      dominantChapters: dominant ? dominant[1].chapters.size : 0,
      dominantSignature: dominant ? dominant[0] : null,
      violation: false,
    };
    if (steps.length >= 12 && layoutDiversity.dominantShare > 0.6 && layoutDiversity.dominantChapters >= 3) {
      layoutDiversity.violation = true;
      score = Math.min(score, 75);
      pass = false;
    }
    const result = {
      score, pass,
      viewport: { width: 1920, height: 1080 }, checkedSteps: steps.length,
      mode: captureScreenshots ? "visual-evidence" : "structure-first",
      screenshotsCaptured: captureScreenshots ? steps.length : 0,
      layoutDiversity,
      worstStep: worst, steps, checkedAt: new Date().toISOString(),
    };
    if (captureScreenshots && worst?.screenshot) {
      writeFileSync(join(outDir, "quality-audit-worst.txt"), `${worst.screenshot}\n`);
    } else {
      writeFileSync(join(outDir, "quality-structure.json"), `${JSON.stringify(result, null, 2)}\n`);
      rmSync(join(outDir, "quality-audit-worst.txt"), { force: true });
    }
    writeFileSync(join(outDir, "quality-audit.json"), `${JSON.stringify(result, null, 2)}\n`);
    logEvent(job.id, "quality", `preview quality ${result.score}/100${result.pass ? " (pass)" : " (issues found)"}`, result.pass ? "info" : "error");
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Cheap first-pass gate: render every step and inspect layout geometry without
 * writing screenshots. Passing work proceeds directly to human approval. */
export function inspectPreviewQuality(job) {
  return inspectPreviewQualityInternal(job, { captureScreenshots: false });
}

/** Evidence mode for manual QA and failed first-pass checks. */
export function auditPreviewQuality(job) {
  return inspectPreviewQualityInternal(job, { captureScreenshots: true });
}

export async function renderJob(job) {
  const presDir = join(job.workspace, "presentation");
  if (!existsSync(join(presDir, "package.json"))) throw new Error("presentation 尚未生成");

  progress(job.id, 3, "统计配音段落");
  const audioRoot = join(presDir, "public", "audio");
  const segments = walkMp3(audioRoot);
  if (!segments.length) throw new Error("没有配音文件，无法确定成片时间轴");
  let totalAudioSec = 0;
  for (const file of segments) totalAudioSec += await mediaDuration(file);
  progress(job.id, 8, "启动预览服务");
  const previewUrl = await preparePreview(job);

  progress(job.id, 14, "启动无头浏览器");
  const browser = await launchBrowser();
  const tmpDir = join(job.workspace, "render-tmp");
  const framesDir = join(tmpDir, "frames");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    // 拦截每个 <audio> 的真实播放时刻（playing = 声音真正开始，而不是 play() 调用）。
    await context.addInitScript(() => {
      window.__vfAudio = [];
      const seen = new WeakSet();
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (this.tagName === "AUDIO" && !seen.has(this)) {
          seen.add(this);
          this.addEventListener("playing", () => window.__vfAudio.push({ src: this.currentSrc || this.src || "", at: Date.now(), ev: "playing" }), { once: true });
          this.addEventListener("ended", () => window.__vfAudio.push({ src: this.currentSrc || this.src || "", at: Date.now(), ev: "ended" }), { once: true });
        }
        return origPlay.apply(this, args);
      };
    });
    const page = await context.newPage();
    await page.goto(`${previewUrl}?auto=1`, { waitUntil: "load", timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500); // 静态产物无需等待 Vite 按需编译，仅留首屏动画缓冲

    const frames = [];
    const cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (params) => {
      const index = frames.length;
      const file = join(framesDir, `f${String(index).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(params.data, "base64"));
      frames.push({ file, ts: params.metadata.timestamp });
      cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

    progress(job.id, 18, "开始整片自动播放");
    // 不用 Space 启动：未打 suppressSpace 补丁的 scaffold 里 useStepper 也监听
    // Space，会在启动的同一次按键里把第 0 步跳过（首段配音丢失，实测 18/19）。
    // 点击 AutoStartGate 遮罩只触发 setAutoStarted，绕开双监听。
    const gate = page.locator(".auto-gate");
    if (await gate.count()) await gate.click();
    else await page.keyboard.press(" ");
    const capMs = totalAudioSec * 1000 + segments.length * 1800 + 30000;
    const startedAt = Date.now();
    let endedCount = 0;
    let lastEventCount = 0;
    let lastEventAt = Date.now();
    const total = segments.length;
    // 完成判定不能单点依赖 ended 计数：个别段可能加载失败走 estimate 兜底
    // （不产生 ended），或元素被提前清理。三条出口：
    //  ① ended 全齐  ② playing 全齐且页面已无正在播放的音频  ③ 事件长静默但基本播完
    for (;;) {
      await page.waitForTimeout(1000);
      const snap = await page.evaluate(() => ({
        n: window.__vfAudio.length,
        ended: window.__vfAudio.filter((e) => e.ev === "ended").length,
        playing: window.__vfAudio.filter((e) => e.ev === "playing").length,
        active: [...document.querySelectorAll("audio")].some((a) => !a.paused && !a.ended),
      }));
      if (snap.n > lastEventCount) {
        lastEventCount = snap.n;
        lastEventAt = Date.now();
      }
      if (snap.ended > endedCount) {
        endedCount = snap.ended;
        progress(job.id, 18 + (endedCount / total) * 50, `播放中 ${endedCount}/${total} 段`);
      }
      const quietMs = Date.now() - lastEventAt;
      if (snap.ended >= total) {
        await page.waitForTimeout(3000); // 尾步 trail + 收尾动画
        break;
      }
      if (snap.playing >= total && !snap.active && quietMs > 4000) {
        await page.waitForTimeout(2000);
        break;
      }
      if (quietMs > 30000 && snap.playing >= Math.ceil(total * 0.9) && !snap.active) break; // 个别段丢事件，但全片已放完
      if (Date.now() - startedAt > capMs || quietMs > 90000) {
        const detail = `已开始 ${snap.playing}/${total} 段、播完 ${snap.ended} 段`;
        const events = await page.evaluate(() => window.__vfAudio).catch(() => []);
        writeFileSync(join(tmpDir, "events.json"), JSON.stringify(events, null, 2));
        throw new Error(`播放${quietMs > 90000 ? "停滞" : "超时"}（${detail}），事件日志在 render-tmp/events.json`);
      }
    }

    await cdp.send("Page.stopScreencast").catch(() => {});
    const audioEvents = await page.evaluate(() => window.__vfAudio);
    const visualQuality = await inspectVisualQuality(page).catch(() => ({ score: null, collisions: null, subtitleSafe: null, sampledElements: 0 }));
    writeFileSync(join(tmpDir, "events.json"), JSON.stringify(audioEvents, null, 2));
    await browser.close();

    if (frames.length < 2) throw new Error("没有采集到画面帧");
    progress(job.id, 72, `合成视频帧（${frames.length} 帧）`);

    // 变长帧 concat 清单：duration = 相邻帧时间差，末帧顿 1s。
    // 时间戳相同/乱序的帧直接丢弃（同一时刻的画面重复），绝不垫最小时长——
    // 垫出来的假时长会累计拉长视频时间轴，而配音按真实挂钟摆放，
    // 结果就是字幕/口型越播越滞后且漂移量随采帧负载波动（时快时慢）。
    const t0 = frames[0].ts;
    const timeline = [];
    for (const frame of frames) {
      if (timeline.length && frame.ts <= timeline[timeline.length - 1].ts) continue;
      timeline.push(frame);
    }
    const droppedFrames = frames.length - timeline.length;
    if (droppedFrames) logEvent(job.id, "render", `丢弃 ${droppedFrames} 个重复/乱序时间戳帧，保持时间轴与真实挂钟一致`);
    const lines = [];
    for (let i = 0; i < timeline.length; i += 1) {
      const dur = i + 1 < timeline.length ? timeline[i + 1].ts - timeline[i].ts : 1.0;
      lines.push(`file '${relative(tmpDir, timeline[i].file).replace(/\\/g, "/")}'`, `duration ${dur.toFixed(4)}`);
    }
    lines.push(`file '${relative(tmpDir, timeline[timeline.length - 1].file).replace(/\\/g, "/")}'`);
    const listFile = join(tmpDir, "frames.txt");
    writeFileSync(listFile, lines.join("\n"));

    const videoOnly = join(tmpDir, "video-only.mp4");
    const enc = await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", "fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", videoOnly], tmpDir);
    if (!enc.ok) throw new Error(`视频编码失败：${enc.output.slice(-400)}`);

    progress(job.id, 88, "按真实时间轴混音");
    // playing 事件 → 每段 mp3 的精确起点（相对第一帧）。
    const placements = [];
    for (const ev of audioEvents) {
      if (ev.ev !== "playing" || !ev.src.includes("/audio/")) continue;
      const pathname = decodeURIComponent(new URL(ev.src).pathname);
      const audioIndex = pathname.indexOf("/audio/");
      if (audioIndex < 0) continue;
      const rel = pathname.slice(audioIndex + 1);
      const file = join(presDir, "public", rel);
      if (!existsSync(file)) continue;
      placements.push({ file, offsetMs: Math.max(0, Math.round(ev.at - t0 * 1000)) });
    }
    if (!placements.length) throw new Error("没有捕获到任何音频播放事件（页面可能未真正开始播放）");

    const args = ["-y", "-i", videoOnly];
    const chains = [];
    placements.forEach((p, i) => {
      args.push("-i", p.file);
      chains.push(`[${i + 1}:a]adelay=${p.offsetMs}|${p.offsetMs}[a${i}]`);
    });
    const mixInputs = placements.map((_, i) => `[a${i}]`).join("");
    chains.push(`${mixInputs}amix=inputs=${placements.length}:normalize=0:duration=longest,apad[mix]`);
    const output = join(job.workspace, "output.mp4");
    const mux = await run("ffmpeg", [...args, "-filter_complex", chains.join(";"),
      // Presentation frames already contain the time-synchronized AvatarPresenter.
      // Do not overlay lipsync.mp4 here or the finished video shows two presenters.
      "-map", "0:v", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", output], tmpDir);
    if (!mux.ok) throw new Error(`混音合成失败：${mux.output.slice(-400)}`);

    const cover = join(presDir, "public", "cover.png");
    const coverFrame = await run("ffmpeg", ["-y", "-ss", "2", "-i", output, "-frames:v", "1", cover], tmpDir);
    if (coverFrame.ok) logEvent(job.id, "cover", "作品封面已更新为最新成片画面");
    else logEvent(job.id, "cover", `成片已完成，但封面帧提取失败：${coverFrame.output.slice(-300)}`, "warning");

    const finalDur = await mediaDuration(output);
    writeFileSync(join(job.workspace, "render-meta.json"), JSON.stringify({
      renderedAt: new Date().toISOString(),
      frames: frames.length,
      droppedFrames,
      timelineSpanSec: Math.round((timeline[timeline.length - 1].ts - t0) * 10) / 10,
      segmentsPlaced: placements.length,
      segmentsExpected: segments.length,
      durationSec: Math.round(finalDur * 10) / 10,
      visualQuality,
    }, null, 2));
    if (visualQuality.score !== null) {
      logEvent(job.id, "render", `视觉质量评分 ${visualQuality.score}/100 · 重叠 ${visualQuality.collisions} · 字幕安全区 ${visualQuality.subtitleSafe ? "通过" : "需复核"}`, visualQuality.score < 75 ? "warning" : "info");
    }
    rmSync(tmpDir, { recursive: true, force: true });
    progress(job.id, 100, `成片完成：${Math.round(finalDur)} 秒`);
    return { ok: true, note: `成片已生成 output.mp4（${Math.round(finalDur)} 秒，${placements.length}/${segments.length} 段配音，${frames.length} 帧）` };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err; // render-tmp 保留现场供排查
  }
}
