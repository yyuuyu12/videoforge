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
    writeFileSync(join(tmpDir, "events.json"), JSON.stringify(audioEvents, null, 2));
    await browser.close();

    if (frames.length < 2) throw new Error("没有采集到画面帧");
    progress(job.id, 72, `合成视频帧（${frames.length} 帧）`);

    // 变长帧 concat 清单：duration = 相邻帧时间差，末帧顿 1s。
    const t0 = frames[0].ts;
    const lines = [];
    for (let i = 0; i < frames.length; i += 1) {
      const dur = i + 1 < frames.length ? Math.max(0.008, frames[i + 1].ts - frames[i].ts) : 1.0;
      lines.push(`file '${relative(tmpDir, frames[i].file).replace(/\\/g, "/")}'`, `duration ${dur.toFixed(4)}`);
    }
    lines.push(`file '${relative(tmpDir, frames[frames.length - 1].file).replace(/\\/g, "/")}'`);
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
      segmentsPlaced: placements.length,
      segmentsExpected: segments.length,
      durationSec: Math.round(finalDur * 10) / 10,
    }, null, 2));
    rmSync(tmpDir, { recursive: true, force: true });
    progress(job.id, 100, `成片完成：${Math.round(finalDur)} 秒`);
    return { ok: true, note: `成片已生成 output.mp4（${Math.round(finalDur)} 秒，${placements.length}/${segments.length} 段配音，${frames.length} 帧）` };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err; // render-tmp 保留现场供排查
  }
}
