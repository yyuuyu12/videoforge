import { Router } from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export const api = Router();

api.get("/health", (_req, res) => res.json({ ok: true }));
api.get("/meta", (_req, res) => res.json({ stages: STAGES, theme: config.theme }));

// ---- settings（密钥只存本地 settings.local.json，GET 永远打码）---------------

api.get("/settings", (_req, res) => res.json(publicSettings()));

api.put("/settings", (req, res) => {
  // Accept a partial patch; empty-string keys mean "keep existing" so the
  // dashboard can submit the form without re-entering secrets every time.
  const patch = req.body ?? {};
  for (const section of ["llm", "minimax", "heygem"]) {
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
    const ins = db
      .prepare("INSERT OR IGNORE INTO articles (title, url, summary, content) VALUES (?, ?, ?, ?)")
      .run(
        `[抖音] ${r.title}${r.author ? ` @${r.author}` : ""}`,
        r.url,
        `提取方式：${r.via}`,
        r.script,
      );
    res.json({ ok: true, added: ins.changes > 0, via: r.via, chars: r.script.length, title: r.title });
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
  res.json(db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 100").all());
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
  const { chapter, message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "message required" });

  const f = db
    .prepare("INSERT INTO feedback (job_id, chapter, message, status) VALUES (?, ?, ?, 'running')")
    .run(job.id, chapter ?? null, message);
  res.json({ feedbackId: f.lastInsertRowid }); // respond immediately; agent runs async

  const r = await runFeedback(job, { chapter, message });
  db.prepare("UPDATE feedback SET status = ? WHERE id = ?").run(r.ok ? "done" : "failed", f.lastInsertRowid);
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
