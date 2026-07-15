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

function cueAtTime(cues: SubtitleCue[], timeMs: number): number {
  // Cues are ordered by start time. Find the last cue that has begun.
  let low = 0;
  let high = cues.length - 1;
  let result = 0;

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
  const [activeCue, setActiveCue] = useState(0);
  const hasCues = cues.length > 0;

  useEffect(() => {
    setActiveCue(0);
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

  const text = hasCues ? cues[activeCue]?.text ?? cues[0]!.text : fallbackText;
  if (!text) return null;

  return (
    <div className="subtitle" aria-live="off" aria-atomic="true">
      <p className={hasCues ? "subtitle__cue" : "subtitle__fallback"}>{text}</p>
    </div>
  );
}
