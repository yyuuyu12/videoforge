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
 * 逐词跟读高亮（效果 v1，v2b 升级字级精度）：口播念到某个词的瞬间，
 * 画面里对应元素同步点亮。精度 = words.json 字级时间戳（cue.charMs，
 * 点亮时刻就是该词第一个字的真实开口时刻）；旧数据无 charMs 时退化为
 * 该词所在 cue 的起始时刻（≈1-2.5s 句级精度）。
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

    // 触发时刻：该词首字的真实开口时刻（charMs），退化时用 cue 起点。
    // 词不在本步任何 cue 里 = 不点亮（WordMark 语义：没念到就不亮）。
    let triggerMs: number | null = null;
    for (const cue of cues) {
      const at = cue.text.indexOf(needle);
      if (at >= 0) {
        triggerMs = cue.charMs?.[at] ?? cue.startMs;
        break;
      }
    }
    if (triggerMs == null) return;

    let frame = 0;
    const tick = () => {
      const timeMs = (getAudioEl()?.currentTime ?? 0) * 1000;
      if (timeMs >= triggerMs!) {
        setOn(true); // 点亮后保持到本步结束（讲过的重点不熄灭）
        return;
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
