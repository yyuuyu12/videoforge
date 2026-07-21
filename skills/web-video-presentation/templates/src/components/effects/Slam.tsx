import { type ReactNode } from "react";
import { useSpeechTrigger } from "./useSpeechTrigger";
import "./effects.css";

interface Props {
  children: ReactNode;
  /** 入场延迟（毫秒，相对触发时刻）。 */
  delay?: number;
  /** 口播触发词（效果 v2b）：旁白念到该词的瞬间才砸入——数字重锤
   *  踩在报出这个数的那一拍上。缺省保持旧行为（挂载即播）。 */
  word?: string;
}

/**
 * 大数字重锤（效果 v2a）：从 2.2 倍缩放砸入 + 落点轻震——数据冲击力翻倍。
 * 包裹大数字/超短标题；每屏 ≤1 处；可与 <Counter> 组合（Slam 包 Counter）。
 * 用法：<Slam word="四百万"><Counter to={400} suffix="万" /></Slam>
 */
export function Slam({ children, delay = 150, word }: Props) {
  const fired = useSpeechTrigger(word);
  return (
    <span
      className={`fx-slam${fired ? "" : " fx-slam--wait"}`}
      style={{ ["--fx-delay" as string]: `${delay}ms` }}
    >
      {children}
    </span>
  );
}
