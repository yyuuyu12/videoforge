import { type ReactNode } from "react";
import "./effects.css";

interface Props {
  children: ReactNode;
  /** 入场延迟（毫秒）。 */
  delay?: number;
}

/**
 * 大数字重锤（效果 v2a）：从 2.2 倍缩放砸入 + 落点轻震——数据冲击力翻倍。
 * 包裹大数字/超短标题；每屏 ≤1 处；可与 <Counter> 组合（Slam 包 Counter）。
 * 用法：<Slam><Counter to={400} suffix="万" /></Slam>
 */
export function Slam({ children, delay = 150 }: Props) {
  return (
    <span className="fx-slam" style={{ ["--fx-delay" as string]: `${delay}ms` }}>
      {children}
    </span>
  );
}
