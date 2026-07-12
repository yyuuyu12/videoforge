import { useEffect, useState } from "react";
import { api, type Article } from "../api";

const FLOW = ["选题", "文案改写", "章节页面生成", "配音合成", "数字人对口型", "预览调整", "录制导出"];

export function Articles({ onJobCreated }: { onJobCreated: (jobId: number) => void }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [searchDirs, setSearchDirs] = useState("");
  const [douyinUrl, setDouyinUrl] = useState("");
  const [msg, setMsg] = useState("");

  const reload = () => {
    api.articles().then(setArticles).catch(() => {});
  };
  useEffect(reload, []);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMsg("");
    try {
      await fn();
      reload();
    } catch (err) {
      setMsg(String((err as Error).message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flowstrip">
        {FLOW.map((step, i) => (
          <span key={step} className="flowstep">
            <b>{i + 1}</b> {step}
            {i < FLOW.length - 1 && <span className="flowarrow">→</span>}
          </span>
        ))}
        <span className="muted" style={{ marginLeft: 8 }}>
          ← 从下面选一篇文章点「做成视频」，全流程自动跑，每个阶段可预览调整
        </span>
      </div>

      <div className="card">
        <h3>联网搜索选题</h3>
        <p className="muted">填方向关键词，AI 联网搜最近 7 天适合做视频的热点，结果直接进候选列表。</p>
        <div className="row">
          <input
            placeholder="方向关键词，如：AI 编程工具, 大模型行业动态"
            style={{ flex: 1 }}
            value={searchDirs}
            onChange={(e) => setSearchDirs(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy === "search"}
            onClick={() =>
              run("search", async () => {
                const r = await api.searchTopics(searchDirs);
                if (!r.ok) throw new Error(r.error);
                setMsg(`搜索完成：找到 ${r.found} 条，新增 ${r.added} 条候选`);
              })
            }
          >
            {busy === "search" ? "搜索中（约 1-2 分钟）…" : "开始搜索"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>抖音提取文案</h3>
        <p className="muted">贴抖音分享链接/分享文本，自动提取口播文案作为源头（优先内置字幕，无字幕走 ASR 转录）。</p>
        <div className="row">
          <input
            placeholder="抖音视频链接或整段分享文本"
            style={{ flex: 1 }}
            value={douyinUrl}
            onChange={(e) => setDouyinUrl(e.target.value)}
          />
          <button
            className="primary"
            disabled={!douyinUrl || busy === "douyin"}
            onClick={() =>
              run("douyin", async () => {
                const r = await api.douyinExtract(douyinUrl);
                if (!r.ok) throw new Error(r.error);
                setDouyinUrl("");
                setMsg(`提取成功（${r.via}，${r.chars} 字）：${r.title}`);
              })
            }
          >
            {busy === "douyin" ? "提取中…" : "提取"}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>手动添加文章</h3>
        <div className="row">
          <input
            placeholder="文章 URL（也可只贴 URL 后在选中时自动抓正文）"
            style={{ flex: 1 }}
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
          />
          <button
            disabled={!manualUrl || busy === "manual"}
            onClick={() =>
              run("manual", async () => {
                await api.addManualArticle({ url: manualUrl });
                setManualUrl("");
              })
            }
          >
            添加
          </button>
        </div>
      </div>

      {msg && <div className="card muted">{msg}</div>}

      <h3 style={{ margin: "20px 0 8px" }}>候选文章（{articles.length}）</h3>
      {articles.map((a) => (
        <div key={a.id} className="card">
          <div className="row spread">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3>{a.title}</h3>
              <div className="muted">{a.summary?.slice(0, 160) ?? a.url}</div>
            </div>
            <div className="row" style={{ flexShrink: 0 }}>
              <button disabled={busy === `dis-${a.id}`} onClick={() => run(`dis-${a.id}`, () => api.dismissArticle(a.id))}>
                忽略
              </button>
              <button
                className="primary"
                disabled={busy === `sel-${a.id}`}
                onClick={() =>
                  run(`sel-${a.id}`, async () => {
                    const r = await api.selectArticle(a.id);
                    onJobCreated(r.jobId);
                  })
                }
              >
                {busy === `sel-${a.id}` ? "创建中…" : "做成视频 ▶"}
              </button>
            </div>
          </div>
        </div>
      ))}
      {articles.length === 0 && (
        <div className="muted">暂无候选——用上面的联网搜索、抖音提取，或手动添加文章。</div>
      )}
    </div>
  );
}
