import "./effects.css";

interface Props {
  /** 本章序号（1 起）。 */
  no: number;
  /** 全片章节总数。 */
  total: number;
  title: string;
  /** 可选副题/一句话预告。 */
  sub?: string;
  /** anchor = 章题外画"设计工具选中框"（锚点方块 + 描边生长，博主片签名动作）。 */
  variant?: "plain" | "anchor";
  /** 谢幕：step 0 展示后，在 step 1 再渲染一次并置 exit，卡片消散退场
   *  而非瞬间消失。用法：{step===1 && <ChapterCard {...同参} exit/>} */
  exit?: boolean;
}

/**
 * 章节转场卡（效果 v2a，v2b 加 anchor 变体与 exit 谢幕）：大数字 + 章题 +
 * 全片进度点——"课程感"的来源。用于章首 step 0 的整屏内容。
 * 用法：{step===0 && <ChapterCard no={3} total={9} title="判断的落差" sub="方法撞上产能上限" variant="anchor"/>}
 */
export function ChapterCard({ no, total, title, sub, variant = "plain", exit = false }: Props) {
  return (
    <div className={`fx-chaptercard${exit ? " fx-chaptercard--exit" : ""}`}>
      <div className="fx-chaptercard__no">{String(no).padStart(2, "0")}</div>
      <div className="fx-chaptercard__body">
        {variant === "anchor" ? (
          <div className="fx-chaptercard__anchorbox">
            <h1 className="fx-chaptercard__title">{title}</h1>
            <svg className="fx-chaptercard__frame" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <rect x="1" y="1" width="98" height="98" pathLength={100} />
            </svg>
            <i className="fx-chaptercard__handle fx-chaptercard__handle--tl" aria-hidden="true" />
            <i className="fx-chaptercard__handle fx-chaptercard__handle--tr" aria-hidden="true" />
            <i className="fx-chaptercard__handle fx-chaptercard__handle--bl" aria-hidden="true" />
            <i className="fx-chaptercard__handle fx-chaptercard__handle--br" aria-hidden="true" />
          </div>
        ) : (
          <h1 className="fx-chaptercard__title">{title}</h1>
        )}
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
