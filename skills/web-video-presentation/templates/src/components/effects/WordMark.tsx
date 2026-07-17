import { useEffect, useRef, useState, type ReactNode } from "react";
import { SUBTITLE_CUES } from "../../registry/subtitleCues";
import { useEffects } from "../EffectsContext";
import "./effects.css";

interface Props {
  /** 触发词；缺省用 children 的纯文本。命中 = 当前字幕 cue 含该词。 */
  word?: string;
  children: ReactNode;
}

/**
 * 逐词跟读高亮（效果 v1）：口播念到某个词的瞬间，画面里对应元素同步
 * 点亮。粒度 = 字幕 cue（≤10 字 ≈ 1-2.5s），复用现有 cue 时钟，零新增
 * 数据管道；v2 可升级 words.json 字级精度。
 * 用法：<WordMark word="收藏率"><span className="metric">收藏率</span></WordMark>
 */
export function WordMark({ word, children }: Props) {
  const { chapterId, step, getAudioEl } = useEffects();
  const [on, setOn] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    setOn(false);
    const needle = (word ?? wrapRef.current?.textContent ?? "").trim();
    const cues = SUBTITLE_CUES[chapterId]?.[step] ?? [];
    if (!needle || !cues.length) return;

    let frame = 0;
    let latched = false; // 点亮后保持到本步结束（讲过的重点不熄灭）
    const tick = () => {
      if (!latched) {
        const timeMs = (getAudioEl()?.currentTime ?? 0) * 1000;
        let active = -1;
        for (let i = 0; i < cues.length; i += 1) {
          if (cues[i]!.startMs <= timeMs) active = i;
          else break;
        }
        if (active >= 0 && cues[active]!.text.includes(needle)) {
          latched = true;
          setOn(true);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [chapterId, step, word, getAudioEl]);

  return (
    <span ref={wrapRef} className={`fx-wordmark${on ? " fx-wordmark--on" : ""}`}>
      {children}
    </span>
  );
}
