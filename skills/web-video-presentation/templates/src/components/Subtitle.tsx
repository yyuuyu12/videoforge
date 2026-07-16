import { useEffect, useMemo, useState } from "react";
import { SUBTITLE_CUES, type SubtitleCue } from "../registry/subtitleCues";
import "./Subtitle.css";

interface SubtitleProps {
  chapterId: string;
  step: number;
  /** Used when timing data has not been generated for this narration. */
  fallbackText: string;
  /** Returns the audio element currently owned by useAudioPlayer. */
  getAudioEl: () => HTMLAudioElement | null;
}

function chunkFallbackText(text: string) {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    // 电影字幕契约：尾部分隔标点（。，、；：…）不显示，？！保留语气
    const value = current.replace(/[。．.，,、；;：:…\s]+$/, "").trim();
    if (value) chunks.push(value);
    current = "";
  };
  for (const char of text.trim()) {
    if (!current && /[，、；,;\s]/.test(char)) continue;
    current += char;
    if (/[。！？.!?…]/.test(char) || (/[，、；,;]/.test(char) && current.length >= 6) || current.length >= 10) flush();
  }
  flush();
  return chunks;
}

function cueAtTime(cues: SubtitleCue[], timeMs: number): number {
  // Cues are ordered by start time. Find the last cue that has begun.
  let low = 0;
  let high = cues.length - 1;
  let result = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle]!.startMs <= timeMs) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

/**
 * Stage subtitle overlay. Audio time is sampled on every animation frame so
 * cue changes stay in lockstep with playback rather than waiting for the
 * browser's comparatively sparse `timeupdate` events.
 */
export function Subtitle({ chapterId, step, fallbackText, getAudioEl }: SubtitleProps) {
  const cues = useMemo(
    () => SUBTITLE_CUES[chapterId]?.[step] ?? [],
    [chapterId, step],
  );
  const [activeCue, setActiveCue] = useState(-1);
  const [fallbackCue, setFallbackCue] = useState(0);
  const hasCues = cues.length > 0;
  const fallbackCues = useMemo(() => chunkFallbackText(fallbackText), [fallbackText]);

  useEffect(() => {
    setActiveCue(-1);
    if (!hasCues) return;

    let frame = 0;
    let previousCue = -1;
    const sync = () => {
      const audio = getAudioEl();
      const timeMs = (audio?.currentTime ?? 0) * 1000;
      const nextCue = cueAtTime(cues, timeMs);
      if (nextCue !== previousCue) {
        previousCue = nextCue;
        setActiveCue(nextCue);
      }
      frame = requestAnimationFrame(sync);
    };

    frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [cues, getAudioEl, hasCues]);

  useEffect(() => {
    setFallbackCue(0);
    if (hasCues || fallbackCues.length < 2) return;
    let frame = 0;
    const startedAt = performance.now();
    const rotate = (now: number) => {
      setFallbackCue(Math.floor((now - startedAt) / 1800) % fallbackCues.length);
      frame = requestAnimationFrame(rotate);
    };
    frame = requestAnimationFrame(rotate);
    return () => cancelAnimationFrame(frame);
  }, [fallbackCues, hasCues]);

  const text = hasCues
    ? activeCue >= 0
      ? cues[activeCue]?.text ?? ""
      : ""
    : fallbackCues[fallbackCue] ?? "";
  if (!text) return null;

  return (
    <div className="subtitle" aria-live="off" aria-atomic="true">
      <p className={hasCues ? "subtitle__cue" : "subtitle__fallback"}>{text}</p>
    </div>
  );
}
