import { useEffect, useRef, useState } from "react";
import { AVATAR_CONFIG } from "../registry/avatarConfig";
import "./AvatarPresenter.css";

interface Props {
  getAudioEl(): HTMLAudioElement | null;
  /** 全局 step 序号（跨章节累计），来自 useStepper 的 globalIndex。 */
  globalStep: number;
  /** 全部 step 音频地址（播放顺序），用于累计偏移。 */
  audioSources: string[];
  /**
   * 数字人时刻（效果 v1）："host" = 讲述者时刻（窗口放大到画面主位），
   * "full" = 开场全屏出镜；缺省小窗。由 App 从 CAMERA_CUES 推导传入。
   */
  hostMode?: "none" | "host" | "full" | "split";
}

function readDuration(audio: HTMLAudioElement): number | null {
  return Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : null;
}

/** 偏差超过此值才硬 seek（换步/换章）；小偏差用播放速率悄悄追齐。 */
const HARD_SEEK_THRESHOLD = 0.5;
/** 暂停态的落位精度：停在正确的帧上即可，避免 seek 风暴。 */
const PARK_THRESHOLD = 0.2;

/**
 * 讲师头像窗口：muted 视频跟随音频时钟"播放 + 微调"——
 * 音频播放时视频正常 play()，每帧只测量偏差：|偏差|<0.5s 用
 * playbackRate 0.9~1.1 缓慢追齐（肉眼不可见），更大偏差（换步/
 * 换章）才做一次硬 seek；音频暂停时视频暂停并落位到对应帧。
 * 禁止逐帧 seek 驱动：lipsync.mp4 关键帧间隔达 10s，每次 seek
 * 都要从关键帧起解码，每秒 60 次 seek 实测只能渲染出几帧
 * （job-20"一顿一顿"的根因）。
 */
export function AvatarPresenter({ getAudioEl, globalStep, audioSources, hostMode = "none" }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const blurRef = useRef<HTMLVideoElement | null>(null);
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
      if (video && video.readyState >= 1) {
        const audio = getAudioEl();
        const priorDuration = durations
          .slice(0, globalStep)
          .reduce((total, duration) => total + duration, 0);
        const stepTime = audio?.currentTime ?? 0;
        const maxTime = Number.isFinite(video.duration)
          ? Math.max(0, video.duration - 0.01)
          : Number.POSITIVE_INFINITY;
        const target = Math.min(priorDuration + stepTime, maxTime);
        const drift = video.currentTime - target;
        const audioPlaying = audio != null && !audio.paused && !audio.ended;

        if (audioPlaying) {
          if (Math.abs(drift) > HARD_SEEK_THRESHOLD) {
            video.currentTime = target;
            video.playbackRate = 1;
          } else {
            video.playbackRate = Math.min(1.1, Math.max(0.9, 1 - drift * 0.5));
          }
          if (video.paused) void video.play().catch(() => {});
        } else {
          if (!video.paused) video.pause();
          if (Math.abs(drift) > PARK_THRESHOLD) video.currentTime = target;
        }
        // 全屏模式的模糊填充背景：同一套"播放+微调"跟随，模糊层允许更松的精度
        const blur = blurRef.current;
        if (blur && blur.readyState >= 1) {
          const blurDrift = blur.currentTime - target;
          if (audioPlaying) {
            if (Math.abs(blurDrift) > HARD_SEEK_THRESHOLD) { blur.currentTime = target; blur.playbackRate = 1; }
            else blur.playbackRate = Math.min(1.1, Math.max(0.9, 1 - blurDrift * 0.5));
            if (blur.paused) void blur.play().catch(() => {});
          } else {
            if (!blur.paused) blur.pause();
            if (Math.abs(blurDrift) > PARK_THRESHOLD) blur.currentTime = target;
          }
        }
      }
      frameId = requestAnimationFrame(sync);
    };

    frameId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frameId);
  }, [durations, getAudioEl, globalStep]);

  return (
    <>
      {/* 开场全屏：同源模糊填充背景（竖幅素材配横屏舞台的标准美化） */}
      {hostMode === "full" && (
        <div className="avatar-blurfill" aria-hidden="true">
          <video
            ref={blurRef}
            className="avatar-blurfill__video"
            src={`${import.meta.env.BASE_URL}avatar/lipsync.mp4`}
            muted
            playsInline
            preload="auto"
          />
        </div>
      )}
      <aside
        className={`avatar-presenter avatar-presenter--${AVATAR_CONFIG.position}${
          hostMode !== "none" ? ` avatar-presenter--host-${hostMode}` : ""
        }`}
        data-no-advance
        aria-label="讲师"
      >
        <video
          ref={videoRef}
          className="avatar-presenter__video"
          src={`${import.meta.env.BASE_URL}avatar/lipsync.mp4`}
          muted
          playsInline
          preload="auto"
        />
      </aside>
    </>
  );
}
