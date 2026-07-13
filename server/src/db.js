import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ROOT } from "./config.js";

export const db = new DatabaseSync(join(ROOT, "data.db"));

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
