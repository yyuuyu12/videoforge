import type { Job } from "../api";

export type WorkStatus = {
  label: string;
  detail: string;
  action: string;
  tone: "neutral" | "active" | "waiting" | "success" | "danger";
};

export function workStatus(work: Pick<Job, "status" | "stage">): WorkStatus {
  if (work.status === "failed")
    return { label: "需要处理", detail: "这一步没有完成", action: "查看原因", tone: "danger" };
  if (work.status === "queued")
    return { label: "排队中", detail: "准备开始制作", action: "查看进度", tone: "neutral" };
  if (work.status === "done" || work.stage === "done")
    return { label: "制作完成", detail: "可以预览并录制成片", action: "查看作品", tone: "success" };
  if (work.status === "waiting_approval" && work.stage === "gate_source")
    return { label: "等你确认原文", detail: "检查内容后再生成口播稿", action: "去确认", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_script")
    return { label: "等你确认稿子", detail: "口播稿已经写好", action: "去看稿子", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_style")
    return { label: "等你选风格", detail: "确认画面风格和数字人占位", action: "去选择", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_chapters")
    return { label: "等你验收画面", detail: "画面已经生成，可以预览", action: "去预览", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_audio")
    return { label: "等你试听配音", detail: "逐段配音已经生成", action: "去试听", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_subtitles")
    return { label: "等你检查字幕", detail: "字幕样式和时间轴已经生成", action: "去检查", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_avatar")
    return { label: "等你验收数字人", detail: "口型视频和章节预览已经生成", action: "去预览", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_render")
    return { label: "等你生成成片", detail: "所有素材已确认，可以开始导出", action: "去导出", tone: "waiting" };

  const detail: Record<string, string> = {
    gate_source: "等待确认原始内容",
    script_outline: "正在整理内容并撰写口播稿",
    scaffold: "正在搭建视频画面框架",
    chapter_gen: "正在制作每一段画面",
    audio_synth: "正在合成配音",
    subtitle_cues: "正在生成精确字幕",
    render: "正在准备导出说明",
  };
  return { label: "正在制作", detail: detail[work.stage] ?? "正在处理作品", action: "查看进度", tone: "active" };
}

export const productionSteps = [
  { id: "gate_source", label: "确认原文" },
  { id: "script_outline", label: "写稿" },
  { id: "gate_script", label: "确认稿子" },
  { id: "gate_style", label: "选择风格" },
  { id: "scaffold", label: "搭建" },
  { id: "chapter_gen", label: "制作画面" },
  { id: "gate_chapters", label: "验收画面" },
  { id: "audio_synth", label: "配音" },
  { id: "gate_audio", label: "试听配音" },
  { id: "subtitle_cues", label: "字幕" },
  { id: "gate_subtitles", label: "检查字幕" },
  { id: "avatar_gen", label: "数字人" },
  { id: "gate_avatar", label: "验收数字人" },
  { id: "gate_render", label: "确认导出" },
  { id: "render", label: "完成" },
  { id: "done", label: "完成" },
];
