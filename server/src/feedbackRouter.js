/**
 * 反馈意图路由（QUALITY-ARCHITECTURE §9 R1）。
 *
 * 右侧对话入口先分类再分发：同步/时序类问题属于媒体管线，让 Agent 改
 * 章节代码"修同步"必然顾此失彼——正确解法是重跑对应确定性阶段。
 * v1 用关键词规则，命中率不够时再升级 LLM 分类器。
 */

const SYNC_RULES = [
  { re: /(口型|嘴型|数字人|头像|讲师).{0,12}(不同步|对不上|错位|断续|卡|跳|慢|快|延迟|滞后|提前)/, stage: "avatar_media" },
  { re: /(断续|卡顿|跳帧|抽动|不连贯).{0,10}(数字人|头像|视频|口型)?/, stage: "avatar_media" },
  { re: /字幕.{0,12}(不同步|对不上|时间|快|慢|早|晚|错位|延迟|提前|滞后)/, stage: "subtitle_cues" },
  { re: /(音画|声音|音频|配音).{0,12}(不同步|对不上|错位|延迟|滞后|提前|时间)/, stage: "audio_synth" },
  { re: /(配音|音频|声音).{0,10}(缺|少|漏|没有|错段|重复)/, stage: "audio_synth" },
  { re: /(重新)?(合成|生成).{0,6}(配音|音频|语音)/, stage: "audio_synth" },
  { re: /时长.{0,10}(不对|对不上|误差|不一致)/, stage: "avatar_media" },
];

const GLOBAL_RULES = [
  /换(一个|个)?主题/,
  /(整体|全局|所有页|全部章节).{0,10}(风格|配色|色调|字号|字体)/,
  /(风格|主题).{0,6}(整体|全部|统一)(换|改|调)/,
];

const STAGE_LABELS = {
  audio_synth: "配音合成（会级联重做字幕与数字人）",
  subtitle_cues: "精确字幕（会级联重做数字人接线）",
  avatar_media: "数字人生成（重新推理口型与章节切片）",
};

/**
 * 返回 { route: "agent" } 或
 * { route: "pipeline", stage, label, reason } 或 { route: "global", reason }。
 */
export function classifyFeedback(message, phase) {
  const text = String(message || "");
  // 稿件/原文阶段没有媒体管线可言，全部走 Agent（改 md）
  if (["原文确认", "口播稿审阅"].includes(phase)) return { route: "agent" };
  for (const rule of SYNC_RULES) {
    if (rule.re.test(text)) {
      return {
        route: "pipeline",
        stage: rule.stage,
        label: STAGE_LABELS[rule.stage],
        reason: "音画/时序类问题属于媒体管线，由确定性阶段重跑修复；逐页修改代码无法解决且容易引发新问题",
      };
    }
  }
  if (GLOBAL_RULES.some((re) => re.test(text))) {
    return {
      route: "global",
      reason: "全局风格类修改应在「选择风格」环节更换主题配置并全量重建，逐章改代码会造成风格不一致",
    };
  }
  return { route: "agent" };
}
