import { useEffect, useRef, type ReactNode } from "react";
import { CAMERA_CUES, type CameraCue } from "../registry/cameraCues";
import { reportSfx } from "./effects/sfxReporter";
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
  const punchRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    const spot = spotRef.current;
    if (!layer || !spot) return;

    const cue = CAMERA_CUES[chapterId]?.[step] ?? null;

    // 甩切（效果 v2b）：进入本步时一帧径向冲击（scale+blur 速降），模拟
    // 博主片"人↔素材"边界的运动模糊甩切。一次性 WAAPI 动画，与镜头
    // transform / 呼吸层互不干扰；句级平铺直叙不要用（cameraCheck 限每章 1 个）。
    if (cue?.enter === "whip" && punchRef.current?.animate) {
      punchRef.current.animate(
        [
          { transform: "scale(1.16)", filter: "blur(14px)", opacity: 0.75 },
          { transform: "scale(1)", filter: "blur(0px)", opacity: 1 },
        ],
        { duration: 190, easing: "cubic-bezier(0.2, 0.85, 0.3, 1)" },
      );
      reportSfx("whip");
    }

    const reset = () => {
      layer.style.transform = "none";
      spot.style.opacity = "0";
    };

    // host/host-full 是数字人时刻：内容层保持全景（压暗由 App 的遮罩层负责）
    if (!cue || cue.effect === "overview" || cue.effect === "host" || cue.effect === "host-full" || cue.effect === "host-split" || !cue.target) {
      if (cue && !["overview", "host", "host-full", "host-split"].includes(cue.effect) && !cue.target) {
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

      // 取景框守卫（job-25 实翻车："2015"被切成"015"）：只保证**目标自身**
      // 完整落在取景框内，不管画面上其他不相关文字（页眉/页脚/序号这类
      // 离目标很远的小字，推近时被排除在画面外是正常的，不是缺陷）。
      // 2026-07-17 用户拍板纠偏：上一版扫全画面文字，页眉页脚被框边擦到
      // 就整体判定"切字"→逐级降档→兜底聚光，结果是全片放大缩小被废掉，
      // 换成一堆和叙事无关的忽亮忽暗——这是绕路，不是修复，已撤销。
      const targetLocal = {
        l: (t.left - layerRect.left) / scale0,
        r: (t.right - layerRect.left) / scale0,
        top: (t.top - layerRect.top) / scale0,
        bot: (t.bottom - layerRect.top) / scale0,
      };
      const MARGIN = 12; // 目标四周留白，纯视觉呼吸感，不是安全区判定
      const frameFor = (z: number) => {
        const fx = Math.min(0, Math.max(W - z * W, W / 2 - z * cx));
        const fy = Math.min(0, Math.max(H - z * H, H / 2 - z * cy));
        return { fx, fy, vx0: -fx / z, vx1: (-fx + W) / z, vy0: -fy / z, vy1: (-fy + H) / z };
      };
      const targetFits = (z: number) => {
        const { vx0, vx1, vy0, vy1 } = frameFor(z);
        return (
          targetLocal.l - MARGIN >= vx0 &&
          targetLocal.r + MARGIN <= vx1 &&
          targetLocal.top - MARGIN >= vy0 &&
          targetLocal.bot + MARGIN <= vy1
        );
      };
      // 目标本身的最大可行倍率（宽高两个维度的瓶颈取更小值）
      const targetMaxZoom = Math.min(
        W / (targetLocal.r - targetLocal.l + MARGIN * 2),
        H / (targetLocal.bot - targetLocal.top + MARGIN * 2),
      );
      let zoom = Math.min(clampZoom(cue), Math.max(1.05, targetMaxZoom));
      // 边缘钳制可能仍让目标贴边溢出（目标离画面边界很近时）：小步降档到贴合
      while (zoom > 1.05 && !targetFits(zoom)) zoom = Math.round((zoom - 0.1) * 100) / 100;
      layer.style.transition = prevTransition;
      const { fx: tx, fy: ty } = frameFor(zoom);
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
        {/* 甩切冲击层（效果 v2b）：只承接一次性 whip 动画，平时无样式开销 */}
        <div ref={punchRef} className="camera-punch">
          {/* 呼吸感微推（效果 v2a）：全程 1.0→1.045 极缓往复，画面永不完全静止。
              与镜头变换嵌套复合——推近时呼吸仍在，博主片的"隐形生命感"。 */}
          <div className="camera-breath">{children}</div>
        </div>
      </div>
      <div ref={spotRef} className="camera-spotlight" aria-hidden="true" />
    </div>
  );
}
