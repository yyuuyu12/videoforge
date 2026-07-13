import { useEffect, useState } from "react";
import { api, type DouyinExtraction } from "../api";

export function NewWork({ onCreated }: { onCreated: (id: number) => void }) {
  const [mode, setMode] = useState<"text" | "url" | "douyin">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [extractState, setExtractState] = useState("");
  const [extractions, setExtractions] = useState<DouyinExtraction[]>([]);
  const loadExtractions = () => api.douyinExtractions().then(setExtractions).catch(() => {});
  useEffect(() => {
    void loadExtractions();
    const timer = window.setInterval(loadExtractions, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const submit = async () => {
    if (mode === "text" && content.trim().length < 80)
      return setError("先补充一段至少 80 字的内容。");
    if (mode !== "text" && !url.trim())
      return setError(
        mode === "douyin"
          ? "请粘贴抖音分享链接或分享文本。"
          : "请粘贴文章链接。",
      );
    setBusy(true);
    setError("");
    try {
      if (mode === "douyin") {
        const task = await api.createDouyinExtraction(url);
        setExtractState(`提取任务 #${task.id} 已提交，可以切换页面，后台会继续处理。`);
        setUrl("");
        await loadExtractions();
        return;
      }
      const created = await api.addManualArticle(
        mode === "text"
          ? { title: title || "未命名作品", text: content }
          : { title: title || url, url },
      );
      const id = (created as { id: number }).id;
      if (!id) throw new Error("内容已存在，请从作品列表继续制作。");
      const job = await api.selectArticle(id);
      onCreated(job.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "暂时无法创建作品");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="vf-page vf-new">
      <section className="vf-page-head">
        <div>
          <p className="vf-kicker">新建作品</p>
          <h2>从内容开始</h2>
          <p>先给我们一段可靠的原始内容，后续的稿子和画面都会围绕它制作。</p>
        </div>
        <span className="vf-step-count">1 / 4</span>
      </section>
      <section className="vf-source-panel">
        <div className="vf-choice-tabs">
          <button
            className={mode === "text" ? "selected" : ""}
            onClick={() => setMode("text")}
          >
            直接贴文字
          </button>
          <button
            className={mode === "url" ? "selected" : ""}
            onClick={() => setMode("url")}
          >
            文章链接
          </button>
          <button
            className={mode === "douyin" ? "selected" : ""}
            onClick={() => setMode("douyin")}
          >
            抖音链接
          </button>
        </div>
        <label>
          作品标题
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="给这支视频取个名字"
          />
        </label>
        {mode === "text" ? (
          <label>
            原始内容
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="粘贴文章、口述提纲或你已经写好的文案…"
            />
          </label>
        ) : (
          <label>
            {mode === "douyin" ? "抖音分享链接或分享文本" : "文章链接"}
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                mode === "douyin"
                  ? "例如：复制此链接，打开抖音搜索… https://v.douyin.com/…"
                  : "https://"
              }
            />
          </label>
        )}
        {extractState && <p className="vf-upload-state">{extractState}</p>}
        {error && <p className="vf-form-error">{error}</p>}
        <div className="vf-form-footer">
          <p>
            {mode === "douyin"
              ? "优先读取作品内文案；没有字幕时自动下载原声并进行语音转文字。"
              : "下一步会自动写出适合口播的稿子，你可以在制作前确认和修改。"}
          </p>
          <button className="vf-primary" disabled={busy} onClick={submit}>
            {busy
              ? mode === "douyin"
                ? "正在提交…"
                : "正在创建…"
              : mode === "douyin"
                ? "开始提取文案"
                : "开始制作 →"}
          </button>
        </div>
      </section>
      {mode === "douyin" && (
        <section className="vf-extraction-history">
          <div className="vf-extraction-heading">
            <div><p className="vf-kicker">提取记录</p><h3>抖音文案历史</h3></div>
            <span>{extractions.length} 条</span>
          </div>
          {extractions.length === 0 ? <p className="vf-extraction-empty">还没有提取记录。</p> : (
            <div className="vf-extraction-list">
              {extractions.map((item) => (
                <article className={`vf-extraction-item ${item.status}`} key={item.id}>
                  <header><div><small>任务 #{item.id}</small><b>{item.title || "正在读取视频标题…"}</b></div><time>{item.created_at}</time></header>
                  <div className="vf-extraction-status"><span>{item.message || "等待处理"}</span><strong>{item.progress}%</strong></div>
                  <progress max="100" value={item.progress} />
                  {item.status === "running" && <p>后台处理中，可以切换到作品、素材库或设置，回来后进度仍会保留。</p>}
                  {item.status === "failed" && <p className="error">{item.error || "提取失败"}</p>}
                  {item.status === "done" && <div className="vf-extraction-result"><span>{Math.round((item.duration_seconds || 0) / 60)} 分钟 · {item.chars} 字 · 完整原声转录</span><details><summary>预览提取文案</summary><div>{item.content}</div></details></div>}
                  <footer>
                    {item.status === "failed" && <button onClick={async () => { await api.retryDouyinExtraction(item.id); await loadExtractions(); }}>重新提取</button>}
                    {item.status === "done" && item.article_id && <button className="vf-primary" disabled={busy} onClick={async () => { setBusy(true); try { if (item.job_id) onCreated(item.job_id); else { const job = await api.createWorkFromExtraction(item.id); onCreated(job.jobId); } } catch (e) { setError(e instanceof Error ? e.message : "创建作品失败"); } finally { setBusy(false); } }}>{item.job_id ? "打开已创建作品" : "用这份文案制作视频"}</button>}
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
