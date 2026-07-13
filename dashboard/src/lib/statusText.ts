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
  if (work.status === "waiting_approval" && work.stage === "gate_script")
    return { label: "等你确认稿子", detail: "口播稿已经写好", action: "去看稿子", tone: "waiting" };
  if (work.status === "waiting_approval" && work.stage === "gate_chapters")
    return { label: "等你验收画面", detail: "画面已经生成，可以预览", action: "去预览", tone: "waiting" };

  const detail: Record<string, string> = {
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
  { id: "script_outline", label: "写稿" },
  { id: "gate_script", label: "确认稿子" },
  { id: "scaffold", label: "搭建" },
  { id: "chapter_gen", label: "制作画面" },
  { id: "gate_chapters", label: "验收画面" },
  { id: "audio_synth", label: "配音" },
  { id: "subtitle_cues", label: "字幕" },
  { id: "render", label: "完成" },
  { id: "done", label: "完成" },
];
