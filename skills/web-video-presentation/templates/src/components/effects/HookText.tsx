import { Children, type ReactNode } from "react";
import "./effects.css";

interface Props {
  /** 每个直接子元素是一行钩子大字（内部可再包 Slam/Shine）。 */
  children: ReactNode;
}

/**
 * 钩子大字栏（host-split 开场的右半屏，效果 v2a+）：配合
 * cameraCues 的 {effect:"host-split"}（左侧 1:1 人物）使用——
 * 右栏 120-150px 冲击大字逐行入场，拉前 3 秒留存。
 * 该步的底部常规字幕会自动隐藏（大字本身就是字幕）。
 * 用法：
 *   {step===0 && <HookText>
 *     <span>我是如何 <em>3 天</em></span>
 *     <span><Slam>赚够 100万</Slam> 的</span>
 *   </HookText>}
 */
export function HookText({ children }: Props) {
  return (
    <div className="fx-hooktext">
      {Children.map(children, (line, index) => (
        <div className="fx-hooktext__line" style={{ ["--fx-line" as string]: index }}>
          {line}
        </div>
      ))}
    </div>
  );
}
