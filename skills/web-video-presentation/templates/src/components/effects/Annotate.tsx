import { type ReactNode } from "react";
import "./effects.css";

interface Props {
  /** circle = 手绘椭圆圈注；underline = 手绘下划线。 */
  kind?: "circle" | "underline";
  /** 动画启动延迟（毫秒）。 */
  delay?: number;
  children: ReactNode;
}

/**
 * 手绘圈注（效果 v1）：SVG 描边动画现场"画"出圈/线，科普视频经典强调。
 * 包裹式设计（不做选择器定位），随内容排版天然对齐。
 * 用法：<Annotate kind="circle">37%</Annotate>
 */
export function Annotate({ kind = "circle", delay = 400, children }: Props) {
  return (
    <span className={`fx-annotate fx-annotate--${kind}`} style={{ ["--fx-delay" as string]: `${delay}ms` }}>
      {children}
      {kind === "circle" ? (
        <svg className="fx-annotate__svg" viewBox="0 0 120 60" preserveAspectRatio="none" aria-hidden="true">
          <path
            className="fx-annotate__path"
            d="M60 6 C 100 4, 117 16, 116 30 C 115 46, 88 56, 57 55 C 26 54, 5 45, 4 30 C 3 15, 28 5, 62 7"
            pathLength={100}
          />
        </svg>
      ) : (
        <svg className="fx-annotate__svg fx-annotate__svg--under" viewBox="0 0 120 12" preserveAspectRatio="none" aria-hidden="true">
          <path className="fx-annotate__path" d="M3 8 C 30 4, 60 9, 88 6 C 100 5, 110 6, 117 7" pathLength={100} />
        </svg>
      )}
    </span>
  );
}
