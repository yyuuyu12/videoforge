import { useEffect, useRef, useState } from "react";
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
}

/**
 * 数字滚动（效果 v1）：从 from 滚到 to，ease-out 收尾 + 落定弹跳。
 * 用法：<Counter to={37} suffix="%" />
 */
export function Counter({ to, from = 0, duration = 1200, decimals = 0, prefix = "", suffix = "", delay = 250 }: Props) {
  const [value, setValue] = useState(from);
  const [settled, setSettled] = useState(false);
  const frameRef = useRef(0);

  useEffect(() => {
    setSettled(false);
    setValue(from);
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
  }, [to, from, duration, delay]);

  return (
    <span className={`fx-counter${settled ? " fx-counter--settled" : ""}`}>
      {prefix}
      {value.toFixed(decimals)}
      {suffix}
    </span>
  );
}
