import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DATA_ROOT } from "./config.js";

export const db = new DatabaseSync(join(DATA_ROOT, "data.db"));

// Workers poll and write the same local database while the dashboard reads it.
// WAL lets readers continue during writes; busy_timeout absorbs short-lived
// contention instead of surfacing SQLITE_BUSY to an otherwise healthy request.
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'rss',
  url TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER,
  title TEXT NOT NULL,
  url TEXT UNIQUE,
  summary TEXT,
  content TEXT,
  score REAL,
  status TEXT NOT NULL DEFAULT 'new',
  fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER,
  title TEXT,
  workspace TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'script_outline',
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  meta TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  stage TEXT,
  level TEXT DEFAULT 'info',
  message TEXT,
  ts TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  chapter TEXT,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapter_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  chapter_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'review',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(job_id, chapter_key)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  job_id INTEGER,
  status TEXT NOT NULL DEFAULT 'success',
  requests INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 0,
  unit TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS douyin_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  input_url TEXT NOT NULL,
  aweme_id TEXT,
  title TEXT,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  stage TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  via TEXT,
  duration_seconds INTEGER,
  chars INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  article_id INTEGER,
  job_id INTEGER,
  steps TEXT DEFAULT '[]',
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

const extractionColumns = db.prepare("PRAGMA table_info(douyin_extractions)").all().map((column) => column.name);
if (!extractionColumns.includes("job_id")) db.exec("ALTER TABLE douyin_extractions ADD COLUMN job_id INTEGER");

const jobColumns = db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
if (!jobColumns.includes("error")) db.exec("ALTER TABLE jobs ADD COLUMN error TEXT");

// 2026-07-15：avatar_gen 拆分为 avatar_media + avatar_wire——在途作品平移到媒体段
db.exec("UPDATE jobs SET stage = 'avatar_media' WHERE stage = 'avatar_gen'");

const feedbackColumns = db.prepare("PRAGMA table_info(feedback)").all().map((column) => column.name);
if (!feedbackColumns.includes("progress")) db.exec("ALTER TABLE feedback ADD COLUMN progress INTEGER NOT NULL DEFAULT 0");
if (!feedbackColumns.includes("progress_message")) db.exec("ALTER TABLE feedback ADD COLUMN progress_message TEXT");
if (!feedbackColumns.includes("error")) db.exec("ALTER TABLE feedback ADD COLUMN error TEXT");
if (!feedbackColumns.includes("result")) db.exec("ALTER TABLE feedback ADD COLUMN result TEXT");
if (!feedbackColumns.includes("phase")) db.exec("ALTER TABLE feedback ADD COLUMN phase TEXT");
if (!feedbackColumns.includes("attachment_path")) db.exec("ALTER TABLE feedback ADD COLUMN attachment_path TEXT");
if (!feedbackColumns.includes("attachment_mime")) db.exec("ALTER TABLE feedback ADD COLUMN attachment_mime TEXT");

// Hot paths: worker queue selection, job detail/event feeds, feedback polling,
// usage pagination, and Douyin extraction history.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_events_job_ts ON job_events(job_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_job_created ON feedback(job_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_douyin_status_updated ON douyin_extractions(status, updated_at DESC);
`);

// ---- tiny helpers ---------------------------------------------------------

export function logEvent(jobId, stage, message, level = "info") {
  db.prepare(
    "INSERT INTO job_events (job_id, stage, level, message) VALUES (?, ?, ?, ?)",
  ).run(jobId, stage, level, String(message).slice(0, 4000));
}

export function updateJob(jobId, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(jobId);
  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function getJob(jobId) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
}

export function recordUsage({
  service,
  operation,
  jobId = null,
  status = "success",
  requests = 1,
  inputTokens = 0,
  outputTokens = 0,
  units = 0,
  unit = null,
  durationMs = 0,
  estimated = false,
  detail = null,
}) {
  db.prepare(`
    INSERT INTO usage_events
      (service, operation, job_id, status, requests, input_tokens, output_tokens, units, unit, duration_ms, estimated, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    service,
    operation,
    jobId,
    status,
    Math.max(0, Number(requests) || 0),
    Math.max(0, Math.round(Number(inputTokens) || 0)),
    Math.max(0, Math.round(Number(outputTokens) || 0)),
    Math.max(0, Number(units) || 0),
    unit,
    Math.max(0, Math.round(Number(durationMs) || 0)),
    estimated ? 1 : 0,
    detail ? String(detail).slice(0, 500) : null,
  );
}
