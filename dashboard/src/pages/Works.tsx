import { useEffect, useState } from "react";
import { api, type Job, type Settings } from "../api";
import { workStatus } from "../lib/statusText";

export function Works({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const [works, setWorks] = useState<Job[]>([]);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Job | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [deleteError, setDeleteError] = useState("");
  useEffect(() => { api.settings().then(setSettings).catch(() => {}); }, []);
  useEffect(() => {
    const load = () => api.jobs().then(setWorks).catch(() => {});
    load();
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, []);

  const removeWork = async (work: Job) => {
    setDeletingId(work.id);
    setDeleteError("");
    try {
      await api.deleteJob(work.id);
      setWorks((current) => current.filter((item) => item.id !== work.id));
      setPendingDelete(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除失败，请稍后重试");
    } finally {
      setDeletingId(null);
    }
  };

  return <main className="vf-page">
    <section className="vf-page-head">
      <div><p className="vf-kicker">我的作品</p><h2>把想法做成一支视频</h2><p>每一支作品都保留在这里，随时继续制作。</p></div>
      <button className="vf-primary" onClick={onCreate}>+ 新建作品</button>
    </section>
    {settings && (() => {
      const llmReady = settings.llm.mode === "subscription" || settings.llm.apiKeyState.set;
      const minimaxReady = settings.minimax.apiKeyState.set;
      if (llmReady && minimaxReady) return null;
      return <section className="vf-setup-card" role="status">
        <b>开始之前，先完成两项配置（右上角「设置」页）</b>
        <ul>
          <li>{llmReady ? "✅" : "⬜"} 模型服务：填写 API Key 并点「测试连接」（或选择本机订阅模式）</li>
          <li>{minimaxReady ? "✅" : "⬜"} MiniMax 配音：填写你自己的 API Key 并测试</li>
          <li>🎙️ 可选：用「声音克隆向导」克隆你自己的声音（费用走你的 MiniMax 账号，约 9.9 元/次）</li>
        </ul>
      </section>;
    })()}
    {deleteError && <p className="vf-delete-error" role="alert">{deleteError}</p>}
    {works.length ? <section className="vf-work-grid">{works.map((work) => {
      const status = workStatus(work);
      const hasResult = work.status === "done";
      const isGenerating = work.status === "queued" || work.status === "running";
      const coverTone = `tone-${work.id % 4}`;
      const workTitle = work.title ?? "未命名作品";
      return <article className="vf-work-card" key={work.id}>
        <button className={`vf-cover ${coverTone}`} aria-label={`打开 ${workTitle}`} title={workTitle} onClick={() => onOpen(work.id)}>
          <span className="vf-cover-copy"><small>{hasResult ? "VIDEOFORGE / RESULT" : "VIDEOFORGE / DRAFT"}</small><b>{workTitle}</b>{!hasResult && work.excerpt && <em>{work.excerpt}</em>}</span>
          {work.coverExists && <img src={`/api/jobs/${work.id}/cover?v=${encodeURIComponent(work.updated_at)}`} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />}
        </button>
        <div className="vf-work-copy"><div className="vf-card-top"><span className={`vf-badge ${status.tone}`}>{status.label}</span><time>{work.updated_at.slice(0, 16).replace("T", " ")}</time></div><h3 title={workTitle}>{workTitle}</h3><p>{status.detail}</p><div className="vf-work-actions"><button className="vf-text-button" onClick={() => onOpen(work.id)}>{status.action} <span>→</span></button><button className="vf-delete-button" disabled={deletingId === work.id || isGenerating} title={isGenerating ? "作品正在生成，完成或失败后可删除" : "永久删除作品"} onClick={() => setPendingDelete(work)}>{deletingId === work.id ? "删除中…" : "删除"}</button></div></div>
      </article>;
    })}</section> : <section className="vf-empty"><div className="vf-empty-mark">VF</div><h3>还没有作品</h3><p>从一段文字、一篇文章或一个链接开始。</p><button className="vf-primary" onClick={onCreate}>新建第一支视频</button></section>}
    {pendingDelete && <div className="vf-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && deletingId === null) setPendingDelete(null); }}><section className="vf-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-work-title"><p className="vf-kicker">删除作品</p><h3 id="delete-work-title">确定永久删除？</h3><p className="vf-delete-work-name">{pendingDelete.title ?? "未命名作品"}</p><p>作品文件、生成结果、对话记录和制作进度都会从这台电脑上删除，此操作无法撤销。</p><div><button disabled={deletingId !== null} onClick={() => setPendingDelete(null)}>取消</button><button className="danger" disabled={deletingId !== null} onClick={() => void removeWork(pendingDelete)}>{deletingId !== null ? "正在删除…" : "确认删除"}</button></div></section></div>}
  </main>;
}
