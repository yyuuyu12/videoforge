import { type ReactNode } from "react";
import "./effects.css";

interface Props {
  children: ReactNode;
  /** 扫光启动延迟（毫秒）。 */
  delay?: number;
}

/**
 * 扫光高亮（效果 v2a）：一道光从左到右扫过文字——廉价但极有效的注意力引导。
 * 包裹关键词/金句短语；每屏 ≤1 处。
 * 用法：<Shine delay={600}>收藏率才是硬通货</Shine>
 */
export function Shine({ children, delay = 500 }: Props) {
  return (
    <span className="fx-shine" style={{ ["--fx-delay" as string]: `${delay}ms` }}>
      {children}
    </span>
  );
}
