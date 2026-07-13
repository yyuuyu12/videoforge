import { spawn } from "node:child_process";
import { config } from "./config.js";
import { loadSettings } from "./settings.js";
import { recordUsage } from "./db.js";

/**
 * LLM provider adapter — PRODUCT-PLAN §二.
 *
 * Three modes:
 *   subscription      — spawn local `claude -p` (v1 path, needs a logged-in
 *                       Claude Code; agentRunner.js keeps owning the heavy
 *                       agentic stages in this mode)
 *   anthropic         — direct Messages API with the user's key
 *   openai-compatible — /chat/completions against any OpenAI-shaped endpoint
 *                       (DeepSeek / Kimi / GLM / 通义 …)
 *
 * `complete()` is the small-completion primitive (scoring, rewriting a
 * paragraph, …). Full agentic chapter generation over the API belongs to a
 * later milestone — see PRODUCT-PLAN M1 notes.
 */

export async function complete({ prompt, system, maxTokens = 1024 }) {
  const { llm } = loadSettings();
  const started = Date.now();
  const inputEstimate = Math.ceil(`${system || ""}\n${prompt || ""}`.length / 2);
  try {
    const result = llm.mode === "subscription"
      ? { text: await completeViaClaude(prompt, system), usage: null }
      : llm.provider === "anthropic"
        ? await completeViaAnthropic(llm, prompt, system, maxTokens)
        : await completeViaOpenAI(llm, prompt, system, maxTokens);
    recordUsage({
      service: "llm",
      operation: "completion",
      inputTokens: result.usage?.inputTokens ?? inputEstimate,
      outputTokens: result.usage?.outputTokens ?? Math.ceil(String(result.text).length / 2),
      durationMs: Date.now() - started,
      estimated: !result.usage,
      detail: `${llm.mode}/${llm.provider || "claude"}/${llm.model || "default"}`,
    });
    return result.text;
  } catch (error) {
    recordUsage({ service: "llm", operation: "completion", status: "failed", inputTokens: inputEstimate, durationMs: Date.now() - started, estimated: true, detail: error.message });
    throw error;
  }
}

/** Cheap end-to-end check of whatever the user configured. */
export async function testLlmConnection() {
  const { llm } = loadSettings();
  const started = Date.now();
  try {
    if (llm.mode === "subscription") {
      const version = await claudeVersion();
      return { ok: true, mode: "subscription", detail: version, ms: Date.now() - started };
    }
    const text = await complete({ prompt: "只回复：ok", maxTokens: 8 });
    return {
      ok: true,
      mode: `api/${llm.provider}`,
      detail: `${llm.model} → ${String(text).trim().slice(0, 40)}`,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: err.message, ms: Date.now() - started };
  }
}

// ---- anthropic --------------------------------------------------------------

async function completeViaAnthropic(llm, prompt, system, maxTokens) {
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
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  return {
    text: data.content?.map((b) => b.text ?? "").join("") ?? "",
    usage: data.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } : null,
  };
}

// ---- openai-compatible ------------------------------------------------------

async function completeViaOpenAI(llm, prompt, system, maxTokens) {
  if (!llm.apiKey) throw new Error("未配置 API key");
  if (!llm.baseUrl) throw new Error("openai-compatible 模式需要填 Base URL");
  const url = `${llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${llm.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: llm.model, max_tokens: maxTokens, messages }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : null,
  };
}

// ---- subscription (local claude) --------------------------------------------

function completeViaClaude(prompt, system) {
  const full = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  return new Promise((resolve, reject) => {
    const child = spawn(config.agent.command, config.agent.args, {
      shell: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("claude -p 超时(120s)"));
    }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(err.slice(-400) || `exit ${code}`));
    });
    child.stdin.write(full);
    child.stdin.end();
  });
}

function claudeVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(config.agent.command, ["--version"], { shell: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("claude --version 超时 — 本机可能未安装/未登录 Claude Code"));
    }, 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(out.trim())
        : reject(new Error("claude 命令不可用 — 订阅模式需要本机已安装并登录 Claude Code"));
    });
  });
}
