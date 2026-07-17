import "./effects.css";

interface Props {
  /** 本章序号（1 起）。 */
  no: number;
  /** 全片章节总数。 */
  total: number;
  title: string;
  /** 可选副题/一句话预告。 */
  sub?: string;
}

/**
 * 章节转场卡（效果 v2a）：大数字 + 章题 + 全片进度点——"课程感"的来源。
 * 用于章首 step 0 的整屏内容（口播念章节引入句的那一步）。
 * 用法：{step===0 && <ChapterCard no={3} total={9} title="判断的落差" sub="方法撞上产能上限"/>}
 */
export function ChapterCard({ no, total, title, sub }: Props) {
  return (
    <div className="fx-chaptercard">
      <div className="fx-chaptercard__no">{String(no).padStart(2, "0")}</div>
      <div className="fx-chaptercard__body">
        <h1 className="fx-chaptercard__title">{title}</h1>
        {sub && <p className="fx-chaptercard__sub">{sub}</p>}
        <div className="fx-chaptercard__progress" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < no ? "on" : ""} />
          ))}
        </div>
      </div>
    </div>
  );
}
