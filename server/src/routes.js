import { Router } from "express";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { config } from "./config.js";
import { db, getJob, logEvent, updateJob } from "./db.js";
import { fetchArticleText, runDiscovery } from "./workers/discovery.js";
import { approveGate, retryJob } from "./workers/pipeline.js";
import { runFeedback, STAGES } from "./stages.js";
import { devServerStatus, startDevServer, stopDevServer } from "./devServers.js";
import { publicSettings, saveSettings } from "./settings.js";
import { testLlmConnection } from "./providers.js";
import { cloneVoice, synthesize, testKey } from "./minimax.js";
import { health as heygemHealth } from "./heygem.js";
import { extractDouyin } from "./douyin.js";
import { searchTopics } from "./search.js";
import { retryExtraction } from "./workers/extractions.js";

export const api = Router();

api.get("/health", (_req, res) => res.json({ ok: true }));
api.get("/meta", (_req, res) => res.json({ stages: STAGES, theme: config.theme }));

function usageCategory(service, operation = "") {
  if (service === "minimax") return "audio";
  if (service === "heygem") return "avatar";
  if (["tikhub", "asr"].includes(service)) return "source";
  if (service !== "llm") return "other";
  if (/chapter_gen|visual-refine/.test(operation)) return "visual";
  if (/script_outline|text-refine|completion/.test(operation)) return "text";
  if (/audio_synth|audio-refine/.test(operation)) return "audio";
  if (/avatar_gen|avatar-refine/.test(operation)) return "avatar";
  if (/subtitle_cues/.test(operation)) return "visual";
  return "other";
}

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

api.put("/settings", (req, res) => {
  // Accept a partial patch; empty-string keys mean "keep existing" so the
  // dashboard can submit the form without re-entering secrets every time.
  const patch = req.body ?? {};
  for (const section of ["llm", "minimax", "heygem", "asr"]) {
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
  meta.avatar = { ...(meta.avatar ?? {}), enabled: true, source: `assets/${saved}`, filename: asset.name, assetId: asset.id };
  updateJob(job.id, { meta: JSON.stringify(meta) });
  res.json({ ok: true });
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

/** 选中 -> create a job + workspace with article.md, queue the pipeline. */
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
    .prepare("INSERT INTO jobs (article_id, title, workspace) VALUES (?, ?, '')")
    .run(article.id, article.title);
  const jobId = Number(jobRow.lastInsertRowid);
  const workspace = join(config.workspacesRoot, `job-${jobId}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, "article.md"),
    `# ${article.title}\n\n${content}\n\n---\n\n来源：${article.url ?? "手动提供"}\n`,
  );
  updateJob(jobId, { workspace, status: "queued" });
  db.prepare("UPDATE articles SET status = 'selected' WHERE id = ?").run(article.id);
  logEvent(jobId, "init", `workspace created: ${workspace}`);
  res.json({ jobId, workspace });
});

// ---- jobs -------------------------------------------------------------------

api.get("/jobs", (_req, res) => {
  res.json(db.prepare(`
    SELECT jobs.*, substr(coalesce(articles.summary, articles.content, ''), 1, 140) AS excerpt
    FROM jobs
    LEFT JOIN articles ON articles.id = jobs.article_id
    ORDER BY jobs.id DESC
    LIMIT 100
  `).all());
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

  stopDevServer(job.id);
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
  const jobRow = db.prepare("INSERT INTO jobs (article_id, title, workspace) VALUES (?, ?, '')").run(article.id, article.title);
  const jobId = Number(jobRow.lastInsertRowid);
  const workspace = join(config.workspacesRoot, `job-${jobId}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "article.md"), `# ${article.title}\n\n${article.content}\n\n---\n\n来源：${article.url ?? "手动提供"}\n`);
  updateJob(jobId, { workspace, status: "queued" });
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
  const feedback = db
    .prepare("SELECT * FROM feedback WHERE job_id = ? ORDER BY id DESC LIMIT 50")
    .all(job.id);
  res.json({ ...job, events, feedback, devServer: devServerStatus(job.id) });
});

api.put("/jobs/:id/options", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.stage !== "gate_style" || job.status !== "waiting_approval") {
    return res.status(409).json({ error: "请先进入“选择风格”步骤，再修改风格或数字人设置" });
  }
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
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
  meta.avatar = { ...(meta.avatar ?? {}), enabled: true, source: `assets/${saved}`, filename };
  updateJob(job.id, { meta: JSON.stringify(meta) });
  res.json({ ok: true, filename });
});

api.post("/jobs/:id/avatar/generate", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  updateJob(job.id, { stage: "avatar_gen", status: "queued" });
  logEvent(job.id, "avatar_gen", "已提交数字人对口型任务");
  res.json({ ok: true });
});

api.get("/jobs/:id/audit", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  let meta = {};
  try { meta = JSON.parse(job.meta || "{}"); } catch {}
  const pres = join(job.workspace, "presentation");
  const chapterRoot = join(pres, "src", "chapters");
  const chapters = readdirSync(chapterRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const layout = chapters.map((entry) => {
    const files = readdirSync(join(chapterRoot, entry.name)).filter((name) => name.endsWith(".css"));
    const content = files.map((name) => readFileSync(join(chapterRoot, entry.name, name), "utf8")).join("\n");
    return {
      chapter: entry.name,
      reserved:
        /padding-right:\s*(6\d\d|7\d\d)px/.test(content) ||
        /grid-template-columns:[^;]*(6\d\d|7\d\d)px/.test(content) ||
        /(?:reserved|presenter|avatar)[^{]*\{[^}]*width:\s*(6\d\d|7\d\d)px/is.test(content),
    };
  });
  const audioRoot = join(pres, "public", "audio");
  const countAudio = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? countAudio(join(dir, entry.name)) : entry.name.endsWith(".mp3") ? 1 : 0), 0);
  const avatarFile = join(pres, "public", "avatar", "lipsync.mp4");
  const sourceExists = Boolean(meta.avatar?.source && existsSync(join(job.workspace, meta.avatar.source)));
  res.json({
    jobId: job.id,
    layout: { ok: layout.every((item) => item.reserved), chapters: layout },
    audio: { ok: existsSync(audioRoot) && countAudio(audioRoot) > 0, segments: existsSync(audioRoot) ? countAudio(audioRoot) : 0 },
    avatar: { enabled: Boolean(meta.avatar?.enabled), sourceExists, outputExists: existsSync(avatarFile), service: await heygemHealth() },
    dialogue: { total: db.prepare("SELECT COUNT(*) AS count FROM feedback WHERE job_id = ?").get(job.id).count },
  });
});

api.get("/jobs/:id/avatar/previews", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const dir = join(job.workspace, "presentation", "public", "avatar", "chapters");
  if (!existsSync(dir)) return res.json([]);
  res.json(readdirSync(dir).filter((name) => name.endsWith(".mp4")).sort().map((name) => ({
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
  res.json({ ok: approveGate(Number(req.params.id)) });
});

api.post("/jobs/:id/retry", (req, res) => {
  res.json({ ok: retryJob(Number(req.params.id), req.body?.stage) });
});

/** 章节调试反馈：spawn a scoped debug agent, then reload preview manually. */
api.post("/jobs/:id/feedback", async (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  const { chapter, message, phase } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message required" });

  const f = db
    .prepare("INSERT INTO feedback (job_id, chapter, message, status, progress, progress_message) VALUES (?, ?, ?, 'running', 5, ?)")
    .run(job.id, chapter ?? null, message, "修改请求已提交，等待模型开始");
  res.json({ feedbackId: f.lastInsertRowid }); // respond immediately; agent runs async

  try {
    const r = await runFeedback(job, {
      chapter,
      message,
      phase,
      onProgress: (progress, progressMessage) => db.prepare(
        "UPDATE feedback SET progress = ?, progress_message = ? WHERE id = ?",
      ).run(Math.max(0, Math.min(100, Math.round(progress))), progressMessage, f.lastInsertRowid),
    });
    const error = r.ok ? null : (r.note || r.output || "模型没有完成修改");
    const result = r.ok
      ? (String(r.output || "").trim().slice(-2400) || "具体修改：模型已完成本次调整。\n修改思路：按照你的反馈做了最小范围修改。\n检查结果：任务执行成功。")
      : null;
    db.prepare("UPDATE feedback SET status = ?, progress = 100, progress_message = ?, error = ?, result = ? WHERE id = ?")
      .run(r.ok ? "done" : "failed", r.ok ? "修改完成，结果已刷新" : "修改未完成", error ? String(error).slice(0, 800) : null, result, f.lastInsertRowid);
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

// ---- per-job preview dev server ----------------------------------------------

api.post("/jobs/:id/devserver/start", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json(startDevServer(job.id, job.workspace));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

api.post("/jobs/:id/devserver/stop", (req, res) => {
  res.json(stopDevServer(Number(req.params.id)));
});
