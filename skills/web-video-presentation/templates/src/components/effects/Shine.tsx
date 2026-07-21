import { type ReactNode } from "react";
import { useSpeechTrigger } from "./useSpeechTrigger";
import "./effects.css";

interface Props {
  children: ReactNode;
  /** 扫光启动延迟（毫秒，相对触发时刻）。 */
  delay?: number;
  /** 口播触发词（效果 v2b）：旁白念到该词才扫光。缺省挂载即播。 */
  word?: string;
}

/**
 * 扫光高亮（效果 v2a）：一道光从左到右扫过文字——廉价但极有效的注意力引导。
 * 包裹关键词/金句短语；每屏 ≤1 处。
 * 用法：<Shine word="收藏率">收藏率才是硬通货</Shine>
 */
export function Shine({ children, delay = 500, word }: Props) {
  const fired = useSpeechTrigger(word);
  return (
    <span
      className={`fx-shine${fired ? "" : " fx-shine--wait"}`}
      style={{ ["--fx-delay" as string]: `${delay}ms` }}
    >
      {children}
    </span>
  );
}
