import { spawn } from "node:child_process";
import { getJob, logEvent, updateJob } from "./db.js";

/**
 * 作业取消（核心版）：混合信号方案。
 *   - DB status = 'cancelling' → 'cancelled'：持久真相源，跨异步边界存活、
 *     UI 可见、避开重启 resume（只碰 running）与 tick（只捡 queued）。
 *   - 内存句柄登记表：把"正在飞"的 AbortController 与子进程 pid 按 jobId 收集，
 *     取消时立即 abort/kill，无需等阶段自然结束。真句柄散在 agent/stages 各处，
 *     光靠 DB 旗标停不下正在烧钱的模型调用与 TTS 子进程。
 * 协作式检查点（isCancelling/throwIfCancelled）在各长循环里被调用，秒级停车。
 */

const registry = new Map(); // jobId -> { controllers:Set<AbortController>, pids:Set<number> }
const cancelling = new Set(); // 内存快旗标，避免每个循环点都读 DB

function slot(jobId) {
  let s = registry.get(jobId);
  if (!s) { s = { controllers: new Set(), pids: new Set() }; registry.set(jobId, s); }
  return s;
}

/** 登记一个可中止的 AbortController；返回注销函数。 */
export function registerAbort(jobId, controller) {
  if (jobId == null || !controller) return () => {};
  slot(jobId).controllers.add(controller);
  return () => { registry.get(jobId)?.controllers.delete(controller); };
}

/** 登记一个在飞子进程 pid；返回注销函数。 */
export function registerChild(jobId, pid) {
  if (jobId == null || !pid) return () => {};
  slot(jobId).pids.add(pid);
  return () => { registry.get(jobId)?.pids.delete(pid); };
}

export function isCancelling(jobId) {
  if (cancelling.has(jobId)) return true;
  try { return ["cancelling", "cancelled"].includes(getJob(jobId)?.status); } catch { return false; }
}

export class CancelledError extends Error {
  constructor() { super("已被用户取消"); this.cancelled = true; }
}

export function throwIfCancelled(jobId) {
  if (isCancelling(jobId)) throw new CancelledError();
}

// 自带进程树杀（不 import agentRunner.killTree，避免 ES 模块循环依赖）。
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: true });
    else process.kill(-pid, "SIGKILL");
  } catch { /* 进程可能已退出 */ }
}

/** 立即中止某 job 的全部在飞工作：abort 所有 controller + 杀所有子进程树。 */
export function cancelInFlight(jobId) {
  const s = registry.get(jobId);
  if (!s) return;
  for (const c of s.controllers) { try { c.abort(); } catch { /* 已中止 */ } }
  for (const pid of s.pids) killPid(pid);
}

/**
 * 取消入口：先写 DB 'cancelling'（协作旗标 + 免 resume），再立即中止在飞工作。
 * 只对 queued/running 有效。返回 {ok, reason?}。
 */
export function requestCancel(jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "not_found" };
  if (!["queued", "running"].includes(job.status)) return { ok: false, reason: "not_running" };
  cancelling.add(jobId);
  updateJob(jobId, { status: "cancelling" });
  logEvent(jobId, job.stage, "用户请求取消：正在停止当前阶段并中止在飞任务（数字人 GPU 任务若已提交将在远端算完，属预期）", "warning");
  cancelInFlight(jobId);
  return { ok: true };
}

/** 阶段收尾后清理内存态（DB 的 cancelled 终态仍由 isCancelling 经 DB 兜底）。 */
export function clearCancel(jobId) {
  cancelling.delete(jobId);
  registry.delete(jobId);
}
