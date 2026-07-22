import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type AvatarAsset,
  type AvatarPreview,
  type JobAudit,
  type JobDetail,
} from "../api";
import { splitWorkTitle } from "../lib/workTitle";

type FeedbackImage = { name: string; mime: string; dataBase64: string; previewUrl: string };

const phases = [
  "原文确认",
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
const conversationalPhases = new Set([
  "口播稿审阅",
  "逐页生成",
  "配音字幕",
  "数字人",
]);
const previewAffectingFeedbackPhases = new Set(["逐页生成", "配音字幕", "数字人"]);

function syncPreviewChapter(chapterIndex: number) {
  const cursor = JSON.stringify({ chapter: chapterIndex, step: 0 });
  try {
    Object.keys(window.localStorage)
      .filter((key) => /^presentation-cursor-v\d+$/.test(key))
      .forEach((key) => window.localStorage.setItem(key, cursor));
    for (let version = 1; version <= 10; version += 1) {
      window.localStorage.setItem(`presentation-cursor-v${version}`, cursor);
    }
  } catch {
    // The chapter query parameter still handles new presentations when storage is unavailable.
  }
}
const themes = [
  {
    id: "midnight-press",
    name: "午夜刊物",
    desc: "高对比编辑部风格",
    tone: "dark",
  },
  {
    id: "swiss-ikb",
    name: "瑞士蓝印",
    desc: "理性网格与强信息层级",
    tone: "light",
  },
  {
    id: "newsroom",
    name: "新闻演播",
    desc: "清晰、可信、信息密度高",
    tone: "news",
  },
  {
    id: "bold-signal",
    name: "强信号",
    desc: "高冲击标题与清晰重点",
    tone: "warm",
  },
];
const stageProgress: Record<string, string> = {
  gate_source: "等待你确认原始内容",
  script_outline: "正在生成口播稿和画面规划",
  scaffold: "风格已确认，正在创建画面工程（通常需要 10–30 秒）",
  chapter_gen: "正在逐页生成并检查画面",
  audio_synth: "正在生成配音和逐字时间轴",
  subtitle_cues: "正在生成并校验字幕",
  avatar_media: "正在调用数字人模型并进行口型同步",
  avatar_wire: "正在把数字人接入每一页画面",
  render: "正在准备成片",
};

const progressActionLabels: Record<string, string> = {
  run_command: "正在检查生成结果",
  write_file: "正在生成新版画面",
  read_file: "正在读取画面内容",
  edit_file: "正在调整画面",
  list_files: "正在整理画面文件",
  search_files: "正在检查画面内容",
};

function friendlyProgressText(text: string) {
  const normalized = text.trim().replace(/^正在执行[：:]\s*/, "");
  if (progressActionLabels[normalized]) return progressActionLabels[normalized];
  const actions = normalized.split(/[、,\s]+/).filter(Boolean);
  if (actions.length > 0 && actions.every((action) => progressActionLabels[action])) {
    const unique = new Set(actions);
    if (unique.has("write_file") || unique.has("edit_file")) return "正在生成并调整画面";
    if (unique.has("run_command")) return "正在检查生成结果";
    return "正在读取并检查画面文件";
  }
  if (/\b[a-z][a-z0-9_]*\b/i.test(normalized) && normalized.includes("_")) return "正在处理当前画面";
  return text.trim() || "正在处理当前任务";
}

const qualityPhaseLabels: Record<string, string> = {
  lint: "静态规则校验",
  camera: "镜头声明校验",
  audit: "逐屏结构审计",
  repair: "画面修复",
  effect: "博主质感评分",
};
function qualityPhaseLabel(phase: string) {
  return qualityPhaseLabels[phase] || "画面质量校验";
}
function formatEta(seconds: number | null) {
  if (!seconds || seconds <= 0) return "";
  if (seconds >= 60) return `预计还需约 ${Math.round(seconds / 60)} 分钟`;
  return "预计还需不到 1 分钟";
}

type RetryImpact = {
  label: string;
  redo: string;
  keep: string;
  next: string;
};

const retryImpacts: Record<string, RetryImpact> = {
  gate_source: { label: "原文确认", redo: "从原文确认重新开始，并重新生成后续内容", keep: "保留原始文章", next: "重新生成口播稿" },
  script_outline: { label: "口播稿生成", redo: "重新生成口播稿和画面规划", keep: "保留原文", next: "回到口播稿验收" },
  gate_script: { label: "口播稿确认", redo: "重新确认或修改口播稿", keep: "保留原文和当前稿件", next: "确认后重新检查后续画面" },
  gate_style: { label: "风格选择", redo: "重新选择风格，并从画面工程开始更新", keep: "保留原文和口播稿", next: "重新生成 PPT 画面" },
  scaffold: { label: "画面框架", redo: "重新创建 PPT 画面框架", keep: "保留原文、口播稿和风格选择", next: "继续逐章生成画面" },
  chapter_gen: { label: "PPT 画面", redo: "从未完成的章节继续生成并检查", keep: "保留已完成章节和前序内容", next: "回到逐章画面验收" },
  gate_chapters: { label: "画面验收", redo: "继续验收或修改当前 PPT 画面", keep: "保留已生成的全部章节", next: "确认后进入配音" },
  audio_synth: { label: "配音", redo: "重新检查并生成缺失的配音", keep: "保留原文、稿件和 PPT 画面", next: "重新试听配音" },
  gate_audio: { label: "配音验收", redo: "重新试听或修改配音", keep: "保留 PPT 和已生成配音", next: "确认后生成字幕" },
  subtitle_cues: { label: "字幕", redo: "重新生成并检查字幕时间轴", keep: "保留 PPT 和配音", next: "重新预览字幕" },
  gate_subtitles: { label: "字幕验收", redo: "重新检查或调整字幕", keep: "保留 PPT、配音和当前字幕", next: "确认后进入数字人" },
  avatar_media: { label: "数字人", redo: "重新生成口型并接入现有 PPT", keep: "保留原文、稿件、PPT、配音和字幕", next: "重新逐章预览数字人" },
  gate_avatar: { label: "数字人验收", redo: "重新检查或更换数字人；更换后只重做口型与接线", keep: "保留数字人之前的全部内容", next: "确认后进入导出" },
  gate_render: { label: "导出确认", redo: "重新检查完整预览", keep: "保留 PPT、配音、字幕和数字人", next: "确认后生成 MP4" },
  render: { label: "成片导出", redo: "重新录制画面并混合声音，覆盖旧 MP4", keep: "保留 PPT、配音、字幕和数字人，不重新生成素材", next: "完成后可下载新成片" },
  done: { label: "成片导出", redo: "仅重新录制并导出 MP4", keep: "保留 PPT、配音、字幕和数字人，不返回前面环节", next: "覆盖旧成片并更新封面" },
};

function retryImpact(stage: string): RetryImpact {
  return retryImpacts[stage] || { label: "当前环节", redo: "从当前失败位置继续处理", keep: "保留已经完成且仍有效的内容", next: "完成后回到当前环节验收" };
}
function parseMeta(job: JobDetail) {
  try {
    return JSON.parse(job.meta || "{}");
  } catch {
    return {};
  }
}
function phaseIndex(job: JobDetail) {
  if (job.stage === "gate_source") return 0;
  if (["script_outline", "gate_script"].includes(job.stage)) return 1;
  if (["gate_style", "scaffold"].includes(job.stage)) return 2;
  if (["chapter_gen", "gate_chapters"].includes(job.stage)) return 3;
  if (["audio_synth", "gate_audio", "subtitle_cues", "gate_subtitles"].includes(job.stage)) return 4;
  if (["avatar_media", "avatar_wire", "gate_avatar"].includes(job.stage)) return 5;
  return 6;
}

function WorkbenchLoading() {
  return (
    <main className="vf-opening-loader" role="status" aria-live="polite">
      <div className="vf-opening-doodle" aria-hidden="true">
        <svg viewBox="0 0 180 150">
          <g className="vf-opening-sparkles">
            <path d="M31 48h12M37 42v12" />
            <path d="M139 34h9M143.5 29.5v9" />
            <path d="M145 105h10" />
          </g>
          <g className="vf-opening-character">
            <path className="vf-opening-clap" d="M47 61 131 47l4 20-84 14z" />
            <path className="vf-opening-clap-lines" d="m61 59 10 17m15-21 10 17m15-21 10 17" />
            <rect x="51" y="72" width="84" height="60" rx="10" />
            <path d="M52 88h82" />
            <circle cx="77" cy="104" r="2.5" />
            <circle cx="109" cy="104" r="2.5" />
            <path d="M81 116q12 9 24 0" />
            <path d="M62 133q-5 7-1 11m63-11q5 7 1 11" />
          </g>
        </svg>
      </div>
      <strong>正在打开作品</strong>
      <span>正在恢复上次制作进度</span>
      <div className="vf-opening-dots" aria-hidden="true"><i /><i /><i /></div>
    </main>
  );
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
  const [audit, setAudit] = useState<JobAudit | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<string | null>(null);
  const [chapterFeedbackScope, setChapterFeedbackScope] = useState<"chapter" | "global">("chapter");
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [feedbackImage, setFeedbackImage] = useState<FeedbackImage | null>(null);
  const [feedbackImageError, setFeedbackImageError] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadState, setUploadState] = useState("");
  const [avatarState, setAvatarState] = useState("");
  const [regenerateState, setRegenerateState] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewNotice, setPreviewNotice] = useState("");
  const [previewRevision, setPreviewRevision] = useState(0);
  const [incrementalPreviewBuilding, setIncrementalPreviewBuilding] = useState(false);
  const [renderConfirmOpen, setRenderConfirmOpen] = useState(false);
  const [sourceEditing, setSourceEditing] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");
  const [sourceSaveState, setSourceSaveState] = useState("");
  const lastCurrent = useRef<number | null>(null);
  const trackedFeedbackIds = useRef(new Set<number>());
  const feedbackStatuses = useRef(new Map<number, string>());
  const incrementalPreviewKey = useRef("");
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
    setFeedbackImage(null);
    setFeedbackImageError("");
  }, [jobId]);
  useEffect(() => {
    setSourceEditing(false);
    setSourceDraft("");
    setSourceSaveState("");
    setPreviewNotice("");
    setChapterFeedbackScope("chapter");
    setFeedbackSending(false);
    setIncrementalPreviewBuilding(false);
    incrementalPreviewKey.current = "";
    trackedFeedbackIds.current.clear();
    feedbackStatuses.current.clear();
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
    if (!sourceEditing && files["article.md"] !== null && files["article.md"] !== undefined) {
      setSourceDraft(files["article.md"] || "");
    }
  }, [files["article.md"], sourceEditing]);
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
    if (!job || !["gate_chapters", "audio_synth", "gate_audio", "subtitle_cues", "gate_subtitles", "avatar_media", "avatar_wire", "gate_avatar", "gate_render", "render", "done"].includes(job.stage)) return;
    const loadAudit = () => api.audit(jobId).then(setAudit).catch(() => {});
    void loadAudit();
    const timer = window.setInterval(loadAudit, 5000);
    return () => window.clearInterval(timer);
  }, [jobId, job?.stage, job?.status]);
  useEffect(() => {
    if (!job) return;
    const next = phaseIndex(job);
    const previous = lastCurrent.current;
    if (selected === null || (previous !== null && next > previous && selected === previous)) {
      setSelected(next);
    }
    lastCurrent.current = next;
  }, [job?.stage, job?.status, selected]);
  useEffect(() => {
    const chapters = job?.chapterGeneration?.chapters || [];
    if (!chapters.length) {
      setSelectedChapter(null);
      return;
    }
    if (selectedChapter && chapters.some((chapter) => chapter.key === selectedChapter)) return;
    setSelectedChapter((chapters.find((chapter) => chapter.status !== "approved") || chapters[0]).key);
  }, [job?.chapterGeneration?.chapters, selectedChapter]);
  const selectedChapterIndex = job?.chapterGeneration?.chapters
    .find((chapter) => chapter.key === selectedChapter)?.index;
  useLayoutEffect(() => {
    if (selectedChapterIndex) syncPreviewChapter(selectedChapterIndex - 1);
  }, [jobId, selectedChapterIndex]);
  useEffect(() => {
    if (!job) return;
    for (const item of job.feedback) {
      const previous = feedbackStatuses.current.get(item.id);
      feedbackStatuses.current.set(item.id, item.status);
      if (!trackedFeedbackIds.current.has(item.id)) continue;
      if (item.status === "done" && previous !== "done") {
        trackedFeedbackIds.current.delete(item.id);
        if (item.phase === "口播稿审阅") {
          void api.jobFile(jobId, "script.md")
            .then((result) => {
              setFiles((old) => ({ ...old, ["script.md"]: result.content }));
              setPreviewNotice("口播稿已更新，左侧已经显示最新内容");
            })
            .catch(() => setPreviewNotice("口播稿修改已完成，请刷新页面查看最新内容"));
        } else if (item.phase && previewAffectingFeedbackPhases.has(item.phase)) {
          setPreviewRevision((value) => value + 1);
          setPreviewNotice(item.phase === "逐页生成"
            ? item.chapter
              ? "当前页面已更新，左侧预览已自动刷新"
              : "全部页面已更新，左侧预览已自动刷新"
            : "修改完成，左侧预览已自动刷新");
        }
      } else if (item.status === "failed") {
        trackedFeedbackIds.current.delete(item.id);
      }
    }
  }, [job, jobId]);
  useEffect(() => {
    if (!job || job.stage !== "chapter_gen") return;
    const completed = job.chapterGeneration.completed;
    if (completed < 1) return;
    const key = `${job.id}:${completed}`;
    if (incrementalPreviewKey.current === key) return;
    incrementalPreviewKey.current = key;
    setIncrementalPreviewBuilding(true);
    setPreviewError("");
    void api.devStart(job.id)
      .then(() => api.job(job.id))
      .then((nextJob) => {
        setJob(nextJob);
        setPreviewRevision((value) => value + 1);
        setPreviewNotice(`前 ${completed} 章已完成，可以逐章预览`);
      })
      .catch((error) => {
        if (incrementalPreviewKey.current === key) incrementalPreviewKey.current = "";
        // 生成期的构建失败是常态（后续章节写到一半、整棵树暂时编译不过），
        // 下一章完成后会自动重试成功——按中性状态提示，不当错误吓人
        setPreviewNotice(`前 ${completed} 章已写完，画面工程整体还在生成中，预览会随后续章节完成自动就绪`);
        console.warn("incremental preview build failed:", error);
      })
      .finally(() => setIncrementalPreviewBuilding(false));
  }, [
    job?.id,
    job?.stage,
    job?.status,
    job?.chapterGeneration.completed,
    job?.chapterGeneration.current?.status,
    job?.chapterGeneration.message,
  ]);
  const meta = useMemo(() => (job ? parseMeta(job) : {}), [job]);
  if (!job || selected === null) return <WorkbenchLoading />;
  const current = phaseIndex(job);
  const workTitle = splitWorkTitle(job.title);
  const activePhase = phases[selected];
  const chatEnabled = conversationalPhases.has(activePhase)
    && (activePhase !== "逐页生成" || Boolean(selectedChapter));
  const chapterScope = activePhase === "逐页生成" && chapterFeedbackScope === "chapter"
    ? selectedChapter
    : null;
  const phaseFeedback = job.feedback.filter((item) =>
    item.phase === activePhase && (activePhase !== "逐页生成" || item.chapter === chapterScope),
  );
  const draftKey = chapterScope ? `${activePhase}:${chapterScope}` : activePhase;
  const message = messageDrafts[draftKey] || "";
  const feedbackRunning = job.feedback.some((item) => item.phase === activePhase && item.status === "running");
  const activeFeedback = job.feedback.find((item) =>
    item.phase === activePhase
      && item.status === "running"
      && (activePhase !== "逐页生成" || item.chapter === null || item.chapter === selectedChapter),
  );
  const chapterGeneration = job.chapterGeneration;
  const currentChapterTitle = chapterGeneration.chapters
    .find((chapter) => chapter.key === chapterGeneration.current?.chapter)?.title;
  const chapterGenerationMessage = currentChapterTitle && chapterGeneration.current?.chapter
    ? chapterGeneration.message.replace(chapterGeneration.current.chapter, currentChapterTitle)
    : chapterGeneration.message;
  const activeChapter = chapterGeneration.chapters.find((chapter) => chapter.key === selectedChapter) || null;
  const allChaptersApproved = chapterGeneration.chapters.length > 0
    && chapterGeneration.approved === chapterGeneration.chapters.length;
  const styleEditable = job.stage === "gate_style" && job.status === "waiting_approval";
  const canView = (index: number) => index <= current || job.status === "done";
  const previewUrl = job.devServer.url;
  const chapterPreviewUrl = previewUrl && activeChapter
    ? `${previewUrl}${previewUrl.includes("?") ? "&" : "?"}chapter=${activeChapter.index - 1}&revision=${previewRevision}`
    : previewUrl;
  const chapterGenerationRunning = job.stage === "chapter_gen" && ["queued", "running"].includes(job.status);
  const activeChapterPreviewable = Boolean(
    activeChapter?.ready
      && (job.stage !== "chapter_gen" || ["review", "approved"].includes(activeChapter.status)),
  );
  const activeProgressEvent = job.events.find(
    (event) => event.stage === job.stage && event.message.startsWith("progress|"),
  );
  const activeProgressParts = activeProgressEvent?.message.split("|") ?? [];
  const activePercent = Number(activeProgressParts[1] ?? 0);
  const activeProgressText = friendlyProgressText(
    activeProgressParts[2] || stageProgress[job.stage] || "正在处理当前任务",
  );
  const submitFeedback = async () => {
    const content = message.trim();
    if ((!content && !feedbackImage) || feedbackSending || feedbackRunning) return;
    setFeedbackSending(true);
    setPreviewNotice("");
    try {
      const submitted = await api.sendFeedback(job.id, chapterScope, content, activePhase, feedbackImage ? {
        name: feedbackImage.name, mime: feedbackImage.mime, dataBase64: feedbackImage.dataBase64,
      } : undefined);
      trackedFeedbackIds.current.add(submitted.feedbackId);
      feedbackStatuses.current.set(submitted.feedbackId, "running");
      setMessageDrafts((drafts) => ({ ...drafts, [draftKey]: "" }));
      setFeedbackImage(null);
      setFeedbackImageError("");
      await load();
    } finally {
      setFeedbackSending(false);
    }
  };
  const handleFeedbackPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"));
    if (!item) return;
    event.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setFeedbackImageError("仅支持 PNG、JPEG 或 WebP 图片"); return; }
    if (file.size > 5 * 1024 * 1024) { setFeedbackImageError("图片不能超过 5MB"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      setFeedbackImage({ name: file.name || "pasted-image.png", mime: file.type, dataBase64: value.split(",", 2)[1] || "", previewUrl: value });
      setFeedbackImageError("");
    };
    reader.readAsDataURL(file);
  };
  const retryFailedStage = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.retry(job.id, job.stage);
      await load();
    } catch (error) {
      setRegenerateState(`重试提交失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };
  const cancelGeneration = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.cancel(job.id);
      await load();
    } catch (error) {
      setRegenerateState(`取消失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };
  const ensurePreview = async () => {
    setBusy(true);
    setPreviewError("");
    try {
      await api.devStart(job.id);
      await load();
      setPreviewRevision((value) => value + 1);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "预览构建失败");
    } finally {
      setBusy(false);
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
  const startRender = async () => {
    if (busy) return;
    setBusy(true);
    setPreviewError("");
    try {
      await api.startRender(job.id);
      setRenderConfirmOpen(false);
      await load();
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "渲染启动失败");
    } finally {
      setBusy(false);
    }
  };
  const renderProgressEvent = job.events.find(
    (event) => event.stage === "render" && event.message.startsWith("progress|"),
  );
  const renderProgressParts = renderProgressEvent?.message.split("|") ?? [];
  const failedRetryImpact = retryImpact(job.stage);
  const regenerate = async () => {
    if (busy) return;
    setBusy(true);
    setRegenerateState("正在返回风格选择…");
    try {
      await api.retry(job.id, "gate_style");
      setSelected(2);
      setRegenerateState("请选择风格并确认，随后将按新风格重新生成。 ");
      await load();
    } catch (error) {
      setRegenerateState(
        `提交失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const textView = (content: string | null | undefined, empty: string, className = "") => (
    <article className={`vf-script ${className}`.trim()}>
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
  const selectAvatar = async (asset: AvatarAsset) => {
    setBusy(true);
    setAvatarState(`正在切换为“${asset.name}”…`);
    try {
      await api.selectAvatarAsset(job.id, asset.id);
      setAvatarState(`已选择“${asset.name}”。需要重新生成口型，之前的数字人预览不会作为新结果使用。`);
      await load();
    } catch (error) {
      setAvatarState(`切换失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };
  const generateAvatar = async () => {
    setBusy(true);
    setAvatarState("正在检查数字人服务…");
    try {
      await api.generateAvatar(job.id);
      setAvatarState("数字人任务已提交，正在准备口型生成…");
      await load();
    } catch (error) {
      setAvatarState(error instanceof Error ? `暂时无法生成：${error.message}` : "暂时无法生成，请检查数字人服务。");
    } finally {
      setBusy(false);
    }
  };
  const content = (() => {
    if (selected === 0)
      return (
        <>
          <p className="vf-kicker">原文确认</p>
          <h2>先确认原始内容</h2>
          <p>这里不会自动生成。检查标题、事实和内容完整性，确认后才进入口播稿生成。</p>
          <div className="vf-validation-strip">
            <span className={files["article.md"] ? "ok" : "pending"} />
            <b>{files["article.md"] ? "原文已载入" : "正在读取原文"}</b>
            <small>{files["article.md"] ? `约 ${files["article.md"]!.length} 字符` : "请稍候"}</small>
          </div>
          <div className="vf-source-review-heading">
            <div><b>原文内容</b><span>{sourceEditing ? "编辑中" : "阅读排版"}</span></div>
            {job.stage === "gate_source" && !sourceEditing && (
              <button className="vf-secondary" onClick={() => { setSourceDraft(files["article.md"] || ""); setSourceSaveState(""); setSourceEditing(true); }}>
                编辑原文
              </button>
            )}
          </div>
          {sourceEditing ? (
            <div className="vf-source-editor">
              <textarea
                aria-label="编辑原文"
                value={sourceDraft}
                onChange={(event) => { setSourceDraft(event.target.value); setSourceSaveState(""); }}
              />
              <div className="vf-source-editor-footer">
                <span>{sourceDraft.length} 字符</span>
                <div className="vf-action-cluster">
                  <button className="vf-secondary" disabled={busy} onClick={() => { setSourceDraft(files["article.md"] || ""); setSourceEditing(false); setSourceSaveState(""); }}>取消</button>
                  <button className="vf-primary" disabled={busy || sourceDraft.trim().length < 200} onClick={async () => {
                    setBusy(true);
                    setSourceSaveState("");
                    try {
                      const result = await api.saveSourceFile(job.id, sourceDraft);
                      setFiles((old) => ({ ...old, ["article.md"]: result.content }));
                      setSourceDraft(result.content);
                      setSourceEditing(false);
                      setSourceSaveState("原文调整已保存");
                    } catch (error) {
                      setSourceSaveState(error instanceof Error ? error.message : "原文保存失败");
                    } finally {
                      setBusy(false);
                    }
                  }}>{busy ? "正在保存…" : "保存调整"}</button>
                </div>
              </div>
            </div>
          ) : textView(files["article.md"], "正在读取原始内容…", "vf-source-script")}
          {sourceSaveState && <p className="vf-source-save-state" role="status">{sourceSaveState}</p>}
          {job.stage === "gate_source" && (
            <div className="vf-step-actionbar">
              <div><b>原文检查完成了吗？</b><span>需要调整可直接编辑原文；保存后由你手动确认进入下一步。</span></div>
              <button
                className="vf-primary"
                disabled={busy || sourceEditing || !files["article.md"]}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.approve(job.id);
                    setSelected(1);
                    await load();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "正在进入下一步…" : sourceEditing ? "请先保存原文" : "确认原文，开始生成口播稿"}
              </button>
            </div>
          )}
        </>
      );
    if (selected === 1)
      return (
        <>
          <p className="vf-kicker">口播稿审阅</p>
          <h2>生成的口播稿</h2>
          {job.stage === "script_outline" && ["queued", "running"].includes(job.status) ? (
            <div className="vf-next-stage-loading" role="status">
              <span className="vf-loading-ring" />
              <div><b>{activeProgressText}</b><p>原文已经确认。现在生成口播稿和画面规划，完成后会停在本页等待审阅。</p></div>
            </div>
          ) : textView(files["script.md"], "口播稿尚未生成。")}
          {previewNotice && <p className="vf-inline-success" role="status">{previewNotice}</p>}
          {job.stage === "gate_script" && (
            <div className="vf-step-actionbar">
              <button className="vf-secondary"
                onClick={() => api.retry(job.id, "script_outline").then(load)}
              >
                换个写法
              </button>
              <button
                className="vf-primary"
                onClick={async () => {
                  await api.approve(job.id);
                  setSelected(2);
                  await load();
                }}
              >
                确认口播稿，选择风格
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
                disabled={!styleEditable || busy}
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
          <section className="vf-option-panel vf-option-preview-panel">
            <div className="vf-option-controls">
              <div className="vf-option-heading"><div><h3>文字与排版</h3><p>先用作品级预设控制字号和页面信息量，不改底层 Skill。</p></div></div>
              <div className="vf-option-row">
                <span>文字大小</span>
                <div className="vf-segments">
                  {[["compact", "紧凑"], ["large", "大字（推荐）"], ["extra-large", "超大字"]].map(([value, label]) => (
                    <button key={value} disabled={!styleEditable || busy} className={(meta.typography?.fontSize || "large") === value ? "selected" : ""} onClick={() => saveOptions({ typography: { ...(meta.typography || {}), fontSize: value } })}>{label}</button>
                  ))}
                </div>
              </div>
              <div className="vf-option-row">
                <span>排版密度</span>
                <div className="vf-segments">
                  {[["airy", "留白多"], ["balanced", "均衡（推荐）"], ["dense", "信息密集"]].map(([value, label]) => (
                    <button key={value} disabled={!styleEditable || busy} className={(meta.typography?.density || "balanced") === value ? "selected" : ""} onClick={() => saveOptions({ typography: { ...(meta.typography || {}), density: value } })}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div
              className={`vf-mini-stage vf-typography-stage theme-${meta.theme || "midnight-press"} size-${meta.typography?.fontSize || "large"} density-${meta.typography?.density || "balanced"}`}
              aria-label="当前文字与排版效果预览"
            >
              <div className="vf-mini-meta"><i /><span /></div>
              <div className="vf-mini-title"><i /><i /></div>
              <div className="vf-mini-rule" />
              <div className="vf-mini-content"><i /><i /><i /><i /><i /><i /></div>
            </div>
          </section>
          <section className="vf-option-panel vf-option-preview-panel">
            <div className="vf-option-controls">
              <div className="vf-option-heading"><div><h3>字幕预设</h3><p>深色主题自动使用浅色字幕，浅色主题自动使用深色字幕。</p></div><label className="vf-switch"><input type="checkbox" disabled={!styleEditable || busy} checked={meta.subtitle?.enabled !== false} onChange={(event) => saveOptions({ subtitle: { ...(meta.subtitle || {}), enabled: event.target.checked } })} /><span /></label></div>
              {meta.subtitle?.enabled !== false && <>
                <div className="vf-option-row"><span>字幕样式</span><div className="vf-segments">{[["auto-contrast", "自动高对比"], ["soft-panel", "柔和底板"], ["outline", "描边字幕"]].map(([value, label]) => <button key={value} disabled={!styleEditable || busy} className={(meta.subtitle?.preset || "auto-contrast") === value ? "selected" : ""} onClick={() => saveOptions({ subtitle: { ...(meta.subtitle || {}), enabled: true, preset: value } })}>{label}</button>)}</div></div>
                <div className="vf-option-row"><span>字幕位置</span><div className="vf-segments">{[["bottom", "底部"], ["lower-third", "下三分之一"], ["top", "顶部"]].map(([value, label]) => <button key={value} disabled={!styleEditable || busy} className={(meta.subtitle?.position || "bottom") === value ? "selected" : ""} onClick={() => saveOptions({ subtitle: { ...(meta.subtitle || {}), enabled: true, position: value } })}>{label}</button>)}</div></div>
              </>}
            </div>
            <div
              className={`vf-mini-stage vf-subtitle-stage theme-${meta.theme || "midnight-press"} subtitle-${meta.subtitle?.position || "bottom"} preset-${meta.subtitle?.preset || "auto-contrast"} ${meta.subtitle?.enabled === false ? "subtitles-off" : ""}`}
              aria-label="当前字幕位置与样式预览"
            >
              <div className="vf-mini-meta"><i /><span /></div>
              <div className="vf-mini-title"><i /><i /></div>
              <div className="vf-subtitle-safe-band" />
              <div className="vf-mini-caption"><i /><i /></div>
            </div>
          </section>
          <section className="vf-avatar-config">
            <h3>是否加入你的形象</h3>
            <div className="vf-segments">
              <button
                disabled={!styleEditable || busy}
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
                disabled={!styleEditable || busy}
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
                      "保持右侧原位置，比标准 1/3 区域缩小 30%",
                    ],
                  ].map(([value, label, desc]) => (
                    <button
                      key={value}
                      disabled={!styleEditable || busy}
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
          {job.stage === "gate_style" && (
            <div className="vf-style-confirm">
              <div>
                <b>风格和人物占位确认完成后，才会开始生成画面</b>
                <span>当前选择：{themes.find((theme) => theme.id === (meta.theme || "midnight-press"))?.name || "午夜刊物"} · {(meta.typography?.fontSize || "large") === "extra-large" ? "超大字" : (meta.typography?.fontSize || "large") === "compact" ? "紧凑字级" : "大字"} · {meta.subtitle?.enabled === false ? "无字幕" : "使用字幕"} · {meta.avatar?.enabled ? "使用数字人" : "不使用数字人"}</span>
              </div>
              <button
                className="vf-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.approve(job.id);
                    setSelected(2);
                    await load();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "正在提交…" : "确认风格，开始生成画面"}
              </button>
            </div>
          )}
          {job.stage === "scaffold" && job.status === "failed" && (
            <div className="vf-style-confirm vf-style-recovery">
              <div>
                <b>画面工程准备失败，尚未开始生成画面</b>
                <span>先返回风格确认；你可以调整风格和数字人占位，再重新进入下一步。</span>
              </div>
              <button
                className="vf-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setRegenerateState("正在恢复风格选择…");
                  try {
                    await api.retry(job.id, "gate_style");
                    setSelected(2);
                    await load();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "正在恢复…" : "重新选择风格"}
              </button>
            </div>
          )}
          {current >= 3 && ["waiting_approval", "failed"].includes(job.status) && job.stage !== "gate_style" && (
            <div className="vf-regenerate">
              <b>需要更换风格？</b>
              <span>返回风格选择，确认后将按新风格重新生成后续画面。</span>
              <button
                className="vf-primary"
                disabled={busy}
                onClick={regenerate}
              >
                重新选择风格
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
          <section className="vf-chapter-monitor">
            <header>
              <div>
                <span>生成服务</span>
                <b>{chapterGeneration.service}</b>
              </div>
              <strong>{chapterGeneration.completed}/{chapterGeneration.current?.total || chapterGeneration.expected || "?"} 章</strong>
            </header>
            <progress max="100" value={chapterGeneration.percent} />
            <p>{chapterGenerationMessage}</p>
            {chapterGenerationRunning && (
              <p className="vf-generation-explainer" role="status">
                已完成并检查通过的章节会自动加入预览；正在生成的章节完成后也会继续更新。
              </p>
            )}
            {chapterGenerationRunning && chapterGeneration.quality && chapterGeneration.quality.phase !== "done" && (() => {
              const q = chapterGeneration.quality;
              const segs = [
                `${qualityPhaseLabel(q.phase)}${q.maxRound > 1 && q.round > 0 ? ` · 第 ${q.round}/${q.maxRound} 轮` : ""}`,
                q.chapter != null
                  ? `${q.phase === "repair" ? "正在修复" : "正在校验"}第 ${q.chapter} 章第 ${q.step} 屏${q.checkedSteps ? `（共 ${q.checkedSteps} 屏）` : ""}`
                  : "",
                q.score != null && q.targetScore != null ? `当前 ${q.score}/100，目标 ${q.targetScore}` : "",
                formatEta(q.etaSeconds),
              ].filter(Boolean);
              return (
                <p className="vf-generation-explainer vf-quality-progress" role="status" aria-live="polite">
                  {segs.join(" · ")}
                </p>
              );
            })()}
            {chapterGeneration.chapters.length > 0 && (
              <div className="vf-chapter-review-list">
                {chapterGeneration.chapters.map((chapter) => {
                  const previewable = chapter.ready
                    && (job.stage !== "chapter_gen" || ["review", "approved"].includes(chapter.status));
                  return (
                    <button
                      key={chapter.key}
                      disabled={!previewable}
                      className={selectedChapter === chapter.key ? "selected" : ""}
                      onClick={() => {
                        syncPreviewChapter(chapter.index - 1);
                        setSelectedChapter(chapter.key);
                      }}
                    >
                      <i className={chapter.status}>
                        {chapter.status === "approved" ? "✓" : chapter.index}
                      </i>
                      <span>
                        <b>{chapter.title}</b>
                        <small>
                          {chapter.status === "approved"
                            ? "已确认"
                            : chapter.status === "queued"
                              ? "等待生成"
                              : chapter.status === "generating"
                                ? "正在生成"
                              : chapter.ready
                                ? `待确认 · ${chapter.steps} 个画面步骤`
                                : "正在生成"}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          {activeChapter && (
            <div className="vf-chapter-focus">
              <div><span>当前校验章节</span><b>{activeChapter.index}. {activeChapter.title}</b><small>{activeChapter.ready ? `${activeChapter.steps} 个画面步骤已生成` : "仍在生成，请稍候"}</small></div>
              <div className="vf-check-chips"><span className={activeChapter.ready ? "ok" : "pending"}>内容文件</span><span className={previewUrl ? "ok" : "pending"}>可预览</span><span className={activeChapter.status === "approved" ? "ok" : "pending"}>已确认</span></div>
              {job.stage === "gate_chapters" && activeChapter.ready && activeChapter.status !== "approved" && (
                <button
                  className="vf-primary"
                  disabled={busy || !previewUrl}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.approveChapter(job.id, activeChapter.key);
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "正在确认…" : previewUrl ? "预览无误，本章通过" : "先加载预览"}
                </button>
              )}
            </div>
          )}
          {previewUrl && activeChapterPreviewable ? (
            <iframe
              key={`chapters-${job.stage}-${previewRevision}`}
              className="vf-live-preview"
              title="作品预览"
              src={chapterPreviewUrl}
              allow="autoplay; fullscreen"
            />
          ) : chapterGenerationRunning || incrementalPreviewBuilding ? (
            <div className="vf-preview vf-generation-preview" role="status" aria-live="polite">
              <span className="vf-loading-ring" />
              <b>{incrementalPreviewBuilding ? "正在更新已完成章节预览" : "正在生成新版画面"}</b>
              <span>{chapterGeneration.completed}/{chapterGeneration.current?.total || chapterGeneration.expected || "?"} 章完成，可以先查看已完成章节</span>
            </div>
          ) : (
            <div className="vf-preview">
              <b>VideoForge</b>
              <span>预览服务尚未启动</span>
            </div>
          )}
          <div className="vf-stage-actions">
            <button
              onClick={ensurePreview}
              disabled={busy || incrementalPreviewBuilding || (job.stage === "chapter_gen" && chapterGeneration.completed < 1)}
            >
              {busy || incrementalPreviewBuilding ? "正在更新…" : chapterGenerationRunning ? "加载已完成章节" : "加载预览"}
            </button>
            {previewUrl && (
              <a
                className="vf-action-link"
                href={chapterPreviewUrl}
                target="_blank"
                rel="noreferrer"
              >
                新窗口打开
              </a>
            )}
            {job.stage === "gate_chapters" && (
              allChaptersApproved ? (
                <button
                  className="vf-primary"
                  disabled={busy}
                  onClick={() => api.approve(job.id).then(load)}
                >
                  全部画面通过，进入配音
                </button>
              ) : (
                <button
                  className="vf-primary"
                  disabled={busy || chapterGeneration.chapters.some((c) => !c.ready)}
                  onClick={() => api.approveAllChapters(job.id).then(load)}
                  title="确认全部已生成章节并直接进入配音，无需逐章点击"
                >
                  {chapterGeneration.chapters.some((c) => !c.ready)
                    ? `还有章节在生成中…`
                    : `一键确认全部 ${chapterGeneration.chapters.length} 章并进入配音`}
                </button>
              )
            )}
          </div>
          {previewError && <p className="vf-inline-error">预览启动失败：{previewError}</p>}
          {previewNotice && <p className="vf-inline-success" role="status">{previewNotice}</p>}
        </>
      );
    if (selected === 4)
      return (
        <>
          <p className="vf-kicker">配音字幕</p>
          <h2>声音与字幕时间轴</h2>
          {["audio_synth", "subtitle_cues"].includes(job.stage) && ["queued", "running"].includes(job.status) && (
            <div className="vf-next-stage-loading vf-audio-loading" role="status" aria-live="polite">
              <span className="vf-loading-ring" />
              <div>
                <b>{activeProgressText}</b>
                <p>{job.stage === "audio_synth" ? "正在生成配音与逐字时间轴，完成后会自动进入试听。" : "配音已经完成，正在生成精确字幕时间轴。"}</p>
              </div>
              {activePercent > 0 && <strong>{activePercent}%</strong>}
            </div>
          )}
          <section className="vf-sync-preview">
            <div className="vf-sync-preview-head">
              <div>
                <b>画面、配音与字幕同步预览</b>
                <span>点击画面播放器的播放按钮，检查字幕是否跟随真实配音时间轴。</span>
              </div>
              <span className="vf-sync-preview-status">{previewUrl ? "预览已加载" : "等待预览服务"}</span>
            </div>
            {previewUrl ? (
              <iframe
                key={`audio-${previewRevision}`}
                className="vf-live-preview vf-sync-preview-frame"
                title="配音字幕同步预览"
                src={previewUrl}
                allow="autoplay; fullscreen"
              />
            ) : (
              <div className="vf-preview vf-sync-preview-empty">
                <b>VideoForge</b>
                <span>先点击下方“加载预览”</span>
              </div>
            )}
          </section>
          <div className="vf-result-grid">
            <section>
              <b>配音</b>
              <strong>{!audit ? "正在校验配音文件" : audit.audio.ok ? `${audit.audio.segments} 段配音已校验` : "未检测到配音文件（0 段）"}</strong>
              <span>{!audit ? "等待审计结果" : audit.audio.ok ? "文件存在，可进入带声音预览" : "音频合成未产出配音——可在右侧对话反馈，或重跑音频合成阶段"}</span>
            </section>
            <section>
              <b>字幕</b>
              <strong>{audit?.subtitle.enabled === false ? "本作品未启用字幕" : audit?.subtitle.ok ? "字幕时间轴已校验" : "正在校验字幕"}</strong>
              <span>{audit?.subtitle.enabled === false ? "可在风格设置中重新开启" : "跟随真实音频时间轴"}</span>
            </section>
          </div>
          <div className="vf-step-actionbar">
            <div><b>{job.stage === "gate_audio" ? "先试听配音，再生成字幕" : "检查字幕后，再进入数字人"}</b><span>右侧对话可调整某段配音，或修改字幕样式和位置。修改完成后重新播放确认。</span></div>
            <div className="vf-action-cluster">
              <button className="vf-secondary" onClick={ensurePreview}>{previewUrl ? "刷新预览" : "加载预览"}</button>
              <button className="vf-secondary" disabled={!previewUrl || !audit?.audio.ok} onClick={() => window.open(`${previewUrl}?auto=1`, "_blank")}>播放带声音预览</button>
              {job.stage === "gate_audio" && <button className="vf-primary" disabled={busy || !audit?.audio.ok} onClick={() => api.approve(job.id).then(load)}>配音通过，生成字幕</button>}
              {job.stage === "gate_subtitles" && <button className="vf-primary" disabled={busy || !audit?.subtitle.ok} onClick={() => api.approve(job.id).then(load)}>字幕通过，进入数字人</button>}
            </div>
          </div>
        </>
      );
    if (selected === 5)
      return (
        <>
          <p className="vf-kicker">数字人</p>
          <h2>
            {["avatar_media", "avatar_wire"].includes(job.stage) && job.status === "running"
              ? "正在生成数字人"
              : "选择你的出镜形象"}
          </h2>
          {["avatar_media", "avatar_wire"].includes(job.stage) &&
            ["queued", "running"].includes(job.status) && (
              <div className="vf-avatar-progress">
                <div>
                  <b>{activeProgressText}</b>
                  <strong>总进度 {activePercent}%</strong>
                </div>
                <progress max="100" value={activePercent} />
                <span>完成后会自动生成按章节拆分的预览视频。</span>
              </div>
            )}
          {(() => {
            const avatarNeedsRegeneration = Boolean(meta.avatar?.pendingRegeneration)
              || (["avatar_media", "avatar_wire"].includes(job.stage) && job.status === "failed");
            return <>
          {avatarNeedsRegeneration && (
            <div className="vf-regenerate vf-avatar-recovery" role="status">
              <b>已选择新形象，等待重新生成口型</b>
              <span>从“数字人”环节重新开始：复用现有 PPT、配音和字幕，只重新生成口型视频并接入画面。完成后需要重新验收数字人，再重新导出成片。</span>
            </div>
          )}
          <section className="vf-avatar-composite">
            <h3>数字人与画面合成预览</h3>
            <p>
              直接在当前环节检查人物占位、口型、声音和逐页画面，不需要返回“逐页生成”。
            </p>
            {previewUrl && !avatarNeedsRegeneration ? (
              <iframe
                key={`avatar-${previewRevision}`}
                className="vf-live-preview"
                title="数字人合成预览"
                src={`${previewUrl}?auto=1`}
                allow="autoplay; fullscreen"
              />
            ) : (
              <div className="vf-preview">
                <b>VideoForge</b>
                <span>{avatarNeedsRegeneration ? "新的数字人生成完成后可在这里预览" : "点击下方加载合成预览"}</span>
              </div>
            )}
            <div className="vf-stage-actions">
              <button onClick={ensurePreview}>
                {busy ? "正在启动…" : "加载合成预览"}
              </button>
              {previewUrl && !avatarNeedsRegeneration && (
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
                  disabled={busy}
                  onClick={() => void selectAvatar(asset)}
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
          <div className="vf-operation-impact">
            <b>重新生成数字人会影响什么？</b>
            <small><strong>复用：</strong>原文、口播稿、PPT 画面、配音、字幕</small>
            <small><strong>重做：</strong>数字人口型视频、逐章合成预览；之后需要重新导出 MP4</small>
          </div>
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
                disabled={busy || (["avatar_media", "avatar_wire"].includes(job.stage) && ["queued", "running"].includes(job.status))}
                onClick={() => void generateAvatar()}
              >
                {avatarNeedsRegeneration ? "仅重新生成数字人口型" : "生成数字人口型"}
              </button>
            )}
          </div>
          {avatarState && <p className={avatarState.startsWith("暂时无法") || avatarState.startsWith("切换失败") ? "vf-upload-state error" : "vf-upload-state"}>{avatarState}</p>}
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
          {avatarPreviews.length > 0 && !avatarNeedsRegeneration && (
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
          {job.stage === "gate_avatar" && (
            <div className="vf-step-actionbar">
              <div><b>{meta.avatar?.enabled ? "逐章检查口型和人物位置" : "本作品不使用数字人"}</b><span>{meta.avatar?.enabled ? `${audit?.avatar.previews || 0} 个章节预览已生成。可在右侧对话微调，完成后再确认导出。` : "可以直接进入成片导出确认。"}</span></div>
              <div className="vf-action-cluster"><button className="vf-secondary" onClick={ensurePreview}>{previewUrl ? "刷新合成预览" : "加载合成预览"}</button><button className="vf-primary" disabled={busy || (meta.avatar?.enabled && (!audit?.avatar.outputExists || !previewUrl))} onClick={() => api.approve(job.id).then(load)}>数字人验收通过，进入导出</button></div>
            </div>
          )}
            </>;
          })()}
        </>
      );
    return (
      <>
        <p className="vf-kicker">导出成片</p>
        <h2>成片文件</h2>
        {job.output?.rendering ? (
          <p className="vf-render-status">
            正在服务端渲染：{renderProgressParts[1] ?? 0}% ·{" "}
            {renderProgressParts[2] ?? "准备中"}
          </p>
        ) : job.output?.exists ? (
          <>
            <div className="vf-operation-impact">
              <b>重新导出从哪里开始？</b>
              <span>从“导出成片”开始，不返回 PPT、配音、字幕或数字人环节。</span>
              <small><strong>复用：</strong>PPT 画面、配音、字幕、数字人口型视频</small>
              <small><strong>重做：</strong>录制画面、混合声音并覆盖旧 MP4；完成后同步更新封面</small>
            </div>
            <div className="vf-stage-actions">
              <a
                className="vf-action-link vf-play-action"
                href={`/api/jobs/${job.id}/output`}
              >
                ⬇ 下载成片
                {job.output.durationSec
                  ? `（${Math.round(job.output.durationSec)} 秒）`
                  : ""}
              </a>
              <button disabled={busy} onClick={() => setRenderConfirmOpen(true)}>
                仅重新导出成片
              </button>
            </div>
            {renderConfirmOpen && (
              <div className="vf-operation-confirm" role="alertdialog" aria-label="确认重新导出成片">
                <div>
                  <b>确认覆盖当前成片？</b>
                  <span>不会重新生成 PPT、配音、字幕或数字人。预计按视频真实时长重新录制，并覆盖当前 MP4。</span>
                </div>
                <div className="vf-action-cluster">
                  <button className="vf-secondary" onClick={() => setRenderConfirmOpen(false)}>取消</button>
                  <button className="vf-primary" disabled={busy} onClick={startRender}>确认覆盖并重新导出</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="vf-step-actionbar">
            <div><b>最后确认一次完整预览</b><span>确认声音、字幕、数字人和章节切换都正常后，再开始服务端生成 MP4。</span></div>
            <button className="vf-primary" disabled={busy} onClick={job.stage === "gate_render" ? () => api.approve(job.id).then(load) : startRender}>
              {job.stage === "gate_render" ? "确认预览，开始生成成片" : "生成成片（服务端渲染）"}
            </button>
          </div>
        )}
        {previewError && <p className="vf-error">{previewError}</p>}
        <h2>播放与预览</h2>
        <p>
          点击下方按钮会在新窗口启动整片。浏览器为了保护声音播放，会要求你再点一次画面中央的播放按钮。
        </p>
        {previewUrl ? (
          <iframe
            key={`result-${previewRevision}`}
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
          <div className="vf-work-title-line" title={workTitle.original}>
            <h1>{workTitle.main}</h1>
            {workTitle.tags.length > 0 && <div className="vf-title-tags">{workTitle.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
          </div>
        </div>
        <em>
            {job.status === "done"
              ? "已完成"
              : job.status === "failed"
                ? "需要处理"
                : job.status === "waiting_approval"
                  ? "等你确认"
                  : job.status === "cancelled"
                    ? "已取消"
                    : job.status === "cancelling"
                      ? "取消中"
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
              {activeProgressEvent
                ? `${activeProgressText} · ${activePercent}%`
                : stageProgress[job.stage] || "正在处理当前任务"}
            </b>
            <span>
              这是耗时任务，页面会自动更新；可以切换环节查看已完成内容。
            </span>
          </div>
          <em>{job.status === "queued" ? "等待开始" : "进行中"}</em>
          <button type="button" onClick={() => void cancelGeneration()} disabled={busy}>
            {busy ? "正在取消..." : "取消生成"}
          </button>
        </div>
      )}
      {job.status === "cancelling" && (
        <div className="vf-long-progress" role="status">
          <i />
          <div>
            <b>正在取消…</b>
            <span>正在停止当前阶段并中止在飞任务，稍候会停在当前环节。</span>
          </div>
          <em>取消中</em>
        </div>
      )}
      {job.status === "cancelled" && (
        <div className="vf-failed-banner" role="status">
          <div className="vf-failed-banner-copy">
            <strong>已取消，已完成的内容都已保留</strong>
            <span>{job.error || "生成已被用户取消"}</span>
            <small>停在环节：{failedRetryImpact.label}</small>
          </div>
          <button type="button" onClick={() => void retryFailedStage()} disabled={busy}>
            {busy ? "正在继续..." : `从“${failedRetryImpact.label}”继续`}
          </button>
        </div>
      )}
      {job.status === "failed" && (
        <div className="vf-failed-banner" role="alert">
          <div className="vf-failed-banner-copy">
            <strong>任务失败，已停止继续处理</strong>
            <span>{job.error || "后端未返回具体错误"}</span>
            <small>失败环节：{failedRetryImpact.label}</small>
            <div className="vf-retry-impact">
              <span><b>重新操作：</b>{failedRetryImpact.redo}</span>
              <span><b>继续保留：</b>{failedRetryImpact.keep}</span>
              <span><b>完成以后：</b>{failedRetryImpact.next}</span>
            </div>
          </div>
          <button type="button" onClick={() => void retryFailedStage()} disabled={busy}>
            {busy ? "正在重新处理..." : `从“${failedRetryImpact.label}”继续`}
          </button>
        </div>
      )}
      <div className={`vf-studio ${!chatEnabled ? "vf-studio-full" : ""}`}>
        <section className="vf-stage-panel">
          <div className="vf-stage-scroll">{content}</div>
          {activeFeedback && ["口播稿审阅", "逐页生成"].includes(activePhase) && (
            <div className="vf-stage-update-mask" role="status" aria-live="polite">
              <span className="vf-loading-ring" />
              <b>{activePhase === "口播稿审阅" ? "正在更新口播稿" : activeFeedback.chapter ? "正在更新当前页面" : "正在更新全部页面"}</b>
              <small>{activeFeedback.progress_message || "正在理解你的修改要求"} · {activeFeedback.progress || 0}%</small>
            </div>
          )}
        </section>
        {chatEnabled && <aside className="vf-chat">
          <header>
            <h3>对话修改</h3>
            <p>当前查看：{activePhase}{activePhase === "逐页生成" ? chapterFeedbackScope === "global" ? " · 全部页面" : activeChapter ? ` · 第 ${activeChapter.index} 章` : "" : ""}</p>
            {activePhase === "逐页生成" && (
              <div className="vf-feedback-scope" role="group" aria-label="修改范围">
                <button type="button" className={chapterFeedbackScope === "global" ? "selected" : ""} disabled={feedbackRunning} onClick={() => setChapterFeedbackScope("global")}>全局修改</button>
                <button type="button" className={chapterFeedbackScope === "chapter" ? "selected" : ""} disabled={feedbackRunning || !activeChapter} onClick={() => setChapterFeedbackScope("chapter")}>{activeChapter ? `当前第 ${activeChapter.index} 章` : "当前页面"}</button>
              </div>
            )}
          </header>
          <div className="vf-chat-log">
            {phaseFeedback.length ? (
              phaseFeedback.map((item) => (
                <p key={item.id} className="vf-chat-message">
                  {item.message}
                  {item.attachment_url && <img className="vf-chat-attachment" src={item.attachment_url} alt="参考截图" />}
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
            {feedbackImage && <div className="vf-feedback-attachment"><img src={feedbackImage.previewUrl} alt="待发送的参考截图" /><button type="button" aria-label="移除图片" title="移除图片" onClick={() => setFeedbackImage(null)}>×</button></div>}
            {feedbackImageError && <small className="vf-feedback-image-error">{feedbackImageError}</small>}
            <textarea
              value={message}
              onChange={(e) => setMessageDrafts((drafts) => ({ ...drafts, [draftKey]: e.target.value }))}
              onPaste={handleFeedbackPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitFeedback();
                }
              }}
              placeholder="说说你想怎么改… Enter 发送，Shift+Enter 换行"
            />
            <button
              disabled={(!message.trim() && !feedbackImage) || feedbackSending || feedbackRunning}
              onClick={() => void submitFeedback()}
            >
              →
            </button>
          </div>
        </aside>}
      </div>
    </main>
  );
}
