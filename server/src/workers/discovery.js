import Parser from "rss-parser";
import { db } from "../db.js";
import { config } from "../config.js";

const parser = new Parser({ timeout: 20000 });

/** Fetch all enabled RSS sources, insert unseen articles (dedup by URL). */
export async function runDiscovery() {
  const sources = db.prepare("SELECT * FROM sources WHERE enabled = 1").all();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO articles (source_id, title, url, summary) VALUES (?, ?, ?, ?)",
  );
  let added = 0;
  const errors = [];
  for (const src of sources) {
    try {
      const feed = await parser.parseURL(src.url);
      for (const item of feed.items ?? []) {
        if (!item.link || !item.title) continue;
        const r = insert.run(
          src.id,
          item.title.trim(),
          item.link,
          (item.contentSnippet ?? item.content ?? "").slice(0, 500),
        );
        added += r.changes;
      }
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  return { added, sources: sources.length, errors };
}

/**
 * Crude readable-text extraction for building article.md at job-creation
 * time. Good enough for v1; the generation agent also gets the URL and can
 * re-fetch if the extraction looks thin.
 */
export async function fetchArticleText(url) {
  const resp = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (videoforge)" },
    signal: AbortSignal.timeout(30000),
  });
  const html = await resp.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

export function startDiscoveryWorker() {
  if (!config.discovery.autoStart) return;
  const ms = Math.max(5, config.discovery.intervalMinutes) * 60 * 1000;
  setInterval(() => {
    runDiscovery().catch(() => {});
  }, ms);
}
