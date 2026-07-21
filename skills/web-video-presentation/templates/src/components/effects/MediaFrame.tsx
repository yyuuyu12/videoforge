import type { ReactNode } from "react";
import "./effects.css";

interface Props {
  /** 图片地址；不传则渲染 children（自绘 UI/嵌入内容同样享受包装）。 */
  src?: string;
  alt?: string;
  /** 左上角角标（来源/工具名，mono 小签）。 */
  label?: string;
  /** 3D 倾角（度，绕 Y 轴）。截图禁止全片同角度：相邻实例交替 ±3~6。 */
  tilt?: number;
  /** 框内持续运动：push=缓推（默认）、drift=横漂、none=静止（仅动图内容用）。 */
  motion?: "push" | "drift" | "none";
  children?: ReactNode;
}

/**
 * 媒体容器（效果 v2b）：截图/屏录/自绘 UI 的标准包装——描边圆角浮卡 +
 * 角标 + 边缘暗角 + 框内 Ken Burns 持续运动 + 可选 3D 倾角。
 * 对标知识类博主片"截图永不裸放、没有一帧是静止的"的规律。
 * 用法：<MediaFrame src="/media/shot.png" label="RunningHub" tilt={-4} />
 */
export function MediaFrame({ src, alt = "", label, tilt = 0, motion = "push", children }: Props) {
  return (
    <figure
      className="fx-mediaframe"
      style={tilt ? ({ "--mf-tilt": `${tilt}deg` } as React.CSSProperties) : undefined}
    >
      <div className="fx-mediaframe__viewport">
        <div className={`fx-mediaframe__motion fx-mediaframe__motion--${motion}`}>
          {src ? <img className="fx-mediaframe__img" src={src} alt={alt} /> : children}
        </div>
        <i className="fx-mediaframe__vignette" aria-hidden="true" />
      </div>
      {label && <figcaption className="fx-mediaframe__label">{label}</figcaption>}
    </figure>
  );
}
