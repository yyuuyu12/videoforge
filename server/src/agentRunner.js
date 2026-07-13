import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { logEvent } from "./db.js";
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
 * Run a headless agent (claude -p) in a workspace directory, prompt via
 * stdin. Personal-use mode: rides the local Claude Code login, no API key.
 * Concurrency-capped (config.agent.maxConcurrent) so parallel jobs don't
 * trample the subscription rate limit.
 *
 * Returns { ok, output } — output is combined stdout tail for logging.
 */
export function runAgent({ jobId, stage, cwd, prompt }) {
  if (loadSettings().llm.mode === "api") {
    return runApiAgent({ jobId, stage, cwd, prompt });
  }
  return new Promise((resolve) => {
    const task = () => {
      running++;
      const trusted = ensureWorkspaceTrusted(cwd);
      logEvent(jobId, stage, `agent start (cwd=${cwd}, trusted=${trusted})`);

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

      child.on("close", (code) => {
        clearTimeout(timer);
        liveChildren.delete(child.pid);
        running--;
        drain();
        const ok = code === 0;
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
    };

    if (running < config.agent.maxConcurrent) task();
    else queue.push(task);
  });
}

const API_TOOLS = [
  { type: "function", function: { name: "read_file", description: "读取工作区内的 UTF-8 文本文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "创建或覆盖工作区内的 UTF-8 文本文件", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_files", description: "列出工作区目录中的文件和子目录", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "run_command", description: "在工作区中运行必要的项目命令，例如 npm install、tsc 或构建检查", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

async function runApiAgent({ jobId, stage, cwd, prompt }) {
  const { llm } = loadSettings();
  logEvent(jobId, stage, `API agent start (${llm.provider}/${llm.model})`);
  try {
    const messages = [
      { role: "system", content: "你是 VideoForge 的代码与内容制作代理。只能操作当前工作区。必须实际调用工具完成任务并进行检查，不要只给建议。" },
      { role: "user", content: prompt },
    ];
    for (let turn = 0; turn < 40; turn++) {
      const response = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${llm.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: llm.model, messages, tools: API_TOOLS, tool_choice: "auto", max_tokens: 8192 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error("模型没有返回消息");
      messages.push(message);
      const calls = message.tool_calls ?? [];
      if (!calls.length) {
        logEvent(jobId, stage, `API agent done\n--- tail ---\n${String(message.content ?? "").slice(-1500)}`);
        return { ok: true, output: String(message.content ?? "") };
      }
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
