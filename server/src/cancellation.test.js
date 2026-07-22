import test from "node:test";
import assert from "node:assert/strict";
import { db, getJob } from "./db.js";
import {
  cancelInFlight,
  clearCancel,
  isCancelling,
  registerAbort,
  registerChild,
  requestCancel,
  throwIfCancelled,
} from "./cancellation.js";

function makeJob(status) {
  const row = db
    .prepare("INSERT INTO jobs (article_id, title, workspace, stage, status) VALUES (NULL, 'cancel-test', '', 'chapter_gen', ?)")
    .run(status);
  return Number(row.lastInsertRowid);
}

test("requestCancel 只对 queued/running 生效，其余返回原因", () => {
  assert.deepEqual(requestCancel(9999999), { ok: false, reason: "not_found" });
  const doneJob = makeJob("done");
  assert.deepEqual(requestCancel(doneJob), { ok: false, reason: "not_running" });
});

test("requestCancel 把 running 置为 cancelling 并让 isCancelling 为真", () => {
  const jobId = makeJob("running");
  assert.equal(isCancelling(jobId), false);
  const r = requestCancel(jobId);
  assert.equal(r.ok, true);
  assert.equal(getJob(jobId).status, "cancelling");
  assert.equal(isCancelling(jobId), true);
  assert.throws(() => throwIfCancelled(jobId), /已被用户取消/);
  clearCancel(jobId);
});

test("cancelInFlight 中止已登记的 AbortController，clearCancel 后不再触碰", () => {
  const jobId = makeJob("running");
  const controller = new AbortController();
  registerAbort(jobId, controller);
  let killedPid = null;
  // registerChild 用一个不存在的 pid，仅验证登记/清理不抛（不真的杀进程）
  registerChild(jobId, 0); // pid 0 被 registerChild 视为无效，返回 noop
  assert.equal(controller.signal.aborted, false);
  cancelInFlight(jobId);
  assert.equal(controller.signal.aborted, true);
  clearCancel(jobId);
  // 清理后再 cancelInFlight 是安全的 no-op（registry 已删）
  assert.doesNotThrow(() => cancelInFlight(jobId));
  assert.equal(killedPid, null);
});
