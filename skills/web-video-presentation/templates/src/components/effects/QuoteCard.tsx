import { type ReactNode } from "react";
import "./effects.css";

interface Props {
  children: ReactNode;
  /** 可选署名/出处（如"——本片核心结论"）。 */
  by?: string;
}

/**
 * 金句卡（效果 v2a）：核心观点的全屏大字卡——观众会暂停截图的那一帧。
 * 作为某个 step 的整屏内容使用（不是叠加层）。全片 ≤2 张。
 * 用法：{step===3 && <QuoteCard by="核心结论">流量不是奖励内容，是奖励判断</QuoteCard>}
 */
export function QuoteCard({ children, by }: Props) {
  return (
    <div className="fx-quotecard">
      <span className="fx-quotecard__mark" aria-hidden="true">“</span>
      <blockquote className="fx-quotecard__text">{children}</blockquote>
      {by && <cite className="fx-quotecard__by">{by}</cite>}
    </div>
  );
}
