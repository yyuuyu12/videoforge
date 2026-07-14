import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { logEvent, recordUsage } from "./db.js";
import { loadSettings } from "./settings.js";

let running = 0;
const queue = [];

/**
 * server 进程退出（含 node --watch 因改代码而重启）时，把所有在跑的
 * agent 子进程整树杀掉——否则它们变成孤儿继续写同一个 workspace，
 * 而重启后的 server 又会 resume 该任务再起一个 agent，两个 agent
 * 并发写同一份文件（job-2 实测踩过：一个 stage 连开 3 个孤儿 agent）。
 */
const liveChildren = new Set();

function reportProgress(jobId, stage, onProgress, percent, message) {
  onProgress(percent, message);
  logEvent(jobId, stage, `progress|${Math.max(0, Math.min(100, Math.round(percent)))}|${message}`);
}
function reapAll() {
  for (const pid of liveChildren) killTree(pid);
  liveChildren.clear();
}
process.on("exit", reapAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    reapAll();
    process.exit(0);
  });
}

/**
 * Headless `claude -p` in an UNTRUSTED directory silently ignores all
 * permission rules ("this workspace has not been trusted") — which is why
 * pipeline agents spawned in freshly created workspaces/job-N dirs failed
 * with empty output. The CLI's own suggested fix: mark the project trusted
 * in ~/.claude.json. Do that idempotently before every spawn.
 */
export function ensureWorkspaceTrusted(cwd) {
  try {
    const p = join(homedir(), ".claude.json");
    const j = JSON.parse(readFileSync(p, "utf8"));
    const key = cwd.replace(/\\/g, "/");
    j.projects ??= {};
    if (!j.projects[key]?.hasTrustDialogAccepted) {
      j.projects[key] = { ...(j.projects[key] ?? {}), hasTrustDialogAccepted: true };
      writeFileSync(p, JSON.stringify(j, null, 2));
    }
    return true;
  } catch (err) {
    console.warn(`ensureWorkspaceTrusted failed (${err.message}) — agent may run with restricted tools`);
    return false;
  }
}

/**
 * Run a headless agent in a workspace directory. Personal-use mode rides the
 * local Claude Code login（订阅），无需 API key。主路径是 Claude Agent SDK
 * （官方契约、无信任对话框、权限一等公民）；SDK 不可用/启动失败时回退
 * `claude -p`。并发受 config.agent.maxConcurrent 限制（订阅限速）。
 *
 * Returns { ok, output } — output is combined text tail for logging.
 */
export function runAgent({ jobId, stage, cwd, prompt, onProgress = () => {}, usageOperation }) {
  if (loadSettings().llm.mode === "api") {
    return runApiAgent({ jobId, stage, cwd, prompt, onProgress, usageOperation });
  }
  return new Promise((resolve) => {
    const task = async () => {
      running++;
      try {
        resolve(await runSubscriptionAgent({ jobId, stage, cwd, prompt, onProgress, usageOperation }));
      } catch (error) {
        resolve({ ok: false, output: "", note: error.message });
      } finally {
        running--;
        drain();
      }
    };
    if (running < config.agent.maxConcurrent) task();
    else queue.push(task);
  });
}

let sdkModule = null;
let sdkLoadFailed = false;
async function loadAgentSdk() {
  if (sdkModule) return sdkModule;
  if (sdkLoadFailed) return null;
  try {
    sdkModule = await import("@anthropic-ai/claude-agent-sdk");
    return sdkModule;
  } catch (error) {
    sdkLoadFailed = true;
    console.warn(`Agent SDK 不可用（${error.message}）——订阅模式回退 claude -p`);
    return null;
  }
}

async function runSubscriptionAgent(ctx) {
  const sdk = await loadAgentSdk();
  if (!sdk) return runCliAgent(ctx);
  return runSdkAgent(sdk, ctx);
}

async function runSdkAgent(sdk, ctx) {
  const { jobId, stage, cwd, prompt, onProgress = () => {}, usageOperation } = ctx;
  logEvent(jobId, stage, `agent start (sdk, cwd=${cwd})`);
  reportProgress(jobId, stage, onProgress, 22, "模型已启动，正在分析任务");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.agent.timeoutMs);
  const started = Date.now();
  const cap = (s) => (s.length > 20000 ? s.slice(-20000) : s);
  let out = "";
  let result = null;
  let sawMessage = false;
  try {
    for await (const message of sdk.query({
      prompt,
      options: {
        cwd,
        // 与旧 `claude -p --dangerously-skip-permissions` 等价；SDK 没有
        // 信任对话框概念，不再需要改写 ~/.claude.json 内部字段。
        permissionMode: "bypassPermissions",
        // 不加载个人全局/项目配置——产品行为只由仓库内 prompt 决定，可复现。
        settingSources: [],
        abortController: controller,
      },
    })) {
      sawMessage = true;
      if (message.type === "assistant") {
        const inner = message.message ?? message;
        const blocks = Array.isArray(inner.content) ? inner.content : [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) out = cap(`${out}${block.text}\n`);
        }
        const toolNames = blocks.filter((b) => b.type === "tool_use").map((b) => b.name);
        if (toolNames.length) {
          reportProgress(jobId, stage, onProgress, Math.min(78, 30 + Math.floor((Date.now() - started) / 20000) * 8), `正在执行：${toolNames.join("、")}`);
        }
      } else if (message.type === "result") {
        result = message;
      }
    }
    const ok = result ? result.subtype === "success" : true;
    if (!out && typeof result?.result === "string") out = cap(result.result);
    reportProgress(jobId, stage, onProgress, ok ? 88 : 100, ok ? "模型任务完成，正在整理结果" : "模型执行失败，正在整理错误信息");
    recordUsage({
      service: "llm",
      operation: usageOperation || `agent:${stage}`,
      jobId,
      status: ok ? "success" : "failed",
      inputTokens: result?.usage?.input_tokens ?? Math.ceil(String(prompt).length / 2),
      outputTokens: result?.usage?.output_tokens ?? Math.ceil(out.length / 2),
      durationMs: Date.now() - started,
      estimated: !result?.usage,
      detail: `subscription/agent-sdk${result?.total_cost_usd != null ? ` $${Number(result.total_cost_usd).toFixed(4)}` : ""}`,
    });
    logEvent(
      jobId,
      stage,
      ok
        ? `agent done (sdk)\n--- tail ---\n${out.slice(-1500)}`
        : `agent failed (sdk): ${result?.subtype ?? "unknown"}\n--- tail ---\n${out.slice(-1500)}`,
      ok ? "info" : "error",
    );
    return { ok, output: out };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    if (!sawMessage && !timedOut) {
      // SDK 一条消息都没吐就挂了（如捆绑二进制缺失）——回退 CLI 路径。
      logEvent(jobId, stage, `SDK 启动失败（${error.message}），回退 claude -p`, "error");
      return runCliAgent(ctx);
    }
    const note = timedOut ? `agent 超时（${Math.round(config.agent.timeoutMs / 60000)} 分钟上限）` : error.message;
    recordUsage({ service: "llm", operation: usageOperation || `agent:${stage}`, jobId, status: "failed", durationMs: Date.now() - started, detail: `subscription/agent-sdk: ${note}` });
    logEvent(jobId, stage, `agent failed (sdk): ${note}\n--- tail ---\n${out.slice(-1500)}`, "error");
    return { ok: false, output: out, note };
  } finally {
    clearTimeout(timer);
  }
}

/** 兜底路径：spawn `claude -p`。仅在 Agent SDK 不可用时使用。 */
function runCliAgent({ jobId, stage, cwd, prompt, onProgress = () => {}, usageOperation }) {
  return new Promise((resolve) => {
    const trusted = ensureWorkspaceTrusted(cwd);
    logEvent(jobId, stage, `agent start (cli, cwd=${cwd}, trusted=${trusted})`);
    reportProgress(jobId, stage, onProgress, 22, "模型已启动，正在分析任务");

    const child = spawn(config.agent.command, config.agent.args, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    liveChildren.add(child.pid);
    let out = "";
    let err = "";
    const cap = (s) => (s.length > 20000 ? s.slice(-20000) : s);
    child.stdout.on("data", (d) => (out = cap(out + d)));
    child.stderr.on("data", (d) => (err = cap(err + d)));

    const timer = setTimeout(() => {
      logEvent(jobId, stage, "agent timeout — killing", "error");
      killTree(child.pid);
    }, config.agent.timeoutMs);
    const progressSteps = [
      [34, "正在定位需要调整的内容"],
      [48, "正在修改相关文件"],
      [62, "正在整理修改结果"],
      [74, "正在执行完整性检查"],
    ];
    let progressIndex = 0;
    const progressTimer = setInterval(() => {
      const step = progressSteps[Math.min(progressIndex, progressSteps.length - 1)];
      reportProgress(jobId, stage, onProgress, step[0], step[1]);
      progressIndex++;
    }, 6000);

    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      liveChildren.delete(child.pid);
      const ok = code === 0;
      reportProgress(jobId, stage, onProgress, ok ? 88 : 100, ok ? "模型任务完成，正在整理结果" : "模型执行失败，正在整理错误信息");
      recordUsage({
        service: "llm",
        operation: usageOperation || `agent:${stage}`,
        jobId,
        status: ok ? "success" : "failed",
        inputTokens: Math.ceil(String(prompt).length / 2),
        outputTokens: Math.ceil(String(out).length / 2),
        estimated: true,
        detail: "subscription/claude-cli",
      });
      logEvent(
        jobId,
        stage,
        ok
          ? `agent done\n--- tail ---\n${out.slice(-1500)}`
          : `agent exit ${code}\n--- stderr ---\n${err.slice(-1500)}\n--- stdout ---\n${out.slice(-1500)}`,
        ok ? "info" : "error",
      );
      resolve({ ok, output: out });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const API_TOOLS = [
  { type: "function", function: { name: "read_file", description: "读取工作区内的 UTF-8 文本文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "创建或覆盖工作区内的 UTF-8 文本文件", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_files", description: "列出工作区目录中的文件和子目录", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "run_command", description: "在工作区中运行必要的项目命令，例如 npm install、tsc 或构建检查", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

async function runApiAgent({ jobId, stage, cwd, prompt, onProgress = () => {}, usageOperation }) {
  const { llm } = loadSettings();
  logEvent(jobId, stage, `API agent start (${llm.provider}/${llm.model})`);
  try {
    const messages = [
      { role: "system", content: "你是 VideoForge 的代码与内容制作代理。只能操作当前工作区。必须实际调用工具完成任务并进行检查，不要只给建议。" },
      { role: "user", content: prompt },
    ];
    reportProgress(jobId, stage, onProgress, 22, "模型已连接，正在分析任务");
    for (let turn = 0; turn < 40; turn++) {
      const started = Date.now();
      let response;
      let responseText = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${llm.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: llm.model, messages, tools: API_TOOLS, tool_choice: "auto", max_tokens: 8192 }),
          signal: AbortSignal.timeout(180000),
        });
        responseText = await response.text();
        if (response.status < 500 || attempt === 2) break;
        const waitMs = 1500 * (attempt + 1);
        reportProgress(jobId, stage, onProgress, Math.min(76, 28 + turn * 4), `上游暂时不可用，正在第 ${attempt + 2}/3 次重试`);
        logEvent(jobId, stage, `upstream HTTP ${response.status}; retry ${attempt + 2}/3`, "error");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      let data;
      let responseParseError = "";
      try {
        data = JSON.parse(responseText);
      } catch {
        data = {};
        responseParseError = `上游返回非 JSON 响应（HTTP ${response.status}）：${responseText.replace(/\s+/g, " ").slice(0, 180)}`;
      }
      recordUsage({
        service: "llm",
        operation: usageOperation || `agent:${stage}`,
        jobId,
        status: response.ok && !responseParseError ? "success" : "failed",
        inputTokens: data.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(messages).length / 2),
        outputTokens: data.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - started,
        estimated: !data.usage,
        detail: `${llm.provider}/${llm.model}`,
      });
      if (responseParseError) throw new Error(responseParseError);
      if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("模型没有返回消息");
      messages.push(message);
      const calls = message.tool_calls ?? [];
      if (!calls.length) {
        reportProgress(jobId, stage, onProgress, 88, "模型任务完成，正在整理结果");
        logEvent(jobId, stage, `API agent done\n--- tail ---\n${String(message.content ?? "").slice(-1500)}`);
        return { ok: true, output: String(message.content ?? "") };
      }
      const toolNames = calls.map((call) => call.function.name).join("、");
      reportProgress(jobId, stage, onProgress, Math.min(78, 30 + turn * 4), `正在执行：${toolNames}`);
      for (const call of calls) {
        let result;
        try {
          result = await executeApiTool(cwd, call.function.name, JSON.parse(call.function.arguments || "{}"));
        } catch (error) {
          result = `ERROR: ${error.message}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(result).slice(-20000) });
      }
    }
    throw new Error("API agent 超过最大工具调用轮数");
  } catch (error) {
    logEvent(jobId, stage, `API agent failed: ${error.message}`, "error");
    return { ok: false, output: "", note: error.message };
  }
}

async function executeApiTool(cwd, name, args) {
  const { readFile, writeFile, readdir, mkdir } = await import("node:fs/promises");
  const { resolve, dirname, relative } = await import("node:path");
  const safePath = (value = ".") => {
    const full = resolve(cwd, value);
    const rel = relative(resolve(cwd), full);
    if (rel.startsWith("..") || rel.includes(":")) throw new Error("路径超出工作区");
    return full;
  };
  if (name === "read_file") return readFile(safePath(args.path), "utf8");
  if (name === "write_file") {
    const path = safePath(args.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, args.content, "utf8");
    return `已写入 ${args.path}`;
  }
  if (name === "list_files") {
    const entries = await readdir(safePath(args.path), { withFileTypes: true });
    return entries.map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`).join("\n");
  }
  if (name === "run_command") return runWorkspaceCommand(args.command, cwd);
  throw new Error(`未知工具 ${name}`);
}

function runWorkspaceCommand(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let output = "";
    const append = (data) => { output = (output + data).slice(-20000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => killTree(child.pid), 10 * 60 * 1000);
    child.on("close", (code) => { clearTimeout(timer); resolve(`exit ${code}\n${output}`); });
  });
}

function drain() {
  if (queue.length > 0 && running < config.agent.maxConcurrent) {
    queue.shift()();
  }
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}
