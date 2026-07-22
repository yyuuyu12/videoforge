import { useEffect, useRef, useState } from "react";
import { useSpeechTrigger } from "./useSpeechTrigger";
import { reportSfx } from "./sfxReporter";
import "./effects.css";

interface Props {
  to: number;
  from?: number;
  /** 毫秒；落定后带一次轻微弹跳。 */
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** 挂载后延迟启动（配合入场动画节奏）。 */
  delay?: number;
  /** 随值变色 [起色, 终色]（语义渐变：涨→暖、跌→冷）。只收主题 token，
   *  如 ["var(--text)", "var(--accent)"]——写死 hex 会被 lint 记账。 */
  colorRamp?: [string, string];
  /** 口播触发词（效果 v2b）：旁白念到该词才开始滚动——数字"跑出来"的
   *  时刻踩在报数那一拍上。缺省保持旧行为（挂载 delay 后即滚）。 */
  word?: string;
}

/**
 * 数字滚动（效果 v1，v2b 加 colorRamp 随值变色）：从 from 滚到 to，
 * ease-out 收尾 + 落定弹跳。用法：<Counter to={37} suffix="%" colorRamp={["var(--text)", "var(--accent)"]} />
 */
export function Counter({ to, from = 0, duration = 1200, decimals = 0, prefix = "", suffix = "", delay = 250, colorRamp, word }: Props) {
  const [value, setValue] = useState(from);
  const [settled, setSettled] = useState(false);
  const frameRef = useRef(0);
  const fired = useSpeechTrigger(word);

  useEffect(() => {
    setSettled(false);
    setValue(from);
    if (!fired) return; // 等口播念到触发词（无 word 时 fired 立即为 true）
    reportSfx("counter", delay); // 音效上报（P0-A）：滚动铺底声与数字起跑同拍
    let start = 0;
    const run = (now: number) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setValue(from + (to - from) * eased);
      if (p < 1) frameRef.current = requestAnimationFrame(run);
      else setSettled(true);
    };
    const timer = window.setTimeout(() => {
      frameRef.current = requestAnimationFrame(run);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frameRef.current);
    };
  }, [to, from, duration, delay, fired]);

  // 变色进度跟随已滚动的比例（与数字同一条 ease 曲线，落定即终色）
  const progress = to === from ? 1 : Math.min(1, Math.max(0, (value - from) / (to - from)));
  const rampStyle = colorRamp
    ? { color: `color-mix(in srgb, ${colorRamp[1]} ${Math.round(progress * 100)}%, ${colorRamp[0]})` }
    : undefined;

  // 前后缀独立 span 并强制正体（2026-07-22 根治 job-30 "¥2" 字形互压）：
  // hero-num 类斜体英文展示字体常缺 ¥/％/中文字形，回退字体走正体且度量
  // 不同，斜体数字的负侧边距会直接压进回退字形——正斜混排必须各占其位。
  return (
    <span className={`fx-counter${settled ? " fx-counter--settled" : ""}`} style={rampStyle}>
      {prefix ? <span className="fx-counter__affix">{prefix}</span> : null}
      {value.toFixed(decimals)}
      {suffix ? <span className="fx-counter__affix">{suffix}</span> : null}
    </span>
  );
}
