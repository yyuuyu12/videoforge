// 镜头声明（效果 v1）——由章节开发时按需填写；VideoForge cameraCheck 会做
// 确定性校验（词表/倍数/预算）。没有条目 = 该步不动镜头（全景）。
//
// 约束（与 CHAPTER-CRAFT 镜头纪律一致，超出即判违规）：
//   - zoom ∈ [1.1, 2.5]；focus 默认 1.8，pan 默认 1.15
//   - 每章非空镜头 ≤ 3 个（镜头为讲解服务，不是炫技）
//   - target 必须是该 step 画面里真实存在的元素（运行时未命中会记入
//     window.__vfCameraMisses 并原地不动，审计层可见）

export type CameraEffect = "focus" | "pan" | "spotlight" | "overview";

export interface CameraCue {
  effect: CameraEffect;
  /** CSS 选择器，focus/pan/spotlight 必填；只在当前章节画面内查找。 */
  target?: string;
  /** 放大倍数，仅 focus/pan 有效。 */
  zoom?: number;
}

// chapterId -> 每步一个镜头（index = step，0-based；null = 不动）
export const CAMERA_CUES: Record<string, (CameraCue | null)[]> = {};
