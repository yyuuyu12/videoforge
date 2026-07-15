import { useEffect, useMemo, useState } from "react";
import { api, type JobDetail as JD, type StageDef } from "../api";

/** 每个阶段用人话解释：现在在干什么 / 用户需要做什么 */
const STAGE_INFO: Record<string, { doing: string; action?: string }> = {
  script_outline: { doing: "AI 正在把文章改写成口播稿和章节大纲，通常需要 3-8 分钟，页面会自动刷新。" },
  gate_script: {
    doing: "口播稿写好了，等你过目。",
    action: "看一遍下面的稿子——满意就点「稿子没问题，继续」；想改的话直接编辑工作区里的 script.md 再点继续。",
  },
  scaffold: { doing: "正在搭建视频页面的工程骨架（几十秒）。" },
  chapter_gen: { doing: "AI 正在逐章制作视频画面，这是最耗时的阶段（10-30 分钟），可以先去做别的。" },
  gate_chapters: {
    doing: "所有章节画面做好了，等你验收。",
    action: "在下面预览里翻一遍每一章（按空格/方向键翻页）——不满意的地方写进反馈框让 AI 改；满意就点「验收通过，继续配音」。",
  },
  audio_synth: { doing: "正在用你的克隆音色逐段合成配音（几分钟）。" },
  subtitle_cues: { doing: "正在根据配音的逐字时间戳生成精确字幕。" },
  render: { doing: "正在生成录制指引。" },
  done: { doing: "全部完成！按下面的录制指引录屏出片。", action: "启动预览 → 浏览器全屏打开自动播放模式 → 开系统录屏 → 按一次空格，整片自动播完。" },
};

const STATUS_TEXT: Record<JD["status"], string> = {
  queued: "排队中",
  running: "进行中",
  waiting_approval: "等你确认",
  failed: "出错了",
  done: "已完成",
};

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
  const [script, setScript] = useState<string | null>(null);
  const [autoStarted, setAutoStarted] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);

  useEffect(() => {
    const load = () => api.job(jobId).then(setJob).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [jobId]);

  const stageIdx = useMemo(
    () => stages.findIndex((s) => s.id === job?.stage),
    [stages, job?.stage],
  );
  const chapterGenIdx = stages.findIndex((s) => s.id === "chapter_gen");
  const gateChaptersIdx = stages.findIndex((s) => s.id === "gate_chapters");
  // 章节生成开始后工作区里才有可预览、可反馈的页面
  const previewable = job != null && stageIdx >= chapterGenIdx;
  const feedbackable = job != null && stageIdx >= gateChaptersIdx;

  // 稿件审批时自动拉取 script.md 给用户看
  useEffect(() => {
    if (job?.stage === "gate_script" && script === null) {
      api.jobFile(jobId, "script.md").then((r) => setScript(r.content ?? "")).catch(() => {});
    }
  }, [job?.stage, jobId, script]);

  // 可预览且预览没在跑 → 静默自动拉起（失败不打扰用户，还有手动按钮兜底）
  useEffect(() => {
    if (job && previewable && !job.devServer.running && !autoStarted) {
      setAutoStarted(true);
      api.devStart(job.id).then(() => api.job(jobId).then(setJob)).catch(() => {});
    }
  }, [job, previewable, autoStarted, jobId]);

  if (!job) return <div className="muted">加载中…</div>;

  const info = STAGE_INFO[job.stage] ?? { doing: job.stage };
  const lastError = job.events.find((e) => e.level === "error");

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
        <span className={`badge ${job.status}`}>{STATUS_TEXT[job.status]}</span>
      </div>

      {/* ===== 状态主卡：一句话说清现在在干什么、你要做什么 ===== */}
      <div className="card">
        <h3>
          #{job.id} {job.title}
        </h3>
        <div className="stagebar">
          {stages.map((s, i) => (
            <span
              key={s.id}
              className={`stage ${i < stageIdx ? "past" : ""} ${i === stageIdx ? "current" : ""}`}
            >
              {i < stageIdx ? "✓ " : ""}
              {s.label}
            </span>
          ))}
        </div>

        <div className={`statusline ${job.status}`}>
          {job.status === "failed" ? (
            <>
              <p>这一步出错了。常见原因：模型服务没配好（去设置页测试连接）、或临时网络问题——直接重试大多能过。</p>
              {lastError && <pre className="errdetail">{lastError.message.slice(0, 600)}</pre>}
            </>
          ) : (
            <>
              <p>{info.doing}</p>
              {info.action && <p className="actionhint">👉 {info.action}</p>}
            </>
          )}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          {job.status === "waiting_approval" && job.stage === "gate_script" && (
            <button className="primary big" disabled={busy} onClick={() => act(() => api.approve(job.id))}>
              稿子没问题，继续 ▶
            </button>
          )}
          {job.status === "waiting_approval" && job.stage === "gate_chapters" && (
            <button className="primary big" disabled={busy} onClick={() => act(() => api.approve(job.id))}>
              验收通过，继续配音 ▶
            </button>
          )}
          {job.status === "waiting_approval" &&
            !["gate_script", "gate_chapters"].includes(job.stage) &&
            job.stage !== "done" && (
              <button className="primary big" disabled={busy} onClick={() => act(() => api.approve(job.id))}>
                继续下一阶段 ▶
              </button>
            )}
          {job.status === "failed" && (
            <button className="primary big" disabled={busy} onClick={() => act(() => api.retry(job.id))}>
              ↻ 重试这一步
            </button>
          )}
        </div>
        {err && <div style={{ color: "#e05555", marginTop: 8 }}>{err}</div>}
      </div>

      {/* ===== 稿件审批：正文直接摆出来 ===== */}
      {job.stage === "gate_script" && (
        <div className="card">
          <h3>口播稿</h3>
          {script === null ? (
            <div className="muted">读取中…</div>
          ) : script === "" ? (
            <div className="muted">没读到 script.md——看下面日志确认上一步是否真的完成。</div>
          ) : (
            <pre className="scriptview">{script}</pre>
          )}
        </div>
      )}

      {/* ===== 预览：只在有东西可看时出现 ===== */}
      {previewable && (
        <div className="card">
          <div className="row spread">
            <h3>预览</h3>
            <div className="row">
              {!job.devServer.running ? (
                <button disabled={busy} onClick={() => act(() => api.devStart(job.id))}>
                  启动预览
                </button>
              ) : (
                <>
                  <button disabled={busy} onClick={() => act(async () => { await api.devStart(job.id); setPreviewRevision((value) => value + 1); })}>
                    刷新预览
                  </button>
                  <a href={job.devServer.url} target="_blank" rel="noreferrer">
                    新窗口打开
                  </a>
                  <a href={`${job.devServer.url}?auto=1`} target="_blank" rel="noreferrer">
                    自动播放（录屏用）
                  </a>
                </>
              )}
            </div>
          </div>
          {job.devServer.running ? (
            <iframe key={previewRevision} className="preview-frame" src={job.devServer.url} title="preview" />
          ) : (
            <div className="muted">预览启动中…（章节刚生成完第一次启动要装依赖，可能要一两分钟）</div>
          )}
        </div>
      )}

      {/* ===== 反馈调试：只在章节验收后出现 ===== */}
      {feedbackable && (
        <div className="card">
          <h3>不满意？让 AI 改</h3>
          <textarea
            placeholder="用大白话描述要改什么，尽量一次说全。例：第 2 章字太小；第 4 章表格挤在一起；标题都换成大字"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <input
              placeholder="只改某一章？填章节文件夹名（留空 = 整体）"
              style={{ width: 320 }}
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
            />
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
              提交修改
            </button>
          </div>
          {job.feedback.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {job.feedback.map((f) => (
                <div key={f.id} className="muted">
                  [{f.status === "running" ? "改动中…" : f.status === "done" ? "已完成" : "失败"}]{" "}
                  {f.chapter ? `${f.chapter}: ` : ""}
                  {f.message.slice(0, 120)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== 日志：默认收起，排查问题才展开 ===== */}
      <details className="card logfold">
        <summary>运行日志（排查问题用）</summary>
        <div className="log" style={{ marginTop: 10 }}>
          {job.events.map((e) => (
            <div key={e.id} className={`entry ${e.level === "error" ? "err" : ""}`}>
              [{e.ts}] [{e.stage}] {e.message}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
