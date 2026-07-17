import { Router } from "express";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { config, DATA_ROOT, ROOT } from "./config.js";
import { db, getJob, logEvent, updateJob } from "./db.js";
import { fetchArticleText, runDiscovery } from "./workers/discovery.js";
import { approveGate, retryJob } from "./workers/pipeline.js";
import { runFeedback, STAGES } from "./stages.js";
import { buildPresentation, previewStatus, startPreview, stopPreview } from "./preview.js";
import { decodeUtf8OrGb18030 } from "./textEncoding.js";
import { readRegistryChapterTitles } from "./chapterMetadata.js";
import { auditPreviewQuality, renderJob } from "./render.js";
import { loadSettings, publicSettings, saveSettings } from "./settings.js";
import { testLlmConnection } from "./providers.js";
import { cloneVoice, synthesize, testKey } from "./minimax.js";
import { health as heygemHealth } from "./heygem.js";
import { servicesStatus } from "./preflight.js";
import { choreographCameras } from "./cameraChoreographer.js";
import { startServices, stopServices } from "./servicesControl.js";
import { extractDouyin } from "./douyin.js";
import { searchTopics } from "./search.js";
import { classifyFeedback } from "./feedbackRouter.js";
import { runProtectedFeedback } from "./feedbackTransaction.js";
import { ledgerStats, recordQualityEntry } from "./qualityLedger.js";
import { retryExtraction } from "./workers/extractions.js";
import { createSourceDocument } from "./sourceDocument.js";

export const api = Router();
const PRESENTATION_THEMES = new Set(["midnight-press", "swiss-ikb", "newsroom", "bold-signal"]);

api.get("/health", (_req, res) => res.json({ ok: true }));
api.get("/meta", (_req, res) => res.json({ stages: STAGES, theme: config.theme }));

const APP_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const VERSION_CACHE_MS = 15 * 60 * 1000;
let versionCache = null;

function isNewerVersion(latest, current) {
  const parse = (value) => String(value ?? "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const next = parse(latest);
  const installed = parse(current);
  if (next.some(Number.isNaN) || installed.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(next.length, installed.length); index += 1) {
    const difference = (next[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

api.get("/version", async (_req, res) => {
  if (versionCache && Date.now() - versionCache.cachedAt < VERSION_CACHE_MS) {
    return res.json(versionCache.payload);
  }
  try {
    const response = await fetch("https://api.github.com/repos/yyuuyu12/videoforge/releases/latest", {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `VideoForge/${APP_VERSION}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) {
      const payload = { current: APP_VERSION, latest: null, updateAvailable: false, checked: true, message: "尚未发布正式版本" };
      versionCache = { cachedAt: Date.now(), payload };
      return res.json(payload);
    }
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    const latest = String(release.tag_name ?? "").replace(/^v/i, "") || null;
    const payload = {
      current: APP_VERSION,
      latest,
      updateAvailable: latest ? isNewerVersion(latest, APP_VERSION) : false,
      releaseUrl: release.html_url || undefined,
      checked: true,
    };
    versionCache = { cachedAt: Date.now(), payload };
    return res.json(payload);
  } catch {
    return res.json({
      current: APP_VERSION,
      latest: null,
      updateAvailable: false,
      checked: false,
      message: "暂时无法检查更新，不影响本机使用",
    });
  }
});

function chapterGeneration(job) {
  const presentationRoot = join(job.workspace, "presentation");
  const root = join(presentationRoot, "src", "chapters");
  const registryTitles = readRegistryChapterTitles(presentationRoot);
  let expected = 0;
  try {
    const outline = readFileSync(join(job.workspace, "outline.md"), "utf8");
    expected = (outline.match(/^\|\s*\d{2}:\d{2}\s*-\s*\d{2}:\d{2}\s*\|/gm) || []).length;
    if (!expected) expected = (outline.match(/^##\s+\d+[.)]\s+.+$/gm) || []).length;
    if (!expected) expected = (outline.match(/^##\s+(?:开场(?:[：:]|\s|$)|第[一二三四五六七八九十百]+章(?:[：:]|\s|$)).+$/gm) || []).length;
  } catch {}
  const reviewRows = db.prepare("SELECT chapter_key, status FROM chapter_reviews WHERE job_id = ?").all(job.id);
  const reviews = new Map(reviewRows.map((row) => [row.chapter_key, row.status]));
  const chapters = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "01-example")
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))
      .map((entry, index) => {
        const dir = join(root, entry.name);
        const files = readdirSync(dir);
        const narrationFile = files.find((name) => name === "narrations.ts");
        const chapterId = entry.name.replace(/^\d+[-_]?/, "");
        let title = registryTitles.get(chapterId) || chapterId.replace(/[-_]+/g, " ");
        let steps = 0;
        if (narrationFile) {
          const narration = readFileSync(join(dir, narrationFile), "utf8");
          const lines = narration.match(/["'`](?:\\.|[^"'`])*["'`]/g) || [];
          steps = lines.length;
          const first = lines[0]?.slice(1, -1).trim();
          if (!registryTitles.has(chapterId) && first) title = first.length > 30 ? `${first.slice(0, 30)}…` : first;
        }
        // Chapters may use the shared presentation stylesheet instead of a per-chapter CSS file.
        const ready = Boolean(narrationFile && files.some((name) => name.endsWith(".tsx")));
        return {
          key: entry.name,
          index: index + 1,
          title,
          steps,
          ready,
          status: reviews.get(entry.name) || (ready ? "review" : "generating"),
        };
      })
    : [];
  const serviceEvent = db.prepare("SELECT message FROM job_events WHERE job_id = ? AND stage = 'chapter_gen' AND (message LIKE '%agent start%' OR message LIKE '%API agent start%') ORDER BY id DESC LIMIT 1").get(job.id);
  const service = serviceEvent?.message?.match(/(?:API )?agent start(?: \((.+)\)|.*)/)?.[1]
    || (serviceEvent ? "本机订阅模型" : "等待模型服务");
  const ready = chapters.filter((chapter) => chapter.ready).length;
  const approved = chapters.filter((chapter) => chapter.status === "approved").length;
  const total = Math.max(expected, chapters.length);
  let liveProgress = null;
  try {
    const progressBytes = readFileSync(join(job.workspace, "presentation", ".videoforge-chapter-progress.json"));
    liveProgress = JSON.parse(decodeUtf8OrGb18030(progressBytes));
  } catch {}
  const liveCompleted = liveProgress
    ? Math.max(0, Number(liveProgress.current || 1) - (liveProgress.status === "done" ? 0 : 1))
    : ready;
  const percent = job.stage === "chapter_gen" && liveProgress?.total
    ? Math.min(100, Math.round((liveCompleted / Number(liveProgress.total)) * 100))
    : (total ? Math.round((ready / total) * 100) : 0);
  const currentChapterTitle = chapters.find((chapter) => chapter.key === liveProgress?.chapter)?.title;
  const liveMessage = liveProgress && job.stage === "chapter_gen"
    ? `第 ${liveProgress.current}/${liveProgress.total} 章 · ${currentChapterTitle || "当前画面"} · ${liveProgress.message || "正在生成"}`
    : null;
  if (job.stage === "chapter_gen") {
    chapters.forEach((chapter) => {
      if (!liveProgress) chapter.status = chapter.index === 1 ? "generating" : "queued";
      else if (chapter.index < Number(liveProgress.current)) chapter.status = "review";
      else if (chapter.index === Number(liveProgress.current) && liveProgress.status !== "done") chapter.status = "generating";
      else if (liveProgress.status !== "done") chapter.status = "queued";
    });
  }
  return {
    service,
    expected: total,
    discovered: chapters.length,
    ready,
    completed: job.stage === "chapter_gen" ? liveCompleted : ready,
    approved,
    percent,
    current: liveProgress,
    message: liveMessage || (job.stage === "chapter_gen"
      ? `正在生成并校验章节，已完成 ${ready}/${total || "?"}`
      : job.stage === "gate_chapters"
        ? `画面已生成，等待逐章确认 ${approved}/${chapters.length}`
        : "章节内容已保留"),
    chapters,
  };
}

function usageCategory(service, operation = "") {
  if (service === "minimax") return "audio";
  if (service === "heygem") return "avatar";
  if (["tikhub", "asr"].includes(service)) return "source";
  if (service !== "llm") return "other";
  if (/chapter_gen|visual-refine/.test(operation)) return "visual";
  if (/script_outline|text-refine|completion/.test(operation)) return "text";
  if (/audio_synth|audio-refine/.test(operation)) return "audio";
  if (/avatar_gen|avatar_media|avatar_wire|avatar-refine/.test(operation)) return "avatar";
  if (/subtitle_cues/.test(operation)) return "visual";
  return "other";
}

api.get("/quality/ledger", (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json(ledgerStats(days));
});

api.get("/usage", (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const pageSize = Math.max(5, Math.min(50, Number(req.query.pageSize) || 12));
  const requestedPage = Math.max(1, Number(req.query.page) || 1);
  const since = `-${days - 1} days`;
  const services = db.prepare(`
    SELECT service,
      SUM(requests) AS requests,
      SUM(CASE WHEN status = 'success' THEN requests ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'failed' THEN requests ELSE 0 END) AS failed,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(units) AS units,
      MAX(unit) AS unit,
      ROUND(AVG(NULLIF(duration_ms, 0))) AS avg_duration_ms,
      MAX(estimated) AS has_estimates
    FROM usage_events
    WHERE created_at >= datetime('now', ?)
    GROUP BY service
    ORDER BY requests DESC
  `).all(since);
  const daily = db.prepare(`
    SELECT date(created_at) AS day,
      SUM(requests) AS requests,
      SUM(input_tokens + output_tokens) AS tokens,
      SUM(CASE WHEN service = 'minimax' AND unit = 'characters' THEN units ELSE 0 END) AS minimax_characters
    FROM usage_events
    WHERE created_at >= datetime('now', ?)
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all(since);
  const totalRecent = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM usage_events WHERE created_at >= datetime('now', ?)
  `).get(since).count || 0);
  const totalPages = Math.max(1, Math.ceil(totalRecent / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const recent = db.prepare(`
    SELECT id, service, operation, job_id, status, requests, input_tokens, output_tokens,
      units, unit, duration_ms, estimated, detail, created_at
    FROM usage_events
    WHERE created_at >= datetime('now', ?)
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(since, pageSize, (page - 1) * pageSize).map((row) => ({
    ...row,
    category: usageCategory(row.service, row.operation),
  }));
  const categoryRows = db.prepare(`
    SELECT service, operation,
      SUM(requests) AS requests,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(units) AS units,
      MAX(unit) AS unit
    FROM usage_events
    WHERE created_at >= datetime('now', ?)
    GROUP BY service, operation
  `).all(since);
  const categoryMap = new Map();
  for (const row of categoryRows) {
    const category = usageCategory(row.service, row.operation);
    const current = categoryMap.get(category) || { category, requests: 0, input_tokens: 0, output_tokens: 0, characters: 0, audio_seconds: 0, audio_mb: 0 };
    current.requests += Number(row.requests || 0);
    current.input_tokens += Number(row.input_tokens || 0);
    current.output_tokens += Number(row.output_tokens || 0);
    if (row.unit === "characters") current.characters += Number(row.units || 0);
    if (row.unit === "audio_seconds") current.audio_seconds += Number(row.units || 0);
    if (row.unit === "audio_mb") current.audio_mb += Number(row.units || 0);
    categoryMap.set(category, current);
  }
  const totals = services.reduce((sum, row) => ({
    requests: sum.requests + Number(row.requests || 0),
    succeeded: sum.succeeded + Number(row.succeeded || 0),
    failed: sum.failed + Number(row.failed || 0),
    inputTokens: sum.inputTokens + Number(row.input_tokens || 0),
    outputTokens: sum.outputTokens + Number(row.output_tokens || 0),
    minimaxCharacters: sum.minimaxCharacters + (row.service === "minimax" && row.unit === "characters" ? Number(row.units || 0) : 0),
  }), { requests: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, minimaxCharacters: 0 });
  res.json({
    days,
    totals: { ...totals, minimaxEstimatedCny: Number((totals.minimaxCharacters / 1000 * 0.35).toFixed(2)) },
    services,
    categories: [...categoryMap.values()],
    daily,
    recent,
    pagination: { page, pageSize, total: totalRecent, totalPages },
  });
});

// ---- settings（密钥只存本地 settings.local.json，GET 永远打码）---------------

api.get("/settings", (_req, res) => res.json(publicSettings()));

// Export a local, secret-free support bundle. Keep this endpoint synchronous so
// it also works when a provider is unavailable and the user is already
// troubleshooting a failed startup.
api.get("/diagnostics", (_req, res) => {
  const settings = publicSettings();
  const redact = (value) => String(value ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]");
  const recentEvents = db.prepare(`
    SELECT job_id, stage, level, message, ts
    FROM job_events
    ORDER BY id DESC LIMIT 200
  `).all().map((event) => ({ ...event, message: redact(event.message) }));
  const recentJobs = db.prepare(`
    SELECT id, title, stage, status, error, created_at, updated_at
    FROM jobs ORDER BY id DESC LIMIT 20
  `).all().map((job) => ({ ...job, error: redact(job.error) }));
  const logFiles = [];
  try {
    for (const name of readdirSync(join(DATA_ROOT, "logs"))) {
      const file = join(DATA_ROOT, "logs", name);
      const stat = statSync(file);
      if (stat.isFile()) logFiles.push({ name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  } catch {}
  res.json({
    exportedAt: new Date().toISOString(),
    app: "VideoForge",
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    root: ROOT,
    dataRoot: DATA_ROOT,
    port: config.port,
    settings,
    recentJobs,
    recentEvents,
    logFiles,
  });
});

api.put("/settings", (req, res) => {
  // Accept a partial patch; empty-string keys mean "keep existing" so the
  // dashboard can submit the form without re-entering secrets every time.
  const patch = req.body ?? {};
  for (const section of ["llm", "minimax", "heygem", "asr", "avatar"]) {
    for (const secret of ["apiKey", "token"]) {
      if (patch[section] && patch[section][secret] === "") delete patch[section][secret];
    }
  }
  saveSettings(patch);
  res.json(publicSettings());
});

api.post("/settings/test-llm", async (_req, res) => {
  res.json(await testLlmConnection());
});

api.post("/settings/test-minimax", async (_req, res) => {
  try {
    res.json(await testKey());
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

api.get("/asr/health", async (_req, res) => {
  const baseUrl = loadSettings().asr.baseUrl.trim().replace(/\/$/, "");
  if (!baseUrl) {
    return res.json({ ok: false, configured: false, error: "尚未配置语音识别服务地址" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) {
      return res.json({ ok: false, configured: true, error: `服务返回 HTTP ${response.status}` });
    }
    const detail = await response.json().catch(() => null);
    return res.json({ ok: true, configured: true, detail: detail?.status ?? detail?.message ?? "服务在线" });
  } catch (error) {
    const reason = error.name === "AbortError" ? "连接超时" : "无法连接";
    return res.json({ ok: false, configured: true, error: `${reason}，请确认服务已启动且地址正确` });
  } finally {
    clearTimeout(timeout);
  }
});

// ---- voice（试听 + 克隆向导。克隆是付费一次性操作，前端需二次确认）------------

api.post("/voice/preview", async (req, res) => {
  try {
    const { text, speed, emotion, voiceId } = req.body ?? {};
    const buf = await synthesize(text || "这是一段试听：当前的语速和情绪参数听起来是这样的。", {
      speed,
      emotion,
      voiceId,
    });
    res.json({ ok: true, audioBase64: buf.toString("base64") });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

api.post("/voice/clone", async (req, res) => {
  try {
    const { filename, dataBase64, voiceId } = req.body ?? {};
    if (!dataBase64 || !voiceId)
      return res.status(400).json({ error: "dataBase64 和 voiceId 必填" });
    const r = await cloneVoice({ filename, dataBase64, voiceId });
    saveSettings({ minimax: { voiceId: r.voiceId } }); // 克隆成功即设为默认音色
    res.json({ ok: true, ...r });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ---- heygem gateway ---------------------------------------------------------

api.get("/heygem/health", async (_req, res) => {
  res.json(await heygemHealth());
});

// 统一依赖服务状态：生成引擎 / 配音 / 数字人 / ASR / 隧道（工作台与新建页预检用）
api.get("/services/status", async (_req, res) => {
  try {
    res.json(await servicesStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 一键启停模型服务（用户拍板：不开机自启，按需启动省资源）
api.post("/services/start", async (_req, res) => {
  res.json(await startServices());
});

api.post("/services/stop", async (_req, res) => {
  res.json(await stopServices());
});

// ---- reusable avatar assets -------------------------------------------------

const avatarLibraryDir = join(config.workspacesRoot, "_assets", "avatars");
mkdirSync(avatarLibraryDir, { recursive: true });

function avatarAssets() {
  return readdirSync(avatarLibraryDir)
    .filter((name) => /\.(mp4|mov)$/i.test(name))
    .map((filename) => {
      const [id, ...parts] = filename.replace(/\.(mp4|mov)$/i, "").split("-");
      return { id, filename, name: parts.join("-") || "数字人素材", size: statSync(join(avatarLibraryDir, filename)).size, url: `/api/assets/avatars/${id}/file` };
    })
    .sort((a, b) => Number(b.id) - Number(a.id));
}

api.get("/assets/avatars", (_req, res) => res.json(avatarAssets()));

api.post("/assets/avatars", (req, res) => {
  const { filename = "avatar.mp4", dataBase64 } = req.body ?? {};
  if (!dataBase64) return res.status(400).json({ error: "请选择数字人视频" });
  const ext = filename.toLowerCase().endsWith(".mov") ? ".mov" : ".mp4";
  const safeName = filename.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60) || "avatar";
  const saved = `${Date.now()}-${safeName}${ext}`;
  writeFileSync(join(avatarLibraryDir, saved), Buffer.from(dataBase64, "base64"));
  res.json(avatarAssets().find((item) => item.filename === saved));
});

api.get("/assets/avatars/:id/file", (req, res) => {
  const asset = avatarAssets().find((item) => item.id === req.params.id);
  if (!asset) return res.status(404).end();
  res.sendFile(join(avatarLibraryDir, asset.filename));
});

api.delete("/assets/avatars/:id", (req, res) => {
  const asset = avatarAssets().find((item) => item.id === req.params.id);
  if (!asset) return res.status(404).json({ error: "not found" });
  unlinkSync(join(avatarLibraryDir, asset.filename));
  res.json({ ok: true });
});

api.post("/jobs/:id/avatar/select", (req, res) => {
  const job = getJob(Number(req.params.id));
  const asset = avatarAssets().find((item) => item.id === String(req.body?.assetId));
  if (!job || !asset) return res.status(404).json({ error: "作品或素材不存在" });
  const dir = join(job.workspace, "assets");
  mkdirSync(dir, { recursive: true });
  const saved = `presenter.${asset.filename.toLowerCase().endsWith(".mov") ? "mov" : "mp4"}`;
  copyFileSync(join(avatarLibraryDir, basename(asset.filename)), join(dir, saved));
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
  meta.avatar = {
    ...(meta.avatar ?? {}),
    enabled: true,
    source: `assets/${saved}`,
    filename: asset.name,
    assetId: asset.id,
    pendingRegeneration: true,
  };
  updateJob(job.id, { meta: JSON.stringify(meta) });
  // 最近一次选择即默认：下个作品启用数字人时自动带出，无需重复选
  saveSettings({ avatar: { defaultFilename: asset.filename } });
  logEvent(job.id, "avatar_media", `已切换数字人素材：${asset.name}；等待重新生成口型（已记为默认素材）`);
  res.json({ ok: true, asset: { id: asset.id, name: asset.name }, pendingRegeneration: true });
});

// ---- sources & discovery --------------------------------------------------

api.get("/sources", (_req, res) => {
  res.json(db.prepare("SELECT * FROM sources ORDER BY id").all());
});

api.post("/sources", (req, res) => {
  const { name, url, type = "rss" } = req.body ?? {};
  if (!name || !url) return res.status(400).json({ error: "name and url required" });
  const r = db
    .prepare("INSERT OR IGNORE INTO sources (name, type, url) VALUES (?, ?, ?)")
    .run(name, type, url);
  res.json({ id: r.lastInsertRowid, inserted: r.changes > 0 });
});

api.delete("/sources/:id", (req, res) => {
  db.prepare("DELETE FROM sources WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

api.post("/discovery/run", async (_req, res) => {
  res.json(await runDiscovery());
});

/** 联网搜索选题（订阅模式 WebSearch / Anthropic API web_search），结果直接入候选。 */
api.post("/discovery/search", async (req, res) => {
  try {
    const results = await searchTopics(req.body?.directions);
    let added = 0;
    for (const r of results) {
      const ins = db
        .prepare("INSERT OR IGNORE INTO articles (title, url, summary) VALUES (?, ?, ?)")
        .run(r.title, r.url, r.summary);
      added += ins.changes;
    }
    res.json({ ok: true, found: results.length, added });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

/** 抖音链接/分享文本 → 提取文案 → 入候选（content 即口播原文，可直接做视频）。 */
api.post("/articles/douyin", async (req, res) => {
  try {
    const r = await extractDouyin(req.body?.url);
    if (r.via === "desc-only" || r.script.length < 200) {
      return res.status(422).json({
        ok: false,
        error: `没有提取到完整口播文案，目前只有 ${r.script.length} 字，未创建作品`,
        via: r.via,
        chars: r.script.length,
        steps: r.steps,
      });
    }
    const ins = db
      .prepare("INSERT OR IGNORE INTO articles (title, url, summary, content) VALUES (?, ?, ?, ?)")
      .run(
        `[抖音] ${r.title}${r.author ? ` @${r.author}` : ""}`,
        r.url,
        `提取方式：${r.via}`,
        r.script,
      );
    const articleId = ins.changes > 0
      ? Number(ins.lastInsertRowid)
      : Number(db.prepare("SELECT id FROM articles WHERE url = ?").get(r.url)?.id || 0);
    res.json({ ok: true, added: ins.changes > 0, articleId, via: r.via, chars: r.script.length, title: r.title, steps: r.steps });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ---- articles ---------------------------------------------------------------

api.get("/articles", (req, res) => {
  const status = req.query.status ?? "new";
  res.json(
    db
      .prepare("SELECT * FROM articles WHERE status = ? ORDER BY fetched_at DESC LIMIT 200")
      .all(String(status)),
  );
});

/** Manually add an article by URL (or pasted text). */
api.post("/articles/manual", async (req, res) => {
  const { url, title, text } = req.body ?? {};
  if (!url && !text) return res.status(400).json({ error: "url or text required" });
  const r = db
    .prepare("INSERT OR IGNORE INTO articles (title, url, content) VALUES (?, ?, ?)")
    .run(title ?? url ?? "手动添加", url ?? null, text ?? null);
  res.json({ id: r.lastInsertRowid, inserted: r.changes > 0 });
});

api.post("/articles/:id/dismiss", (req, res) => {
  db.prepare("UPDATE articles SET status = 'dismissed' WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

/** 选中 -> create a draft job + workspace, then wait for source confirmation. */
api.post("/articles/:id/select", async (req, res) => {
  const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(Number(req.params.id));
  if (!article) return res.status(404).json({ error: "article not found" });

  let content = article.content;
  if (!content && article.url) {
    try {
      content = await fetchArticleText(article.url);
    } catch (err) {
      return res.status(502).json({ error: `fetch article failed: ${err.message}` });
    }
  }
  if (!content || content.length < 200) {
    return res.status(422).json({ error: "article text too thin — paste text manually via /articles/manual" });
  }

  const jobRow = db
    .prepare("INSERT INTO jobs (article_id, title, workspace, stage, status) VALUES (?, ?, '', 'gate_source', 'waiting_approval')")
    .run(article.id, article.title);
  const jobId = Number(jobRow.lastInsertRowid);
  const workspace = join(config.workspacesRoot, `job-${jobId}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "article.md"), createSourceDocument({
    title: article.title,
    content,
    source: article.url,
  }));
  updateJob(jobId, { workspace, stage: "gate_source", status: "waiting_approval", error: null });
  db.prepare("UPDATE articles SET status = 'selected' WHERE id = ?").run(article.id);
  logEvent(jobId, "init", `workspace created: ${workspace}`);
  res.json({ jobId, workspace });
});

// ---- jobs -------------------------------------------------------------------

api.get("/jobs", (_req, res) => {
  const jobs = db.prepare(`
    SELECT jobs.*, substr(coalesce(articles.summary, articles.content, ''), 1, 140) AS excerpt
    FROM jobs
    LEFT JOIN articles ON articles.id = jobs.article_id
    ORDER BY jobs.id DESC
    LIMIT 100
  `).all();
  res.json(jobs.map((job) => ({
    ...job,
    coverExists: [
      join(job.workspace, "presentation", "public", "cover.png"),
      join(job.workspace, "presentation", "cover.png"),
    ].some((path) => existsSync(path)),
  })));
});

api.delete("/jobs/:id", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "作品不存在或已经删除" });
  if (["queued", "running"].includes(job.status)) {
    return res.status(409).json({ error: "作品正在生成，完成或失败后才能删除" });
  }

  const root = resolve(config.workspacesRoot);
  const workspace = resolve(job.workspace);
  const workspaceRelative = relative(root, workspace);
  if (!workspaceRelative || workspaceRelative.startsWith("..") || isAbsolute(workspaceRelative)) {
    return res.status(409).json({ error: "作品工作区路径异常，已停止删除" });
  }

  stopPreview(job.id);
  try {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
  } catch (error) {
    return res.status(500).json({ error: `作品文件删除失败：${error.message}` });
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE douyin_extractions SET job_id = NULL, updated_at = datetime('now') WHERE job_id = ?").run(job.id);
    db.prepare("DELETE FROM feedback WHERE job_id = ?").run(job.id);
    db.prepare("DELETE FROM job_events WHERE job_id = ?").run(job.id);
    db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: `作品记录删除失败：${error.message}` });
  }

  res.json({ ok: true, workspaceRemoved: true });
});

// ---- persistent Douyin extraction tasks ------------------------------------

const extractionRows = () => db.prepare("SELECT * FROM douyin_extractions ORDER BY id DESC LIMIT 50").all()
  .map((row) => {
    try { return { ...row, steps: JSON.parse(row.steps || "[]") }; }
    catch { return { ...row, steps: [] }; }
  });

api.get("/douyin/extractions", (_req, res) => {
  res.json(extractionRows());
});

api.post("/douyin/extractions", (req, res) => {
  const inputUrl = String(req.body?.url || "").trim();
  if (!inputUrl) return res.status(400).json({ error: "请粘贴抖音分享链接或分享文本" });
  const result = db.prepare("INSERT INTO douyin_extractions (input_url, message) VALUES (?, ?)")
    .run(inputUrl, "等待开始提取");
  res.json({ id: Number(result.lastInsertRowid), status: "queued" });
});

api.post("/douyin/extractions/:id/retry", (req, res) => {
  const row = db.prepare("SELECT id FROM douyin_extractions WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "提取记录不存在" });
  retryExtraction(row.id);
  res.json({ ok: true });
});

api.post("/douyin/extractions/:id/create-work", (req, res) => {
  const extraction = db.prepare("SELECT * FROM douyin_extractions WHERE id = ?").get(Number(req.params.id));
  if (!extraction || extraction.status !== "done" || !extraction.article_id) {
    return res.status(409).json({ error: "文案尚未完整提取，暂时不能制作视频" });
  }
  if (extraction.job_id) return res.json({ jobId: extraction.job_id, existing: true });
  const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(extraction.article_id);
  if (!article?.content || article.content.length < 200) return res.status(422).json({ error: "提取文案不完整" });
  const jobRow = db.prepare("INSERT INTO jobs (article_id, title, workspace, stage, status) VALUES (?, ?, '', 'gate_source', 'waiting_approval')").run(article.id, article.title);
  const jobId = Number(jobRow.lastInsertRowid);
  const workspace = join(config.workspacesRoot, `job-${jobId}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "article.md"), createSourceDocument({
    title: article.title,
    content: article.content,
    source: article.url,
  }));
  updateJob(jobId, { workspace, stage: "gate_source", status: "waiting_approval", error: null });
  db.prepare("UPDATE articles SET status = 'selected' WHERE id = ?").run(article.id);
  db.prepare("UPDATE douyin_extractions SET job_id = ?, updated_at = datetime('now') WHERE id = ?").run(jobId, extraction.id);
  logEvent(jobId, "init", `workspace created from extraction ${extraction.id}: ${workspace}`);
  res.json({ jobId, workspace, existing: false });
});

api.get("/jobs/:id/cover", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).end();
  const candidates = [
    join(job.workspace, "presentation", "public", "cover.png"),
    join(job.workspace, "presentation", "cover.png"),
  ];
  const cover = candidates.find((path) => existsSync(path));
  if (!cover) return res.status(404).end();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(cover);
});

api.get("/jobs/:id", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const events = db
    .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 100")
    .all(job.id);
  const eventError = events.find((event) => event.level === "error" && event.message.startsWith("stage FAILED"));
  const displayError = job.error
    || (job.status === "failed" ? eventError?.message.replace(/^stage FAILED after \d+s:\s*/, "") : null)
    || null;
  const feedback = db
    .prepare("SELECT * FROM feedback WHERE job_id = ? ORDER BY id DESC LIMIT 50")
    .all(job.id)
    .map(({ attachment_path: attachmentPath, ...item }) => ({
      ...item,
      attachment_url: attachmentPath ? `/api/jobs/${job.id}/feedback/${item.id}/attachment` : null,
    }));
  const outputPath = join(job.workspace, "output.mp4");
  let output = { exists: existsSync(outputPath), rendering: renderingJobs.has(job.id) };
  if (output.exists) {
    try { output = { ...JSON.parse(readFileSync(join(job.workspace, "render-meta.json"), "utf8")), ...output }; } catch {}
  }
  res.json({ ...job, error: displayError, events, feedback, output, chapterGeneration: chapterGeneration(job), devServer: previewStatus(job) });
});

api.get("/jobs/:id/quality-audit", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const reportPath = join(job.workspace, "presentation", "public", "quality-audit.json");
  if (!existsSync(reportPath)) return res.status(404).json({ error: "quality audit not available" });
  try {
    return res.json(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch {
    return res.status(500).json({ error: "quality audit is invalid" });
  }
});

api.post("/jobs/:id/quality-audit", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    return res.json(await auditPreviewQuality(job));
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

api.put("/jobs/:id/options", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.stage !== "gate_style" || job.status !== "waiting_approval") {
    return res.status(409).json({ error: "请先进入“选择风格”步骤，再修改风格或数字人设置" });
  }
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
  if (req.body?.theme && !PRESENTATION_THEMES.has(req.body.theme)) {
    return res.status(400).json({ error: "不支持这个画面主题，请重新选择" });
  }
  meta = { ...meta, ...(req.body ?? {}) };
  updateJob(job.id, { meta: JSON.stringify(meta) });
  res.json({ ...getJob(job.id), meta });
});

api.post("/jobs/:id/avatar", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const { filename = "presenter.mp4", dataBase64 } = req.body ?? {};
  if (!dataBase64) return res.status(400).json({ error: "请选择一段出镜视频" });
  const ext = filename.toLowerCase().endsWith(".mov") ? ".mov" : ".mp4";
  const dir = join(job.workspace, "assets");
  mkdirSync(dir, { recursive: true });
  const saved = `presenter${ext}`;
  writeFileSync(join(dir, saved), Buffer.from(dataBase64, "base64"));
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
  meta.avatar = { ...(meta.avatar ?? {}), enabled: true, source: `assets/${saved}`, filename, pendingRegeneration: true };
  updateJob(job.id, { meta: JSON.stringify(meta) });
  res.json({ ok: true, filename });
});

api.post("/jobs/:id/avatar/generate", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
  const source = meta.avatar?.source && join(job.workspace, meta.avatar.source);
  if (!source || !existsSync(source)) {
    return res.status(409).json({ error: "请先选择一段出镜视频，再生成数字人" });
  }
  const service = await heygemHealth();
  if (!service.ok || !service.ready) {
    logEvent(job.id, "avatar_media", "HeyGem 未就绪，未提交口型生成", "error");
    return res.status(409).json({ error: "HeyGem 当前未启动或还在加载模型。请启动服务并确认状态变为“可用”后，再重新生成。" });
  }
  updateJob(job.id, { stage: "avatar_media", status: "queued", error: null });
  logEvent(job.id, "avatar_media", "已提交数字人对口型任务");
  res.status(202).json({ ok: true, accepted: true });
});

api.get("/jobs/:id/audit", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
  const pres = join(job.workspace, "presentation");
  const chapterRoot = join(pres, "src", "chapters");
  const chapters = existsSync(chapterRoot)
    ? readdirSync(chapterRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  const layout = chapters.map((entry) => {
    const files = readdirSync(join(chapterRoot, entry.name)).filter((name) => name.endsWith(".css"));
    const content = files.map((name) => readFileSync(join(chapterRoot, entry.name, name), "utf8")).join("\n");
    return {
      chapter: entry.name,
      reserved:
        /padding-right:\s*(44[0-9]|45[0-9]|6\d\d|7\d\d)px/.test(content) ||
        /right:\s*(44[0-9]|45[0-9]|6\d\d|7\d\d)px/.test(content) ||
        /grid-template-columns:[^;]*(44[0-9]|45[0-9]|6\d\d|7\d\d)px/.test(content) ||
        /(?:reserve(?:d)?|presenter|avatar)[^{]*\{[^}]*width:\s*(44[0-9]|45[0-9]|6\d\d|7\d\d)px/is.test(content),
    };
  });
  const audioRoot = join(pres, "public", "audio");
  const countAudio = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? countAudio(join(dir, entry.name)) : entry.name.endsWith(".mp3") ? 1 : 0), 0);
  const avatarFile = join(pres, "public", "avatar", "lipsync.mp4");
  const avatarPreviewDir = join(pres, "public", "avatar", "chapters");
  const subtitleFile = join(pres, "src", "registry", "subtitleCues.ts");
  const outputFile = join(job.workspace, "output.mp4");
  const sourceExists = Boolean(meta.avatar?.source && existsSync(join(job.workspace, meta.avatar.source)));
  res.json({
    jobId: job.id,
    layout: { ok: !meta.avatar?.enabled || (layout.length > 0 && layout.every((item) => item.reserved)), chapters: layout },
    audio: { ok: existsSync(audioRoot) && countAudio(audioRoot) > 0, segments: existsSync(audioRoot) ? countAudio(audioRoot) : 0 },
    subtitle: { enabled: meta.subtitle?.enabled !== false, ok: meta.subtitle?.enabled === false || existsSync(subtitleFile), preset: meta.subtitle?.preset || "auto-contrast", position: meta.subtitle?.position || "bottom" },
    avatar: {
      enabled: Boolean(meta.avatar?.enabled),
      sourceExists,
      outputExists: existsSync(avatarFile),
      previews: existsSync(avatarPreviewDir) ? readdirSync(avatarPreviewDir).filter((name) => name.endsWith(".mp4")).length : 0,
      service: await heygemHealth(),
    },
    render: { ok: existsSync(outputFile), outputExists: existsSync(outputFile) },
    dialogue: { total: db.prepare("SELECT COUNT(*) AS count FROM feedback WHERE job_id = ?").get(job.id).count },
  });
});

api.get("/jobs/:id/avatar/previews", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const presentation = join(job.workspace, "presentation");
  const dir = join(presentation, "public", "avatar", "chapters");
  if (!existsSync(dir)) return res.json([]);
  const files = readdirSync(dir).filter((name) => name.endsWith(".mp4"));
  const manifest = join(presentation, "audio-segments.json");
  let chapterOrder = [];
  if (existsSync(manifest)) {
    try {
      chapterOrder = [...new Set(JSON.parse(readFileSync(manifest, "utf8")).map((segment) => segment.chapter))];
    } catch {}
  }
  const order = new Map(chapterOrder.map((chapter, index) => [chapter, index]));
  files.sort((a, b) => {
    const ai = order.get(a.replace(/\.mp4$/, "")) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.replace(/\.mp4$/, "")) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || a.localeCompare(b);
  });
  res.json(files.map((name) => ({
    id: name.replace(/\.mp4$/, ""),
    name,
    url: `/api/jobs/${job.id}/avatar/previews/${encodeURIComponent(name)}`,
  })));
});

api.get("/jobs/:id/avatar/previews/:name", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).end();
  const name = basename(req.params.name);
  if (!name.endsWith(".mp4")) return res.status(403).end();
  const file = join(job.workspace, "presentation", "public", "avatar", "chapters", name);
  if (!existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

api.post("/jobs/:id/approve", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.stage === "gate_source") {
    const source = join(job.workspace, "article.md");
    if (!existsSync(source) || readFileSync(source, "utf8").trim().length < 200) {
      return res.status(409).json({ error: "原文内容不足 200 字，请先补充完整再继续" });
    }
  }
  if (job.stage === "gate_script" && !existsSync(join(job.workspace, "script.md"))) {
    return res.status(409).json({ error: "口播稿文件还没有生成完成" });
  }
  if (job.stage === "gate_style") {
    let meta = {};
    try { meta = JSON.parse(job.meta || "{}"); } catch {}
    updateJob(job.id, { meta: JSON.stringify({
      ...meta,
      theme: meta.theme || config.theme,
      typography: { fontSize: "large", density: "balanced", ...(meta.typography || {}) },
      subtitle: { enabled: true, preset: "auto-contrast", position: "bottom", ...(meta.subtitle || {}) },
      avatar: { enabled: false, position: "right-third", ...(meta.avatar || {}) },
    }) });
  }
  if (job.stage === "gate_chapters") {
    const generation = chapterGeneration(job);
    const pending = generation.chapters.filter((chapter) => chapter.status !== "approved");
    if (!generation.chapters.length || pending.length) {
      return res.status(409).json({ error: `请先逐章确认画面，还有 ${pending.length || generation.expected || 1} 章未确认` });
    }
  }
  const pres = join(job.workspace, "presentation");
  if (job.stage === "gate_audio") {
    const audioRoot = join(pres, "public", "audio");
    const count = existsSync(audioRoot) ? readdirSync(audioRoot, { recursive: true }).filter((name) => String(name).endsWith(".mp3")).length : 0;
    if (!count) return res.status(409).json({ error: "没有检测到配音文件，请先重试配音生成" });
  }
  if (job.stage === "gate_subtitles") {
    let meta = {};
    try { meta = JSON.parse(job.meta || "{}"); } catch {}
    if (meta.subtitle?.enabled !== false && !existsSync(join(pres, "src", "registry", "subtitleCues.ts"))) {
      return res.status(409).json({ error: "字幕时间轴尚未生成完成" });
    }
  }
  if (job.stage === "gate_avatar") {
    let meta = {};
    try { meta = JSON.parse(job.meta || "{}"); } catch {}
    if (meta.avatar?.enabled && !existsSync(join(pres, "public", "avatar", "lipsync.mp4"))) {
      return res.status(409).json({ error: "数字人视频尚未生成完成" });
    }
  }
  if (job.stage === "gate_render" && !existsSync(join(pres, "package.json"))) {
    return res.status(409).json({ error: "画面工程不完整，暂时不能生成成片" });
  }
  res.json({ ok: approveGate(job.id) });
});

api.post("/jobs/:id/chapters/:chapter/approve", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.stage !== "gate_chapters" || job.status !== "waiting_approval") {
    return res.status(409).json({ error: "画面尚未进入章节验收，暂时不能确认" });
  }
  const chapter = basename(req.params.chapter);
  const generation = chapterGeneration(job);
  const item = generation.chapters.find((candidate) => candidate.key === chapter);
  if (!item?.ready) return res.status(409).json({ error: "本章尚未生成完成，暂时不能确认" });
  db.prepare(`
    INSERT INTO chapter_reviews (job_id, chapter_key, status) VALUES (?, ?, 'approved')
    ON CONFLICT(job_id, chapter_key) DO UPDATE SET status = 'approved', updated_at = datetime('now')
  `).run(job.id, chapter);
  logEvent(job.id, "gate_chapters", `章节确认通过 ${item.index}/${generation.chapters.length}: ${chapter}`);
  res.json({ ok: true, chapter, chapterGeneration: chapterGeneration(job) });
});

api.post("/jobs/:id/retry", (req, res) => {
  res.json({ ok: retryJob(Number(req.params.id), req.body?.stage) });
});

api.get("/jobs/:id/feedback/:feedbackId/attachment", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).end();
  const item = db.prepare("SELECT attachment_path, attachment_mime FROM feedback WHERE id = ? AND job_id = ?")
    .get(Number(req.params.feedbackId), job.id);
  if (!item?.attachment_path) return res.status(404).end();
  const path = resolve(job.workspace, item.attachment_path);
  const rel = relative(resolve(job.workspace), path);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(path)) return res.status(404).end();
  res.type(item.attachment_mime || "application/octet-stream").sendFile(path);
});

/** 对话修改：执行局部修改，并在画面相关阶段重建静态预览。 */
api.post("/jobs/:id/feedback", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const { chapter, phase, attachment } = req.body ?? {};
  const message = String(req.body?.message || "").trim() || (attachment ? "请根据参考图片检查并调整当前页面" : "");
  if (!message) return res.status(400).json({ error: "请填写修改要求或粘贴一张参考图片" });
  let attachmentBuffer = null;
  let attachmentExtension = null;
  const allowedImages = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"]]);
  if (attachment) {
    attachmentExtension = allowedImages.get(String(attachment.mime || "").toLowerCase());
    if (!attachmentExtension) return res.status(415).json({ error: "只支持 PNG、JPEG 或 WebP 图片" });
    attachmentBuffer = Buffer.from(String(attachment.dataBase64 || ""), "base64");
    if (!attachmentBuffer.length) return res.status(400).json({ error: "粘贴的图片内容为空" });
    if (attachmentBuffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: "图片不能超过 5MB" });
  }
  const feedbackPhases = ["口播稿审阅", "逐页生成", "配音字幕", "数字人"];
  const previewAffectingPhases = new Set(["逐页生成", "配音字幕", "数字人"]);
  if (!feedbackPhases.includes(phase)) {
    return res.status(409).json({ error: "当前环节不支持对话修改" });
  }
  if (phase === "逐页生成" && chapter) {
    const chapterKey = basename(chapter);
    if (!chapterGeneration(job).chapters.some((item) => item.key === chapterKey)) {
      return res.status(404).json({ error: "没有找到要修改的章节" });
    }
  }

  // R1 意图路由：同步/全局类问题不进 Agent（QUALITY-ARCHITECTURE §9）
  const routed = classifyFeedback(message, phase);
  if (routed.route !== "agent") {
    const guidance = routed.route === "pipeline"
      ? `已识别为媒体管线问题：${routed.reason}。\n正确修法是重跑「${routed.label}」——在对应环节点「重新生成」（内部阶段：${routed.stage}），下游会按级联规则自动重做，无需逐页修改代码。`
      : `${routed.reason}。请回到「选择风格」环节更换主题后重新生成画面，系统会保留原文与稿件。`;
    const routedRow = db
      .prepare("INSERT INTO feedback (job_id, chapter, phase, message, status, progress, progress_message, result) VALUES (?, ?, ?, ?, 'done', 100, ?, ?)")
      .run(job.id, chapter ?? null, phase, message, "已识别问题归属，未调用模型", guidance);
    recordQualityEntry({ kind: "feedback-routed", jobId: job.id, route: routed.route, stage: routed.stage ?? null, phase });
    logEvent(job.id, "feedback", `意图路由：${routed.route}${routed.stage ? ` -> ${routed.stage}` : ""}（未调用模型）`);
    return res.json({ feedbackId: routedRow.lastInsertRowid, routed: routed.route, stage: routed.stage ?? null });
  }

  const f = db
    .prepare("INSERT INTO feedback (job_id, chapter, phase, message, status, progress, progress_message) VALUES (?, ?, ?, ?, 'running', 5, ?)")
    .run(job.id, chapter ?? null, phase, message, "修改请求已提交，等待模型开始");
  let attachmentPath = null;
  if (attachmentBuffer && attachmentExtension) {
    const relativeDir = "feedback-attachments";
    attachmentPath = `${relativeDir}/feedback-${f.lastInsertRowid}${attachmentExtension}`;
    mkdirSync(join(job.workspace, relativeDir), { recursive: true });
    writeFileSync(join(job.workspace, attachmentPath), attachmentBuffer);
    db.prepare("UPDATE feedback SET attachment_path = ?, attachment_mime = ? WHERE id = ?")
      .run(attachmentPath, String(attachment.mime).toLowerCase(), f.lastInsertRowid);
  }
  if (chapter && phase === "逐页生成") {
    db.prepare(`
      INSERT INTO chapter_reviews (job_id, chapter_key, status) VALUES (?, ?, 'review')
      ON CONFLICT(job_id, chapter_key) DO UPDATE SET status = 'review', updated_at = datetime('now')
    `).run(job.id, basename(chapter));
  }
  res.json({ feedbackId: f.lastInsertRowid }); // respond immediately; agent runs async

  try {
    // 画面类修改走受保护事务（快照/白名单/门禁对比/自动回滚）；
    // 稿件类（md 文件）风险低，走普通路径。
    const feedbackRunner = previewAffectingPhases.has(phase) ? runProtectedFeedback : runFeedback;
    const r = await feedbackRunner(job, {
      chapter,
      message,
      phase,
      attachmentPath,
      onProgress: (progress, progressMessage) => db.prepare(
        "UPDATE feedback SET progress = ?, progress_message = ? WHERE id = ?",
      ).run(Math.max(0, Math.min(100, Math.round(progress))), progressMessage, f.lastInsertRowid),
    });
    const error = r.ok ? null : (r.note || r.output || "模型没有完成修改");
    const result = r.ok
      ? (String(r.output || "").trim().slice(-2400) || "具体修改：模型已完成本次调整。\n修改思路：按照你的反馈做了最小范围修改。\n检查结果：任务执行成功。")
      : null;
    if (r.ok && previewAffectingPhases.has(phase)) {
      db.prepare("UPDATE feedback SET progress = 86, progress_message = ? WHERE id = ?")
        .run("修改已完成，正在重建左侧预览", f.lastInsertRowid);
      try {
        await startPreview(getJob(job.id) || job);
        db.prepare("UPDATE feedback SET progress = 96, progress_message = ? WHERE id = ?")
          .run("预览已重建，正在刷新", f.lastInsertRowid);
      } catch (previewError) {
        db.prepare("UPDATE feedback SET status = 'failed', progress = 100, progress_message = ?, error = ?, result = ? WHERE id = ?")
          .run(
            "修改已保存，但预览重建失败",
            `修改已保存，但左侧预览重建失败：${String(previewError.message || previewError).slice(0, 700)}`,
            result,
            f.lastInsertRowid,
          );
        return;
      }
    }
    db.prepare("UPDATE feedback SET status = ?, progress = 100, progress_message = ?, error = ?, result = ? WHERE id = ?")
      .run(
        r.ok ? "done" : "failed",
        r.ok
          ? (previewAffectingPhases.has(phase) ? "修改完成，左侧预览已刷新" : "修改完成")
          : "修改未完成",
        error ? String(error).slice(0, 800) : null,
        result,
        f.lastInsertRowid,
      );
  } catch (error) {
    db.prepare("UPDATE feedback SET status = 'failed', progress = 100, progress_message = '修改未完成', error = ? WHERE id = ?")
      .run(String(error.message || error).slice(0, 800), f.lastInsertRowid);
  }
});

/** 读工作区里的产出文件（白名单制），给审批/预览环节展示内容用。 */
const READABLE_FILES = ["article.md", "script.md", "outline.md"];
api.get("/jobs/:id/files/:name", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const name = req.params.name;
  if (!READABLE_FILES.includes(name)) return res.status(403).json({ error: "file not readable" });
  try {
    const content = readFileSync(join(job.workspace, name), "utf8");
    res.json({ ok: true, name, content });
  } catch {
    res.json({ ok: false, name, content: null });
  }
});

api.put("/jobs/:id/files/article.md", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.stage !== "gate_source" || job.status !== "waiting_approval") {
    return res.status(409).json({ error: "只有在原文确认步骤才能修改原文" });
  }
  const content = String(req.body?.content || "").replace(/\r\n?/g, "\n").trim();
  if (content.length < 200) return res.status(422).json({ error: "原文内容不足 200 字，请补充完整后再保存" });
  if (content.length > 200_000) return res.status(413).json({ error: "原文超过 20 万字，暂时无法保存" });
  const saved = `${content}\n`;
  writeFileSync(join(job.workspace, "article.md"), saved, "utf8");
  logEvent(job.id, "gate_source", `原文已手动调整并保存 · ${saved.length} 字符`);
  res.json({ ok: true, name: "article.md", content: saved });
});

// ---- per-job preview dev server ----------------------------------------------

api.post("/jobs/:id/devserver/start", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json(await startPreview(job));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

api.post("/jobs/:id/devserver/stop", (req, res) => {
  res.json(stopPreview(Number(req.params.id)));
});

// ---- 服务端成片（无头浏览器 + ffmpeg） ------------------------------------------

const renderingJobs = new Set();

api.post("/jobs/:id/choreograph", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
  try {
    const plan = await choreographCameras(
      join(job.workspace, "presentation"),
      `http://127.0.0.1:${config.port}/preview/${job.id}/`,
      { density: meta.camera?.density || "dense", avatarEnabled: Boolean(meta.avatar?.enabled) },
    );
    await buildPresentation(job);
    logEvent(job.id, "quality", `手动镜头编排完成：${Object.entries(plan.stats).map(([k, v]) => `${k}×${v}`).join(" ")}`);
    res.json({ ok: true, ...plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.post("/jobs/:id/render", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  if (renderingJobs.has(job.id)) return res.status(409).json({ error: "本作品正在渲染中" });
  renderingJobs.add(job.id);
  res.json({ ok: true, started: true }); // 立即返回；进度走 render 阶段的 job_events
  renderJob(job)
    .then((r) => logEvent(job.id, "render", r.note))
    .catch((err) => logEvent(job.id, "render", `服务端渲染失败：${err.message}`, "error"))
    .finally(() => renderingJobs.delete(job.id));
});

api.get("/jobs/:id/output", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const output = join(job.workspace, "output.mp4");
  if (!existsSync(output)) return res.status(404).json({ error: "尚未生成成片" });
  res.download(output, `videoforge-${job.id}.mp4`);
});
