import { useEffect, useState } from "react";
import { SUBTITLE_CUES } from "../../registry/subtitleCues";
import { useEffects } from "../EffectsContext";

interface Options {
  /** 触发时刻无法解析（无 word / 本步无 cue / 词不在任何 cue 里）时的
   *  行为：fire = 立即触发（保持"挂载即播"旧行为，效果件默认）；
   *  off = 保持熄灭（WordMark 语义：词没被念到就不亮）。 */
  whenUnresolved?: "fire" | "off";
}

/** 手动模式/音频未就绪的宽限：超过该时长仍拿不到音频元素就直接触发，
 *  保证手动点击预览时效果照常演，不会因为没有时钟而卡死。 */
const NO_AUDIO_GRACE_MS = 800;

/**
 * 口播触发时钟（效果 v2b）：返回"旁白是否已经念到 word"。
 * 精度 = words.json 字级时间戳（cue.charMs），缺字级数据时退化为
 * 该词所在 cue 的起始时刻（≈1-2.5s 句级精度）。触发后 latch 到本步结束。
 * 这是 Counter/Slam/Shine/Annotate 对齐口播节拍的统一入口——
 * 效果不再按"挂载 + 写死毫秒"播，而是踩在旁白念到它的那一拍。
 */
export function useSpeechTrigger(word?: string, { whenUnresolved = "fire" }: Options = {}): boolean {
  const { chapterId, step, getAudioEl } = useEffects();
  const [fired, setFired] = useState(false);

  useEffect(() => {
    const needle = (word ?? "").trim();
    const cues = SUBTITLE_CUES[chapterId]?.[step] ?? [];
    let triggerMs: number | null = null;
    if (needle && cues.length) {
      for (const cue of cues) {
        const at = cue.text.indexOf(needle);
        if (at >= 0) {
          triggerMs = cue.charMs?.[at] ?? cue.startMs;
          break;
        }
      }
    }
    if (triggerMs == null) {
      setFired(whenUnresolved === "fire");
      return;
    }
    setFired(false);
    let frame = 0;
    const bornAt = performance.now();
    const tick = () => {
      const audio = getAudioEl();
      if (!audio && performance.now() - bornAt > NO_AUDIO_GRACE_MS) {
        setFired(true); // 手动模式无音频时钟：宽限后照常演
        return;
      }
      if (audio && audio.currentTime * 1000 >= triggerMs!) {
        setFired(true);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [chapterId, step, word, getAudioEl, whenUnresolved]);

  return fired;
}
