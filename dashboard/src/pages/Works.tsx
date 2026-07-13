import { useEffect, useState } from "react";
import { api, type Job } from "../api";
import { workStatus } from "../lib/statusText";

export function Works({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const [works, setWorks] = useState<Job[]>([]);
  useEffect(() => {
    const load = () => api.jobs().then(setWorks).catch(() => {});
    load();
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, []);

  return <main className="vf-page">
    <section className="vf-page-head">
      <div><p className="vf-kicker">我的作品</p><h2>把想法做成一支视频</h2><p>每一支作品都保留在这里，随时继续制作。</p></div>
      <button className="vf-primary" onClick={onCreate}>+ 新建作品</button>
    </section>
    {works.length ? <section className="vf-work-grid">{works.map((work) => {
      const status = workStatus(work);
      const hasResult = work.status === "done";
      const coverTone = `tone-${work.id % 4}`;
      return <article className="vf-work-card" key={work.id}>
        <button className={`vf-cover ${coverTone}`} aria-label={`打开 ${work.title ?? "未命名作品"}`} onClick={() => onOpen(work.id)}>
          <span className="vf-cover-copy"><small>{hasResult ? "VIDEOFORGE / RESULT" : "VIDEOFORGE / DRAFT"}</small><b>{work.title ?? "未命名作品"}</b>{!hasResult && work.excerpt && <em>{work.excerpt}</em>}</span>
          {hasResult && <img src={`/api/jobs/${work.id}/cover`} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />}
        </button>
        <div className="vf-work-copy"><div className="vf-card-top"><span className={`vf-badge ${status.tone}`}>{status.label}</span><time>{work.updated_at.slice(0, 16).replace("T", " ")}</time></div><h3>{work.title ?? "未命名作品"}</h3><p>{status.detail}</p><button className="vf-text-button" onClick={() => onOpen(work.id)}>{status.action} <span>→</span></button></div>
      </article>;
    })}</section> : <section className="vf-empty"><div className="vf-empty-mark">VF</div><h3>还没有作品</h3><p>从一段文字、一篇文章或一个链接开始。</p><button className="vf-primary" onClick={onCreate}>新建第一支视频</button></section>}
  </main>;
}
