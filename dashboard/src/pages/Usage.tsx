import { useEffect, useMemo, useState } from "react";
import { api, type UsageData } from "../api";

const serviceNames: Record<string, string> = {
  llm: "模型生成",
  minimax: "MiniMax 配音",
  tikhub: "TikHub 解析",
  asr: "Whisper 转写",
  heygem: "HeyGem 数字人",
};

const categoryNames: Record<string, string> = {
  text: "文字生成",
  visual: "画面生成",
  audio: "声音生成",
  avatar: "数字人",
  source: "内容提取",
  other: "其他调用",
};

const number = (value: number) => new Intl.NumberFormat("zh-CN").format(Math.round(value || 0));
const duration = (value: number | null) => value ? (value >= 1000 ? `${(value / 1000).toFixed(1)} 秒` : `${value} 毫秒`) : "—";

function eventUsage(item: UsageData["recent"][number]) {
  const tokens = Number(item.input_tokens || 0) + Number(item.output_tokens || 0);
  if (tokens) return `输入 ${number(item.input_tokens)} · 输出 ${number(item.output_tokens)} tokens`;
  if (item.unit === "characters") return `${number(item.units)} 字符`;
  if (item.unit === "audio_seconds") return `${number(item.units)} 秒音频`;
  if (item.unit === "audio_mb") return `${Number(item.units || 0).toFixed(1)} MB 音频`;
  return `${number(item.requests)} 次请求`;
}

export function Usage() {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => api.usage(days, page, 12).then((result) => {
      setData(result);
      setError("");
      if (result.pagination.page !== page) setPage(result.pagination.page);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败"));
    load();
    const timer = window.setInterval(load, 10000);
    return () => window.clearInterval(timer);
  }, [days, page]);

  const maxDaily = useMemo(() => Math.max(1, ...(data?.daily.map((item) => item.requests) ?? [])), [data]);
  const successRate = data?.totals.requests ? Math.round(data.totals.succeeded / data.totals.requests * 100) : 0;
  const category = (name: string) => data?.categories.find((item) => item.category === name);

  return <main className="vf-page vf-usage-page">
    <section className="vf-page-head">
      <div><p className="vf-kicker">本机用量</p><h2>服务监控</h2><p>最近更新：{data ? new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "读取中"}</p></div>
      <div className="vf-usage-period" aria-label="统计周期">{[7, 30, 90].map((value) => <button key={value} className={days === value ? "active" : ""} onClick={() => { setDays(value); setPage(1); }}>{value} 天</button>)}</div>
    </section>
    {error && <p className="vf-delete-error" role="alert">{error}</p>}

    <section className="vf-usage-kpis">
      <article><span>总调用</span><strong>{number(data?.totals.requests ?? 0)}</strong><small>{days} 天</small></article>
      <article><span>成功率</span><strong>{successRate}%</strong><small>{number(data?.totals.failed ?? 0)} 次失败</small></article>
      <article><span>LLM Token</span><strong>{number((data?.totals.inputTokens ?? 0) + (data?.totals.outputTokens ?? 0))}</strong><small>输入 {number(data?.totals.inputTokens ?? 0)} · 输出 {number(data?.totals.outputTokens ?? 0)}</small></article>
      <article><span>MiniMax 字符</span><strong>{number(data?.totals.minimaxCharacters ?? 0)}</strong><small>参考估算 ¥{(data?.totals.minimaxEstimatedCny ?? 0).toFixed(2)}</small></article>
    </section>

    <section className="vf-usage-band">
      <header><div><p className="vf-kicker">阶段消耗</p><h3>按制作环节区分</h3></div></header>
      <div className="vf-usage-categories">
        {["text", "visual", "audio", "avatar", "source", "other"].map((name) => {
          const item = category(name);
          const tokens = Number(item?.input_tokens || 0) + Number(item?.output_tokens || 0);
          return <article key={name} className={`category-${name}`}><span>{categoryNames[name]}</span><strong>{name === "audio" && item?.characters ? `${number(item.characters)} 字符` : tokens ? `${number(tokens)} tokens` : `${number(item?.requests ?? 0)} 次`}</strong><small>{tokens ? `输入 ${number(item?.input_tokens ?? 0)} · 输出 ${number(item?.output_tokens ?? 0)}` : name === "audio" ? "MiniMax 按字符计量" : `${number(item?.requests ?? 0)} 次调用`}</small></article>;
        })}
      </div>
    </section>

    <section className="vf-usage-band">
      <header><div><p className="vf-kicker">调用趋势</p><h3>每日请求</h3></div><span>自动刷新</span></header>
      <div className="vf-usage-chart">{data?.daily.length ? data.daily.map((item) => <div key={item.day} className="vf-usage-bar"><i style={{ height: `${Math.max(8, item.requests / maxDaily * 100)}%` }} title={`${item.requests} 次`} /><span>{item.day.slice(5)}</span></div>) : <p>当前周期还没有调用记录</p>}</div>
    </section>

    <section className="vf-usage-band">
      <header><div><p className="vf-kicker">服务明细</p><h3>供应商与本机模型</h3></div></header>
      <div className="vf-usage-table-wrap"><table className="vf-usage-table"><thead><tr><th>服务</th><th>调用</th><th>成功</th><th>用量</th><th>平均耗时</th></tr></thead><tbody>{data?.services.length ? data.services.map((item) => <tr key={item.service}><td><b>{serviceNames[item.service] ?? item.service}</b>{item.has_estimates ? <small>含估算</small> : null}</td><td>{number(item.requests)}</td><td>{item.requests ? Math.round(item.succeeded / item.requests * 100) : 0}%</td><td>{item.service === "llm" ? `${number(item.input_tokens + item.output_tokens)} tokens` : item.unit === "characters" ? `${number(item.units)} 字符` : item.unit === "audio_seconds" ? `${number(item.units)} 秒音频` : item.unit === "audio_mb" ? `${item.units.toFixed(1)} MB` : number(item.units)}</td><td>{duration(item.avg_duration_ms)}</td></tr>) : <tr><td colSpan={5}>暂无记录</td></tr>}</tbody></table></div>
    </section>

    <section className="vf-usage-band">
      <header><div><p className="vf-kicker">调用日志</p><h3>运行记录</h3></div><span>共 {number(data?.pagination.total ?? 0)} 条</span></header>
      <div className="vf-usage-events">{data?.recent.length ? data.recent.map((item) => <article key={item.id}><i className={item.status} /><div><b><em className={`vf-usage-category category-${item.category}`}>{categoryNames[item.category]}</em>{serviceNames[item.service] ?? item.service} · {item.operation}</b><span>{eventUsage(item)} · {item.detail || (item.job_id ? `作品 #${item.job_id}` : "系统调用")}</span></div><time>{item.created_at.slice(5, 16).replace("T", " ")}</time></article>) : <p>暂无调用记录</p>}</div>
      <nav className="vf-usage-pagination" aria-label="日志分页"><button disabled={!data || data.pagination.page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><span>第 {data?.pagination.page ?? 1} / {data?.pagination.totalPages ?? 1} 页</span><button disabled={!data || data.pagination.page >= data.pagination.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button></nav>
    </section>
    <p className="vf-usage-footnote">LLM 在供应商返回 usage 时记录精确 token，否则按文本长度估算。声音生成由 MiniMax 按字符计量，不与 LLM token 混算；费用以供应商账单为准。</p>
  </main>;
}
