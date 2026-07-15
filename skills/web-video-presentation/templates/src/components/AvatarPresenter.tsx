import { useEffect, useRef, useState } from "react";
import { AVATAR_CONFIG } from "../registry/avatarConfig";
import "./AvatarPresenter.css";

interface Props {
  getAudioEl(): HTMLAudioElement | null;
  /** 全局 step 序号（跨章节累计），来自 useStepper 的 globalIndex。 */
  globalStep: number;
  /** 全部 step 音频地址（播放顺序），用于累计偏移。 */
  audioSources: string[];
}

function readDuration(audio: HTMLAudioElement): number | null {
  return Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : null;
}

/**
 * 讲师头像窗口：muted 视频只做帧源，时间轴完全从动于音频时钟——
 * 每帧 video.currentTime = 之前所有 step 的音频总时长 + 当前音频位置。
 * 禁止自由播放（口型漂移）与每步 seek（每句闪跳）。
 * AVATAR_CONFIG.enabled=false 时由 App 直接不渲染本组件。
 */
export function AvatarPresenter({ getAudioEl, globalStep, audioSources }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [durations, setDurations] = useState<number[]>(() =>
    audioSources.map(() => 0),
  );

  useEffect(() => {
    const audioElements = audioSources.map((src, index) => {
      const audio = new Audio(src);
      audio.preload = "metadata";
      const updateDuration = () => {
        const duration = readDuration(audio);
        if (duration == null) return;
        setDurations((current) => {
          if (Math.abs((current[index] ?? 0) - duration) < 0.001) return current;
          const next = [...current];
          next[index] = duration;
          return next;
        });
      };
      audio.addEventListener("loadedmetadata", updateDuration);
      return { audio, updateDuration };
    });

    return () => {
      audioElements.forEach(({ audio, updateDuration }) => {
        audio.removeEventListener("loadedmetadata", updateDuration);
        audio.src = "";
      });
    };
  }, [audioSources]);

  useEffect(() => {
    let frameId = 0;
    const sync = () => {
      const video = videoRef.current;
      if (video) {
        const priorDuration = durations
          .slice(0, globalStep)
          .reduce((total, duration) => total + duration, 0);
        const stepTime = getAudioEl()?.currentTime ?? 0;
        const targetTime = priorDuration + stepTime;
        const maxTime = Number.isFinite(video.duration)
          ? Math.max(0, video.duration - 0.01)
          : targetTime;

        video.pause();
        if (Math.abs(video.currentTime - targetTime) > 0.025) {
          video.currentTime = Math.min(targetTime, maxTime);
        }
      }
      frameId = requestAnimationFrame(sync);
    };

    frameId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frameId);
  }, [durations, getAudioEl, globalStep]);

  return (
    <aside
      className={`avatar-presenter avatar-presenter--${AVATAR_CONFIG.position}`}
      data-no-advance
      aria-label="讲师"
    >
      <video
        ref={videoRef}
        className="avatar-presenter__video"
        src={`${import.meta.env.BASE_URL}avatar/lipsync.mp4`}
        muted
        playsInline
        preload="metadata"
      />
    </aside>
  );
}
