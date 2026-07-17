import { useEffect, useRef, type ReactNode } from "react";
import { CAMERA_CUES, type CameraCue } from "../registry/cameraCues";
import "./CameraLayer.css";

interface Props {
  chapterId: string;
  step: number;
  children: ReactNode;
}

declare global {
  interface Window {
    __vfCameraMisses?: { chapterId: string; step: number; target: string }[];
  }
}

// 大开大合基调（2026-07-17 用户定稿）：focus 常规 2.0、magnify 放大镜 2.6——
// 效果要一眼可见，1.1x 级别的"轻推"只留给 pan。
const ZOOM_DEFAULT: Record<string, number> = { focus: 2.0, pan: 1.2, magnify: 2.6 };
const ZOOM_MIN = 1.1;
const ZOOM_MAX = 3.0;
/** 入场动画普遍 ≤500ms；先等它们落定再测量，避免取到中间态矩形。 */
const MEASURE_DELAY_MS = 550;

function clampZoom(cue: CameraCue): number {
  const raw = cue.zoom ?? ZOOM_DEFAULT[cue.effect] ?? 1.5;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
}

/**
 * CSS 摄像机层（效果 v1）：按 registry 声明对章节画面做推近/平移/聚光。
 * 字幕与数字人位于本层之外，镜头运动不影响它们。渲染器录的是真实
 * 播放，本层动了成片里镜头就动了——渲染管线零改动。
 * target 未命中时原地不动并记入 window.__vfCameraMisses（审计可见）。
 */
export function CameraLayer({ chapterId, step, children }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const spotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const spot = spotRef.current;
    if (!layer || !spot) return;

    const cue = CAMERA_CUES[chapterId]?.[step] ?? null;

    const reset = () => {
      layer.style.transform = "none";
      spot.style.opacity = "0";
    };

    // host/host-full 是数字人时刻：内容层保持全景（压暗由 App 的遮罩层负责）
    if (!cue || cue.effect === "overview" || cue.effect === "host" || cue.effect === "host-full" || !cue.target) {
      if (cue && !["overview", "host", "host-full"].includes(cue.effect) && !cue.target) {
        (window.__vfCameraMisses ??= []).push({ chapterId, step, target: "(missing target)" });
      }
      reset();
      return;
    }

    const timer = window.setTimeout(() => {
      const el = layer.querySelector<HTMLElement>(cue.target!);
      if (!el) {
        (window.__vfCameraMisses ??= []).push({ chapterId, step, target: cue.target! });
        reset();
        return;
      }
      // 在"无变换"状态下测量，得到稳定的本地坐标（screen px / scale0 = 本地 px）
      const prevTransition = layer.style.transition;
      layer.style.transition = "none";
      layer.style.transform = "none";
      void layer.offsetWidth; // 强制回流，让测量基于复位后的布局
      const layerRect = layer.getBoundingClientRect();
      const scale0 = layerRect.width / layer.offsetWidth || 1;
      const t = el.getBoundingClientRect();
      const cx = (t.left + t.width / 2 - layerRect.left) / scale0;
      const cy = (t.top + t.height / 2 - layerRect.top) / scale0;
      const W = layer.offsetWidth;
      const H = layer.offsetHeight;

      if (cue.effect === "spotlight") {
        // 聚光：不动镜头，四周压暗聚焦视线
        const rx = Math.max(t.width, 120) / scale0 * 0.72;
        const ry = Math.max(t.height, 120) / scale0 * 0.72;
        spot.style.setProperty("--spot-x", `${(cx / W) * 100}%`);
        spot.style.setProperty("--spot-y", `${(cy / H) * 100}%`);
        spot.style.setProperty("--spot-rx", `${rx}px`);
        spot.style.setProperty("--spot-ry", `${ry}px`);
        layer.style.transition = prevTransition;
        spot.style.opacity = "1";
        return;
      }

      const zoom = clampZoom(cue);
      // 目标居中，且取景框不越出画面（平移量夹在合法区间内）
      const tx = Math.min(0, Math.max(W - zoom * W, W / 2 - zoom * cx));
      const ty = Math.min(0, Math.max(H - zoom * H, H / 2 - zoom * cy));
      layer.style.transition = prevTransition;
      layer.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${zoom})`;
      if (cue.effect === "magnify") {
        // 放大镜：强推近 + 画面中心亮、四周压暗的镜片圈（推近后目标已居中）
        spot.style.setProperty("--spot-x", "50%");
        spot.style.setProperty("--spot-y", "50%");
        spot.style.setProperty("--spot-rx", `${(t.width / scale0) * zoom * 0.62}px`);
        spot.style.setProperty("--spot-ry", `${(t.height / scale0) * zoom * 0.62}px`);
        spot.style.opacity = "1";
      } else {
        spot.style.opacity = "0";
      }
    }, MEASURE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [chapterId, step]);

  return (
    <div className="camera-viewport">
      <div ref={layerRef} className="camera-layer">
        {children}
      </div>
      <div ref={spotRef} className="camera-spotlight" aria-hidden="true" />
    </div>
  );
}
