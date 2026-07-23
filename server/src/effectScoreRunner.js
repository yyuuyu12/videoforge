import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, config } from "./config.js";

/**
 * 把 effectScore.mjs（独立 CLI）作为子进程跑起来并解析打分卡——让"博主质感"
 * 维度（fx密度/强效果占比/平淡游程/切字）进入管线闭环，不再是手动工具。
 * 它自己起无头浏览器逐步走查真实渲染，因此需要预览已构建、server 在跑。
 * 返回 { ok, card } 或 { ok:false, note }。
 */
// 在跑的打分子进程（jobId → child）：用户点"跳过"时立即终止
const running = new Map();

/** 用户主动跳过：杀掉在跑的打分器；pipeline 端配合 meta.skipEffectScore 放行。 */
export function skipEffectScore(jobId) {
  const child = running.get(Number(jobId));
  if (!child) return false;
  try { child.kill(); } catch {}
  return true;
}

export function runEffectScore(jobId, { port = config.port, timeoutMs = 180000, onProgress } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [join(ROOT, "server", "src", "effectScore.mjs"), String(jobId), `http://127.0.0.1:${port}`],
      { cwd: ROOT },
    );
    running.set(Number(jobId), proc);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, note: `effectScore 超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => {
      const text = d.toString();
      err += text;
      const m = text.match(/PROGRESS (\d+)\/(\d+)/);
      if (m && onProgress) { try { onProgress(Number(m[1]), Number(m[2])); } catch {} }
    });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, note: e.message }); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      running.delete(Number(jobId));
      if (code !== 0) return resolve({ ok: false, note: (err.trim().slice(-400)) || `effectScore 退出码 ${code}` });
      const line = out.trim().split("\n").filter(Boolean).pop();
      try {
        resolve({ ok: true, card: JSON.parse(line) });
      } catch {
        resolve({ ok: false, note: `effectScore 输出解析失败：${(line || "").slice(0, 120)}` });
      }
    });
  });
}
