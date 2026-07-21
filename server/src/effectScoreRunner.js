import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, config } from "./config.js";

/**
 * 把 effectScore.mjs（独立 CLI）作为子进程跑起来并解析打分卡——让"博主质感"
 * 维度（fx密度/强效果占比/平淡游程/切字）进入管线闭环，不再是手动工具。
 * 它自己起无头浏览器逐步走查真实渲染，因此需要预览已构建、server 在跑。
 * 返回 { ok, card } 或 { ok:false, note }。
 */
export function runEffectScore(jobId, { port = config.port, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [join(ROOT, "server", "src", "effectScore.mjs"), String(jobId), `http://127.0.0.1:${port}`],
      { cwd: ROOT },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, note: `effectScore 超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, note: e.message }); });
    proc.on("close", (code) => {
      clearTimeout(timer);
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
