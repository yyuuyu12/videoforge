import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * 依赖服务一键启停（用户拍板 2026-07-16：不开机自启，工作台按钮控制）。
 *
 * 启动 = 复用机器既有的 startup.ps1（HeyGem/ASR/IndexTTS/frpc 全套，
 * 已在跑的会自动跳过）；停止 = 按监听端口定位进程逐个结束 + frpc 按名结束。
 * 脚本路径可用 VIDEOFORGE_SERVICES_SCRIPT 覆盖（便携包装到别的机器时配置）。
 */

const STARTUP_SCRIPT = process.env.VIDEOFORGE_SERVICES_SCRIPT
  || "C:\\AIClaudecode\\local_asr_server\\startup.ps1";

// 停止时按端口清点的服务（5401 是 VideoForge 自身，绝不能进这张表）
const SERVICE_PORTS = [
  { port: 7861, label: "HeyGem" },
  { port: 8765, label: "ASR" },
  { port: 8766, label: "IndexTTS" },
];

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || "") });
    });
  });
}

/** 用户级环境变量（setx 写入注册表；本进程可能早于 setx 启动，读不到就查注册表）。 */
async function userEnv(name) {
  if (process.env[name]) return process.env[name];
  const r = await run("reg", ["query", "HKCU\\Environment", "/v", name]);
  const match = r.stdout.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`));
  return match ? match[1].trim() : "";
}

export async function startServices() {
  if (!existsSync(STARTUP_SCRIPT)) {
    return { ok: false, note: `服务启动脚本不存在：${STARTUP_SCRIPT}（本按钮仅在部署了模型服务的主机可用）` };
  }
  // HeyGem 鉴权 token 必须传给子进程：本 server 可能在 setx 之前启动，
  // 环境里没有它——漏传会导致 HeyGem 以"无鉴权"模式起来（隧道裸奔）。
  const token = await userEnv("HEYGEM_TOKEN");
  const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", STARTUP_SCRIPT], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...(token ? { HEYGEM_TOKEN: token } : {}) },
  });
  child.unref();
  return { ok: true, note: "启动脚本已在后台执行；HeyGem 模型加载约 60-90 秒，状态灯变绿即可用" };
}

async function pidsListeningOn(port) {
  const r = await run("netstat", ["-ano", "-p", "TCP"]);
  const pids = new Set();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}

export async function stopServices() {
  const stopped = [];
  for (const { port, label } of SERVICE_PORTS) {
    for (const pid of await pidsListeningOn(port)) {
      if (pid <= 4 || pid === process.pid) continue;
      const r = await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
      if (r.ok) stopped.push(`${label}(:${port})`);
    }
  }
  const frpc = await run("taskkill", ["/IM", "frpc.exe", "/F"]);
  if (frpc.ok) stopped.push("frpc 隧道");
  return {
    ok: true,
    stopped,
    note: stopped.length ? `已停止：${stopped.join("、")}` : "没有发现在运行的服务",
  };
}

/** frpc 进程存在性（给状态面板；它不是 HTTP 服务，只能查进程）。 */
export async function frpcRunning() {
  const r = await run("tasklist", ["/FI", "IMAGENAME eq frpc.exe", "/FO", "CSV", "/NH"]);
  return /frpc\.exe/i.test(r.stdout);
}
