import { db } from "../db.js";
import { extractDouyin } from "../douyin.js";

let running = false;

function update(id, fields) {
  const entries = Object.entries(fields);
  db.prepare(`UPDATE douyin_extractions SET ${entries.map(([key]) => `${key} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
}

async function processExtraction(row) {
  running = true;
  update(row.id, { status: "running", stage: "link", progress: 2, message: "正在启动提取任务", error: null });
  try {
    const result = await extractDouyin(row.input_url, {
      onProgress: async (event) => update(row.id, {
        stage: event.stage,
        progress: event.progress,
        message: event.message,
        ...(event.awemeId ? { aweme_id: event.awemeId } : {}),
        ...(event.durationSeconds ? { duration_seconds: event.durationSeconds } : {}),
      }),
    });
    if (result.via === "desc-only" || result.script.length < 200) {
      throw new Error(`没有提取到完整口播文案，目前只有 ${result.script.length} 字`);
    }
    const articleTitle = `[抖音] ${result.title}${result.author ? ` @${result.author}` : ""}`;
    const ins = db.prepare("INSERT OR IGNORE INTO articles (title, url, summary, content) VALUES (?, ?, ?, ?)")
      .run(articleTitle, result.url, `提取方式：${result.via}`, result.script);
    if (!ins.changes) {
      db.prepare("UPDATE articles SET title = ?, summary = ?, content = ? WHERE url = ?")
        .run(articleTitle, `提取方式：${result.via}`, result.script, result.url);
    }
    const articleId = Number(ins.changes ? ins.lastInsertRowid : db.prepare("SELECT id FROM articles WHERE url = ?").get(result.url)?.id || 0);
    update(row.id, {
      status: "done",
      stage: "done",
      progress: 100,
      message: `完整文案提取成功 · ${result.script.length} 字`,
      aweme_id: result.awemeId,
      title: result.title,
      author: result.author,
      via: result.via,
      duration_seconds: result.durationSeconds,
      chars: result.script.length,
      content: result.script,
      article_id: articleId,
      steps: JSON.stringify(result.steps),
      error: null,
    });
  } catch (error) {
    update(row.id, { status: "failed", stage: "failed", message: "提取失败，可从历史记录重试", error: error.message });
  } finally {
    running = false;
  }
}

function tick() {
  if (running) return;
  const row = db.prepare("SELECT * FROM douyin_extractions WHERE status = 'queued' ORDER BY id LIMIT 1").get();
  if (row) void processExtraction(row);
}

export function retryExtraction(id) {
  update(id, { status: "queued", stage: "queued", progress: 0, message: "等待重新提取", error: null });
}

export function startExtractionWorker() {
  db.exec("UPDATE douyin_extractions SET status = 'queued', stage = 'queued', message = '服务恢复，等待继续' WHERE status = 'running'");
  setInterval(tick, 1500);
  tick();
}
