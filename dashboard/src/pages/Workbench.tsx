import { useEffect, useMemo, useState } from "react";
import {
  api,
  type AvatarAsset,
  type AvatarPreview,
  type JobDetail,
} from "../api";

const phases = [
  "文案确认",
  "口播稿审阅",
  "选择风格",
  "逐页生成",
  "配音字幕",
  "数字人",
  "导出成片",
];
const phaseSubs = [
  "核对源文字",
  "逐章审阅 · 对话修改",
  "卡片画廊 · 点选即用",
  "生成即预览 · 可修改",
  "声音与字幕时间轴",
  "上传形象 · 对口型",
  "带声音完整播放",
];
const themes = [
  {
    id: "midnight-press",
    name: "午夜刊物",
    desc: "高对比编辑部风格",
    tone: "dark",
  },
  {
    id: "warm-editorial",
    name: "暖调叙事",
    desc: "纸张质感与柔和留白",
    tone: "warm",
  },
  {
    id: "newsroom",
    name: "新闻演播",
    desc: "清晰、可信、信息密度高",
    tone: "news",
  },
  {
    id: "minimal",
    name: "极简讲解",
    desc: "克制排版，突出观点",
    tone: "light",
  },
];
const stageProgress: Record<string, string> = {
  script_outline: "正在生成口播稿和画面规划",
  scaffold: "正在准备画面工程",
  chapter_gen: "正在逐页生成并检查画面",
  audio_synth: "正在生成配音和逐字时间轴",
  subtitle_cues: "正在生成并校验字幕",
  avatar_gen: "正在调用数字人模型并进行口型同步",
  render: "正在准备成片",
};
function parseMeta(job: JobDetail) {
  try {
    return JSON.parse(job.meta || "{}");
  } catch {
    return {};
  }
}
function phaseIndex(job: JobDetail) {
  if (job.stage === "script_outline") return 0;
  if (job.stage === "gate_script") return 1;
  if (job.stage === "scaffold") return 2;
  if (["chapter_gen", "gate_chapters"].includes(job.stage)) return 3;
  if (["audio_synth", "subtitle_cues"].includes(job.stage)) return 4;
  if (job.stage === "avatar_gen") return 5;
  return 6;
}

export function Workbench({
  jobId,
  onBack,
}: {
  jobId: number;
  onBack: () => void;
}) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [files, setFiles] = useState<Record<string, string | null>>({});
  const [assets, setAssets] = useState<AvatarAsset[]>([]);
  const [avatarPreviews, setAvatarPreviews] = useState<AvatarPreview[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [regenerateState, setRegenerateState] = useState("");
  const load = () =>
    api
      .job(jobId)
      .then(setJob)
      .catch(() => {});
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [jobId]);
  useEffect(() => {
    ["article.md", "script.md", "outline.md"].forEach((name) =>
      api
        .jobFile(jobId, name)
        .then((r) => setFiles((old) => ({ ...old, [name]: r.content })))
        .catch(() => {}),
    );
  }, [jobId, job?.stage]);
  useEffect(() => {
    api
      .avatarAssets()
      .then(setAssets)
      .catch(() => {});
  }, [jobId, uploadState]);
  useEffect(() => {
    api
      .avatarPreviews(jobId)
      .then(setAvatarPreviews)
      .catch(() => {});
  }, [jobId, job?.stage, job?.status]);
  useEffect(() => {
    if (job && selected === null) setSelected(phaseIndex(job));
  }, [job, selected]);
  const meta = useMemo(() => (job ? parseMeta(job) : {}), [job]);
  if (!job || selected === null)
    return <main className="vf-page">正在打开作品…</main>;
  const current = phaseIndex(job);
  const canView = (index: number) => index <= current || job.status === "done";
  const previewUrl = job.devServer.url;
  const avatarProgressEvent = job.events.find(
    (event) =>
      event.stage === "avatar_gen" && event.message.startsWith("progress|"),
  );
  const avatarProgressParts = avatarProgressEvent?.message.split("|") ?? [];
  const avatarPercent = Number(avatarProgressParts[1] ?? 0);
  const avatarProgressText = avatarProgressParts[2] || stageProgress.avatar_gen;
  const ensurePreview = async () => {
    if (!job.devServer.running) {
      setBusy(true);
      try {
        await api.devStart(job.id);
        await load();
      } finally {
        setBusy(false);
      }
    }
  };
  const saveOptions = async (patch: unknown) => {
    setBusy(true);
    try {
      await api.saveJobOptions(job.id, patch);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const regenerating =
    job.stage === "chapter_gen" && ["queued", "running"].includes(job.status);
  const regenerate = async () => {
    if (regenerating || busy) return;
    setBusy(true);
    setRegenerateState("正在提交重新排版任务…");
    try {
      await api.retry(job.id, "chapter_gen");
      setRegenerateState(
        "任务已提交，正在逐页重新排版。可以停留在这里，也可以稍后回来查看。",
      );
      await load();
    } catch (error) {
      setRegenerateState(
        `提交失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const textView = (content: string | null | undefined, empty: string) => (
    <article className="vf-script">
      {content ? (
        content
          .split("\n")
          .filter(Boolean)
          .map((line, i) => <p key={i}>{line.replace(/^#+\s*/, "")}</p>)
      ) : (
        <p>{empty}</p>
      )}
    </article>
  );
  const uploadAvatar = async (file: File) => {
    setBusy(true);
    setUploadState(`正在上传 ${file.name}…`);
    try {
      if (file.size > 180 * 1024 * 1024) throw new Error("视频不能超过 180MB");
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const asset = await api.uploadAvatarAsset({
        filename: file.name,
        dataBase64,
      });
      await api.selectAvatarAsset(job.id, asset.id);
      setUploadState("上传成功，已保存到素材库并用于本片");
      await load();
    } catch (error) {
      setUploadState(
        `上传失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const content = (() => {
    if (selected === 0)
      return (
        <>
          <p className="vf-kicker">文案确认</p>
          <h2>原始内容</h2>
          {textView(files["article.md"], "正在读取原始内容…")}
        </>
      );
    if (selected === 1)
      return (
        <>
          <p className="vf-kicker">口播稿审阅</p>
          <h2>生成的口播稿</h2>
          {textView(files["script.md"], "口播稿尚未生成。")}
          {job.stage === "gate_script" && (
            <div className="vf-stage-actions">
              <button
                onClick={() => api.retry(job.id, "script_outline").then(load)}
              >
                换个写法
              </button>
              <button
                className="vf-primary"
                onClick={() => api.approve(job.id).then(load)}
              >
                这版可以，继续
              </button>
            </div>
          )}
        </>
      );
    if (selected === 2)
      return (
        <>
          <p className="vf-kicker">选择风格</p>
          <h2>选择这部作品的画面语言</h2>
          <p>先确定风格，再选择人物在最终画面里的占位方式。</p>
          <div className="vf-theme-grid">
            {themes.map((theme) => (
              <button
                key={theme.id}
                className={`vf-theme-option ${theme.tone} ${(meta.theme || "midnight-press") === theme.id ? "selected" : ""}`}
                onClick={() => saveOptions({ theme: theme.id })}
              >
                <i />
                <b>{theme.name}</b>
                <span>{theme.desc}</span>
                <em>
                  {(meta.theme || "midnight-press") === theme.id
                    ? "已选择"
                    : "选择"}
                </em>
              </button>
            ))}
          </div>
          <section className="vf-avatar-config">
            <h3>是否加入你的形象</h3>
            <div className="vf-segments">
              <button
                className={!meta.avatar?.enabled ? "selected" : ""}
                onClick={() =>
                  saveOptions({
                    avatar: { ...(meta.avatar || {}), enabled: false },
                  })
                }
              >
                不使用
              </button>
              <button
                className={meta.avatar?.enabled ? "selected" : ""}
                onClick={() =>
                  saveOptions({
                    avatar: {
                      ...(meta.avatar || {}),
                      enabled: true,
                      position: meta.avatar?.position || "right-third",
                    },
                  })
                }
              >
                使用数字人
              </button>
            </div>
            {meta.avatar?.enabled && (
              <>
                <h4>选择画面占位</h4>
                <div className="vf-layout-choices">
                  {[
                    ["right-top", "右上角小窗", "人物在右上，正文保留主要宽度"],
                    [
                      "right-bottom",
                      "右下角小窗",
                      "人物在右下，适合讲解型页面",
                    ],
                    [
                      "right-third",
                      "右侧讲师区",
                      "右侧约 1/3 留给人物，接近你发的参考图",
                    ],
                  ].map(([value, label, desc]) => (
                    <button
                      key={value}
                      className={
                        (meta.avatar?.position || "right-third") === value
                          ? "selected"
                          : ""
                      }
                      onClick={() =>
                        saveOptions({
                          avatar: { ...meta.avatar, position: value },
                        })
                      }
                    >
                      <i className={value}>
                        <span />
                      </i>
                      <b>{label}</b>
                      <small>{desc}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
          {current >= 3 && (
            <div className={`vf-regenerate ${regenerating ? "running" : ""}`}>
              <b>
                {regenerating
                  ? "正在按当前布局重新生成全部画面"
                  : "人物占位改变后，需要重新排版现有画面"}
              </b>
              <span>
                {regenerating
                  ? "后台正在逐页调整，完成后会停在“逐页生成”等你验收。"
                  : "系统会逐页让开人物区域，不会只在最后盖一层视频。"}
              </span>
              <button
                className="vf-primary"
                disabled={regenerating || busy}
                onClick={regenerate}
              >
                {regenerating ? "正在重新生成…" : "按当前布局重新生成全部画面"}
              </button>
              {regenerateState && (
                <small
                  className={
                    regenerateState.startsWith("提交失败") ? "error" : ""
                  }
                >
                  {regenerateState}
                </small>
              )}
            </div>
          )}
          <details className="vf-outline">
            <summary>查看画面规划</summary>
            {textView(files["outline.md"], "画面规划尚未生成。")}
          </details>
        </>
      );
    if (selected === 3)
      return (
        <>
          <p className="vf-kicker">画面预览</p>
          <h2>逐页生成结果</h2>
          {previewUrl ? (
            <iframe
              className="vf-live-preview"
              title="作品预览"
              src={previewUrl}
              allow="autoplay; fullscreen"
            />
          ) : (
            <div className="vf-preview">
              <b>VideoForge</b>
              <span>预览服务尚未启动</span>
            </div>
          )}
          <div className="vf-stage-actions">
            <button onClick={ensurePreview}>
              {busy ? "正在启动…" : "加载预览"}
            </button>
            {previewUrl && (
              <a
                className="vf-action-link"
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
              >
                新窗口打开
              </a>
            )}
            {job.stage === "gate_chapters" && (
              <button
                className="vf-primary"
                onClick={() => api.approve(job.id).then(load)}
              >
                画面通过，继续
              </button>
            )}
          </div>
        </>
      );
    if (selected === 4)
      return (
        <>
          <p className="vf-kicker">配音字幕</p>
          <h2>声音与字幕时间轴</h2>
          <div className="vf-result-grid">
            <section>
              <b>配音</b>
              <strong>配音片段已保留</strong>
              <span>完整播放时自动连续播放</span>
            </section>
            <section>
              <b>字幕</b>
              <strong>逐字字幕已生成</strong>
              <span>跟随真实音频时间轴</span>
            </section>
          </div>
          {previewUrl && (
            <button
              className="vf-primary"
              onClick={() => window.open(`${previewUrl}?auto=1`, "_blank")}
            >
              播放带声音预览
            </button>
          )}
        </>
      );
    if (selected === 5)
      return (
        <>
          <p className="vf-kicker">数字人</p>
          <h2>
            {job.stage === "avatar_gen" && job.status === "running"
              ? "正在生成数字人"
              : "选择你的出镜形象"}
          </h2>
          {job.stage === "avatar_gen" &&
            ["queued", "running"].includes(job.status) && (
              <div className="vf-avatar-progress">
                <div>
                  <b>{avatarProgressText}</b>
                  <strong>总进度 {avatarPercent}%</strong>
                </div>
                <progress max="100" value={avatarPercent} />
                <span>完成后会自动生成按章节拆分的预览视频。</span>
              </div>
            )}
          <section className="vf-avatar-composite">
            <h3>数字人与画面合成预览</h3>
            <p>
              直接在当前环节检查人物占位、口型、声音和逐页画面，不需要返回“逐页生成”。
            </p>
            {previewUrl ? (
              <iframe
                className="vf-live-preview"
                title="数字人合成预览"
                src={`${previewUrl}?auto=1`}
                allow="autoplay; fullscreen"
              />
            ) : (
              <div className="vf-preview">
                <b>VideoForge</b>
                <span>点击下方加载合成预览</span>
              </div>
            )}
            <div className="vf-stage-actions">
              <button onClick={ensurePreview}>
                {busy ? "正在启动…" : "加载合成预览"}
              </button>
              {previewUrl && (
                <a
                  className="vf-action-link vf-play-action"
                  href={`${previewUrl}?auto=1`}
                  target="_blank"
                  rel="noreferrer"
                >
                  ▶ 新窗口播放调试
                </a>
              )}
            </div>
          </section>
          <p>
            可以直接使用素材库里的数字人，也可以在这里上传一个新的，上传后会自动存进素材库。
          </p>
          {assets.length > 0 && (
            <div className="vf-picker-grid">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  className={
                    String(meta.avatar?.assetId) === asset.id ? "selected" : ""
                  }
                  onClick={async () => {
                    await api.selectAvatarAsset(job.id, asset.id);
                    await load();
                  }}
                >
                  <video src={asset.url} muted playsInline preload="metadata" />
                  <b>{asset.name}</b>
                  <span>
                    {String(meta.avatar?.assetId) === asset.id
                      ? "本片正在使用"
                      : "选择这个数字人"}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="vf-avatar-actions">
            <label className="vf-upload-button">
              <input
                type="file"
                accept=".mp4,.mov,video/mp4,video/quicktime"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadAvatar(file);
                  e.currentTarget.value = "";
                }}
              />
              <span>{busy ? "正在上传…" : "上传新的数字人"}</span>
            </label>
            {meta.avatar?.filename && (
              <button
                className="vf-primary"
                disabled={
                  job.stage === "avatar_gen" &&
                  ["queued", "running"].includes(job.status)
                }
                onClick={() => api.generateAvatar(job.id).then(load)}
              >
                调用 HeyGem 生成对口型
              </button>
            )}
          </div>
          {uploadState && (
            <p
              className={
                uploadState.startsWith("上传失败")
                  ? "vf-upload-state error"
                  : "vf-upload-state"
              }
            >
              {uploadState}
            </p>
          )}
          {avatarPreviews.length > 0 && (
            <section className="vf-chapter-previews">
              <h3>按章节预览数字人</h3>
              <p>每段只播放对应章节的口型画面，便于单独检查。</p>
              <div>
                {avatarPreviews.map((preview, index) => (
                  <article key={preview.id}>
                    <video
                      src={preview.url}
                      controls
                      muted
                      playsInline
                      preload="metadata"
                    />
                    <b>
                      {index + 1}. {preview.id}
                    </b>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      );
    return (
      <>
        <p className="vf-kicker">导出成片</p>
        <h2>播放与预览</h2>
        <p>
          点击下方按钮会在新窗口启动整片。浏览器为了保护声音播放，会要求你再点一次画面中央的播放按钮。
        </p>
        {previewUrl ? (
          <iframe
            className="vf-live-preview"
            title="成片预览"
            src={`${previewUrl}?auto=1`}
            allow="autoplay; fullscreen"
          />
        ) : (
          <div className="vf-preview">
            <b>VideoForge</b>
            <span>点击下方启动预览</span>
          </div>
        )}
        <div className="vf-stage-actions">
          <button onClick={ensurePreview}>重新加载</button>
          {previewUrl && (
            <a
              className="vf-action-link vf-play-action"
              href={`${previewUrl}?auto=1`}
              target="_blank"
              rel="noreferrer"
            >
              ▶ 播放整片（带声音）
            </a>
          )}
        </div>
      </>
    );
  })();
  return (
    <main className="vf-workbench">
      <header className="vf-work-head">
        <button onClick={onBack}>← 返回作品</button>
        <div>
          <span>作品 #{job.id}</span>
          <h1>{job.title}</h1>
        </div>
        <em>
          {job.status === "done"
            ? "已完成"
            : job.status === "failed"
              ? "需要处理"
              : "制作中"}
        </em>
      </header>
      <ol className="vf-rail">
        {phases.map((phase, index) => (
          <li
            className={`${index < current ? "done" : index === current ? "now" : ""} ${index === selected ? "viewing" : ""}`}
            key={phase}
          >
            <button
              disabled={!canView(index)}
              onClick={() => {
                setSelected(index);
                if (index === 3 || index === 5 || index === 6)
                  void ensurePreview();
              }}
            >
              <b>
                {index < current || job.status === "done" ? "✓" : index + 1}
              </b>
              <div>
                <span>{phase}</span>
                <small>{phaseSubs[index]}</small>
              </div>
            </button>
          </li>
        ))}
      </ol>
      {["queued", "running"].includes(job.status) && (
        <div className="vf-long-progress">
          <i />
          <div>
            <b>
              {job.stage === "avatar_gen"
                ? `${avatarProgressText} · ${avatarPercent}%`
                : stageProgress[job.stage] || "正在处理当前任务"}
            </b>
            <span>
              这是耗时任务，页面会自动更新；可以切换环节查看已完成内容。
            </span>
          </div>
          <em>{job.status === "queued" ? "等待开始" : "进行中"}</em>
        </div>
      )}
      <div className="vf-studio">
        <section className="vf-stage-panel">{content}</section>
        <aside className="vf-chat">
          <header>
            <h3>对话修改</h3>
            <p>当前查看：{phases[selected]}</p>
          </header>
          <div className="vf-chat-log">
            {job.feedback.length ? (
              job.feedback.map((item) => (
                <p key={item.id} className="vf-chat-message">
                  {item.message}
                  {item.status === "running" && <span className="vf-feedback-progress" aria-label={`修改进度 ${item.progress || 0}%`}><i style={{ width: `${item.progress || 0}%` }} /></span>}
                  <small className={item.status === "failed" ? "error" : ""}>
                    {item.status === "done"
                      ? "已经按你的要求改好了，修改说明如下"
                      : item.status === "failed"
                        ? `修改失败：${item.error || "模型执行时遇到问题，请重试"}`
                        : `${item.progress_message || "正在理解你的修改要求"} · ${item.progress || 0}%`}
                  </small>
                  {item.status === "done" && <span className="vf-feedback-result">{item.result || "这条修改在详细回执功能上线前完成，因此没有保存具体修改说明。后续修改会记录具体内容、思路和检查结果。"}</span>}
                </p>
              ))
            ) : (
              <p className="vf-chat-empty">你可以描述想调整的画面或文案。</p>
            )}
          </div>
          <div className="vf-chat-input">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="说说你想怎么改…"
            />
            <button
              onClick={async () => {
                if (!message.trim()) return;
              await api.sendFeedback(job.id, null, message, phases[selected]);
                setMessage("");
                await load();
              }}
            >
              →
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
