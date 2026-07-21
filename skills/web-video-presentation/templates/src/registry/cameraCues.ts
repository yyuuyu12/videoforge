// 镜头声明（效果 v1）——由章节开发时按需填写；VideoForge cameraCheck 会做
// 确定性校验（词表/倍数/预算）。没有条目 = 该步不动镜头（全景）。
//
// 约束（与 CHAPTER-CRAFT 镜头纪律一致，超出即判违规）：
//   - 大开大合基调：zoom ∈ [1.1, 3.0]；focus 默认 2.0（<1.4 判违规——肉眼
//     不可见等于没推）；magnify 放大镜默认 2.6（强推近+镜片压暗圈，给关键
//     数字/核心结论的暴力特写）；pan 轻推 1.2
//   - 每章非空内容镜头（focus/pan/spotlight）≤ 3 个（镜头为讲解服务，不是炫技）
//   - target 必须是该 step 画面里真实存在的元素（运行时未命中会记入
//     window.__vfCameraMisses 并原地不动，审计层可见）
//   - host（讲述者时刻）：数字人窗口放大到画面主位、内容压暗退后——用在
//     开场钩子/章节转折/结尾召唤，每章 ≤1；host-full（开场全屏出镜）全片 ≤1，
//     通常只用在第一章第一步。两者免 target。该步画面应当极简（内容层已退后）。

export type CameraEffect =
  | "focus"
  | "pan"
  | "spotlight"
  | "magnify"
  | "overview"
  | "host"
  | "host-full"
  | "host-split";

/** 进入本步的转场（与 effect 正交）。whip = 径向甩切：~190ms 的
 *  scale+blur 冲击帧，只用在"人↔素材"的情绪升档边界（典型：章首
 *  数字人时刻/章节卡所在步）；每章 ≤1，句级平铺直叙一律硬切。 */
export type CameraEnter = "whip";

export interface CameraCue {
  effect: CameraEffect;
  /** CSS 选择器，focus/pan/spotlight 必填；只在当前章节画面内查找。 */
  target?: string;
  /** 放大倍数，仅 focus/pan 有效。 */
  zoom?: number;
  /** 进入本步的转场声明，见 CameraEnter。 */
  enter?: CameraEnter;
}

// chapterId -> 每步一个镜头（index = step，0-based；null = 不动）
export const CAMERA_CUES: Record<string, (CameraCue | null)[]> = {};
