import { useSpeechTrigger } from "./useSpeechTrigger";
import "./effects.css";

export interface FlowNode {
  id: string;
  label: string;
  /** 副标签（英文小字，如 Gateway / HTTP）。 */
  sub?: string;
  /** 图标字形：emoji 或单字符（🎯 🎤 🧠 ⚙ 等），不依赖外部图标库。 */
  icon?: string;
  /** 色调：normal=白描边、accent=主题强调色、fail=红色（失败路径终点）。 */
  tone?: "normal" | "accent" | "fail";
  /** 位置（相对容器的百分比坐标，节点中心锚点）。 */
  x: number;
  y: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  /** fail=红色失败路径；normal 用主题弱色。 */
  tone?: "normal" | "fail";
  /** 边上的小标签（如"噪声环境"）。 */
  label?: string;
}

interface Props {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** 口播触发词：旁白念到才开始逐节点生长；缺省挂载即生长。 */
  word?: string;
  /** 每个节点的生长间隔（毫秒）。 */
  stagger?: number;
  /** 容器宽高比（默认 16/7，占屏上部大区）。 */
  ratio?: number;
}

/**
 * 发光流程图（2026-07-23 竞品对标：黑底发光手绘图解是对标账号出现频率
 * 最高的图解套路）。节点/边纯数据驱动：icon+发光描边节点卡、虚线流动边、
 * 红色失败路径、逐节点生长（word 触发踩口播节拍，SVG 边随节点渐显）。
 * 每屏 ≤1 个；节点数建议 3-7；流程/链路/因果类内容优先用它而不是卡片阵。
 * 用法：
 *   <FlowDiagram word="链路" nodes={[{id:"in",label:"用户请求",icon:"👤",x:50,y:12}, ...]}
 *     edges={[{from:"in",to:"gw"},{from:"gw",to:"fail",tone:"fail",label:"噪声"}]} />
 */
export function FlowDiagram({ nodes, edges, word, stagger = 260, ratio = 16 / 7 }: Props) {
  const fired = useSpeechTrigger(word);
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  return (
    <div className={`fx-flow${fired ? " fx-flow--on" : ""}`} style={{ aspectRatio: String(ratio) }}>
      <svg className="fx-flow__edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {edges.map((e, i) => {
          const a = nodes.find((n) => n.id === e.from);
          const b = nodes.find((n) => n.id === e.to);
          if (!a || !b) return null;
          const delay = (Math.max(order.get(e.from) ?? 0, order.get(e.to) ?? 0) * stagger + 120) / 1000;
          return (
            <g key={i} className={`fx-flow__edge${e.tone === "fail" ? " fx-flow__edge--fail" : ""}`} style={{ transitionDelay: `${delay}s` }}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />
              {e.label && (
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 2} textAnchor="middle">{e.label}</text>
              )}
            </g>
          );
        })}
      </svg>
      {nodes.map((n, i) => (
        <div
          key={n.id}
          className={`fx-flow__node fx-flow__node--${n.tone || "normal"}`}
          style={{ left: `${n.x}%`, top: `${n.y}%`, transitionDelay: `${(i * stagger) / 1000}s` }}
        >
          {n.icon && <span className="fx-flow__icon" aria-hidden="true">{n.icon}</span>}
          <span className="fx-flow__label">{n.label}</span>
          {n.sub && <span className="fx-flow__sub">{n.sub}</span>}
        </div>
      ))}
    </div>
  );
}
