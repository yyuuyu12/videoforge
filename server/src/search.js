import { spawn } from "node:child_process";
import { config } from "./config.js";
import { loadSettings, saveSettings } from "./settings.js";
import { ensureWorkspaceTrusted } from "./agentRunner.js";
import { ROOT } from "./config.js";

/**
 * 联网搜索选题 —— 不依赖 RSS 订阅源。两条路：
 *   订阅模式：spawn `claude -p --allowedTools WebSearch WebFetch`（只放行联网
 *            只读工具，不用 dangerously-skip-permissions）
 *   API 模式：Anthropic Messages API 的 web_search server tool
 *            （openai-compatible 供应商没有可移植的搜索工具 → 明确报错，
 *              引导用户用抖音提取或 RSS）
 * 产出统一为 [{title, url, summary}]，由调用方入库 articles。
 */

const PROMPT = (directions) =>
  [
    `联网搜索下面这些方向最近 7 天内适合做成中文讲解视频的热点文章/事件，`,
    `方向：${directions}`,
    ``,
    `要求：`,
    `- 找 5-8 条，优先有完整正文的文章（不是纯新闻快讯）`,
    `- 中文内容优先，英文内容也可以（之后会翻译改写）`,
    `- 每条给出真实可访问的 URL`,
    ``,
    `输出格式（严格遵守）：JSONL —— 每行一个独立的 JSON 对象，不要数组、不要代码块、不要其他文字：`,
    `{"title": "...", "url": "https://...", "summary": "两句话说明这条为什么适合做视频"}`,
    `注意：title/summary 内部禁止出现英文双引号字符，需要引用时用中文引号「」。`,
  ].join("\n");

export async function searchTopics(directions) {
  const dirs = (directions || loadSettings().search.directions || "").trim();
  if (!dirs) throw new Error("请先填写选题方向关键词");
  saveSettings({ search: { directions: dirs } }); // 记住上次用的方向

  const { llm } = loadSettings();
  const raw =
    llm.mode === "api" && llm.provider === "anthropic"
      ? await searchViaAnthropic(llm, dirs)
      : llm.mode === "api"
        ? (() => {
            throw new Error(
              "当前 OpenAI 兼容供应商不支持联网搜索 —— 可切换 Anthropic API/订阅模式，或改用抖音提取、RSS 订阅",
            );
          })()
        : await searchViaClaude(dirs);

  return parseResults(raw);
}

function parseResults(raw) {
  // JSONL 逐行解析，坏行跳过（模型偶发在字符串里塞未转义引号，
  // 一行坏不应拖垮整批——这是实测踩过的坑，别改回整体 JSON.parse）。
  const items = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim().replace(/^```(json)?|```$/g, "").trim();
    if (!t.startsWith("{")) continue;
    try {
      const x = JSON.parse(t);
      if (x?.title && x?.url) items.push(x);
    } catch {
      /* skip malformed line */
    }
  }
  // 兜底：模型没按 JSONL 来，试整体数组
  if (items.length === 0) {
    const m = String(raw).match(/\[[\s\S]*\]/);
    if (m) {
      try {
        for (const x of JSON.parse(m[0])) if (x?.title && x?.url) items.push(x);
      } catch {
        /* fallthrough */
      }
    }
  }
  if (items.length === 0)
    throw new Error(`搜索结果解析失败：${String(raw).slice(0, 200)}`);
  return items.map((x) => ({
    title: String(x.title).slice(0, 200),
    url: String(x.url),
    summary: String(x.summary ?? "").slice(0, 500),
  }));
}

// ---- 订阅模式：claude -p，只放行联网只读工具 -----------------------------------

function searchViaClaude(directions) {
  ensureWorkspaceTrusted(ROOT);
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.agent.command,
      ["-p", "--allowedTools", "WebSearch", "WebFetch", "--output-format", "text"],
      { cwd: ROOT, shell: true, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("搜索超时（300s）"));
    }, 300000);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(out)
        : reject(new Error(`claude 搜索失败 exit ${code}: ${(err || out).slice(-300)}`));
    });
    child.stdin.write(PROMPT(directions));
    child.stdin.end();
  });
}

// ---- API 模式：Anthropic web_search server tool --------------------------------

async function searchViaAnthropic(llm, directions) {
  if (!llm.apiKey) throw new Error("未配置 Anthropic API key");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": llm.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: llm.model || "claude-sonnet-5",
      max_tokens: 2048,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: PROMPT(directions) }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}
