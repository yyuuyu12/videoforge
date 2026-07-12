import { useEffect, useState } from "react";
import { api, type JobDetail as JD, type StageDef } from "../api";

export function JobDetail({
  jobId,
  stages,
  onBack,
}: {
  jobId: number;
  stages: StageDef[];
  onBack: () => void;
}) {
  const [job, setJob] = useState<JD | null>(null);
  const [chapter, setChapter] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const load = () => api.job(jobId).then(setJob).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [jobId]);

  // 工作区已生成页面但预览没在跑 → 自动拉起，用户不用手动点
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    // scaffold 之前工作区还没有可预览的页面
    const previewable = !["script_outline", "gate_script", "scaffold"].includes(job?.stage ?? "");
    if (job && !job.devServer.running && !autoStarted && previewable) {
      setAutoStarted(true);
      api.devStart(job.id).then(() => api.job(jobId).then(setJob)).catch(() => {});
    }
  }, [job, autoStarted, jobId]);

  if (!job) return <div className="muted">加载中…</div>;

  const stageIdx = stages.findIndex((s) => s.id === job.stage);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      setJob(await api.job(jobId));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="row spread" style={{ marginBottom: 12 }}>
        <button onClick={onBack}>← 返回任务列表</button>
        <span className={`badge ${job.status}`}>{job.status}</span>
      </div>

      <div className="card">
        <h3>
          #{job.id} {job.title}
        </h3>
        <div className="muted">{job.workspace}</div>
        <div className="stagebar">
          {stages.map((s, i) => (
            <span
              key={s.id}
              className={`stage ${i < stageIdx ? "past" : ""} ${i === stageIdx ? "current" : ""}`}
            >
              {s.label}
            </span>
          ))}
        </div>
        <div className="row">
          {job.status === "waiting_approval" && job.stage !== "done" && (
            <button className="primary" disabled={busy} onClick={() => act(() => api.approve(job.id))}>
              审批通过，进入下一阶段
            </button>
          )}
          {job.status === "failed" && (
            <button className="primary" disabled={busy} onClick={() => act(() => api.retry(job.id))}>
              重试当前阶段
            </button>
          )}
        </div>
        {err && <div style={{ color: "#e05555", marginTop: 8 }}>{err}</div>}
      </div>

      <div className="card">
        <div className="row spread">
          <h3>预览</h3>
          <div className="row">
            {!job.devServer.running ? (
              <button disabled={busy} onClick={() => act(() => api.devStart(job.id))}>
                启动预览服务
              </button>
            ) : (
              <>
                <a href={job.devServer.url} target="_blank" rel="noreferrer">
                  新窗口打开
                </a>
                <a href={`${job.devServer.url}?auto=1`} target="_blank" rel="noreferrer">
                  自动播放模式（录屏用）
                </a>
                <button disabled={busy} onClick={() => act(() => api.devStop(job.id))}>
                  停止
                </button>
              </>
            )}
          </div>
        </div>
        {job.devServer.running && (
          <iframe className="preview-frame" src={job.devServer.url} title="preview" />
        )}
      </div>

      <div className="card">
        <h3>章节调试（发给 Agent 的修改反馈）</h3>
        <div className="row" style={{ marginBottom: 8 }}>
          <input
            placeholder="章节文件夹名（可留空 = 全局），如 03-sandbox-approval"
            style={{ width: 340 }}
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
          />
        </div>
        <textarea
          placeholder="反馈内容——尽量一次说全，例：第 2 步字太小、第 4 步表格列挤在一起、把标题换成大字样式"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="primary"
            disabled={busy || !message}
            onClick={() =>
              act(async () => {
                await api.sendFeedback(job.id, chapter || null, message);
                setMessage("");
              })
            }
          >
            提交给 Agent 修改
          </button>
          <span className="muted">修改是异步的——下方日志和反馈状态会更新，改完刷新预览即可看到。</span>
        </div>
        {job.feedback.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {job.feedback.map((f) => (
              <div key={f.id} className="muted">
                [{f.status}] {f.chapter ? `${f.chapter}: ` : ""}
                {f.message.slice(0, 120)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>日志</h3>
        <div className="log">
          {job.events.map((e) => (
            <div key={e.id} className={`entry ${e.level === "error" ? "err" : ""}`}>
              [{e.ts}] [{e.stage}] {e.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
