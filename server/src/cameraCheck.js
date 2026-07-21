import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 镜头声明确定性校验（效果 v1 四层校验的第二层：生成时静态检查）。
 *
 * 规则与模板 registry/cameraCues.ts 头部注释一致：
 *   - effect 必须在词表内；focus/pan/spotlight 必须带 target
 *   - zoom ∈ [1.1, 2.5]
 *   - 每章非空镜头 ≤ 3（镜头为讲解服务，不是炫技）
 * target 是否真实命中由运行时（window.__vfCameraMisses）与审计层负责——
 * 静态层不渲染页面。registry 缺失 = 该作品不用镜头，直接通过。
 */

const EFFECTS = new Set(["focus", "pan", "spotlight", "magnify", "overview", "host", "host-full", "host-split"]);
/** 进入转场词表（效果 v2b）：whip 甩切，与 effect 正交。 */
const ENTERS = new Set(["whip"]);
/** 需要 target 的内容镜头（host/host-full 是数字人时刻，免 target）。 */
const CONTENT_MOVES = new Set(["focus", "pan", "spotlight", "magnify"]);
export const ZOOM_MIN = 1.1;
export const ZOOM_MAX = 3.0; // 大开大合：博主级 2-3 倍特写（2026-07-17 用户定稿）
/** focus 的 zoom 下限：1.4 以下肉眼几乎不可见（job-24 实测 1.12 = 观感"没效果"）。 */
export const FOCUS_ZOOM_MIN = 1.4;
// 密度档位（2026-07-17 用户定稿：默认密集，向知识类博主的效果密度靠拢）
export const DENSITY_BUDGETS = { restrained: 2, standard: 3, dense: 4 };
export const MOVES_PER_CHAPTER = 3; // 兼容旧调用的缺省值
export const HOSTS_PER_CHAPTER = 1;
export const HOST_FULL_PER_WORK = 1;
// 甩切只给"人↔素材"情绪升档边界（竞品实测：句级平铺直叙一律硬切）
export const WHIPS_PER_CHAPTER = 1;

export function readCameraRegistry(presDir) {
  const path = join(presDir, "src", "registry", "cameraCues.ts");
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(/CAMERA_CUES[^=]*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  try {
    return new Function(`return ${match[1]}`)();
  } catch {
    return undefined; // 存在但解析失败 = error
  }
}

export function validateCameraCues(presDir, { density = "dense" } = {}) {
  const movesPerChapter = DENSITY_BUDGETS[density] ?? MOVES_PER_CHAPTER;
  const cues = readCameraRegistry(presDir);
  const findings = [];
  if (cues === null) return { pass: true, errors: 0, warnings: 0, findings };
  if (cues === undefined) {
    return { pass: false, errors: 1, warnings: 0, findings: [{ rule: "registry-parse", severity: "error", detail: "cameraCues.ts 存在但无法解析" }] };
  }
  let hostFullTotal = 0;
  for (const [chapterId, steps] of Object.entries(cues)) {
    let moves = 0;
    let hosts = 0;
    let whips = 0;
    (steps ?? []).forEach((cue, stepIndex) => {
      if (!cue) return;
      const where = `${chapterId} 第 ${stepIndex + 1} 步`;
      if (!EFFECTS.has(cue.effect)) {
        findings.push({ rule: "camera-effect", severity: "error", detail: `${where} 未知镜头 "${cue.effect}"（词表：focus/pan/spotlight/magnify/overview/host/host-full/host-split）` });
        return;
      }
      if (cue.enter != null) {
        if (!ENTERS.has(cue.enter)) {
          findings.push({ rule: "camera-enter", severity: "error", detail: `${where} 未知转场 "${cue.enter}"（词表：whip）` });
        } else if (cue.enter === "whip") {
          whips += 1;
        }
      }
      if (CONTENT_MOVES.has(cue.effect)) {
        moves += 1;
        if (!cue.target || typeof cue.target !== "string") {
          findings.push({ rule: "camera-target", severity: "error", detail: `${where} ${cue.effect} 缺少 target 选择器` });
        }
      }
      if (cue.effect === "host") hosts += 1;
      if (cue.effect === "host-full") hostFullTotal += 1;
      if (cue.zoom != null && (cue.zoom < ZOOM_MIN || cue.zoom > ZOOM_MAX)) {
        findings.push({ rule: "camera-zoom", severity: "error", detail: `${where} zoom=${cue.zoom} 超出 [${ZOOM_MIN}, ${ZOOM_MAX}]` });
      }
      if (cue.effect === "focus" && cue.zoom != null && cue.zoom < FOCUS_ZOOM_MIN) {
        findings.push({ rule: "camera-zoom-weak", severity: "error", detail: `${where} focus zoom=${cue.zoom} 低于 ${FOCUS_ZOOM_MIN}——肉眼几乎不可见，等于没推（要轻推近用 pan）` });
      }
    });
    if (moves > movesPerChapter) {
      findings.push({ rule: "camera-budget", severity: "error", detail: `${chapterId} 共 ${moves} 个内容镜头，超出每章 ${movesPerChapter} 个预算（档位 ${density}）——镜头为讲解服务，不是炫技` });
    }
    if (hosts > HOSTS_PER_CHAPTER) {
      findings.push({ rule: "host-budget", severity: "error", detail: `${chapterId} 共 ${hosts} 个讲述者时刻，超出每章 ${HOSTS_PER_CHAPTER} 个` });
    }
    if (whips > WHIPS_PER_CHAPTER) {
      findings.push({ rule: "whip-budget", severity: "error", detail: `${chapterId} 共 ${whips} 个甩切（enter:"whip"），超出每章 ${WHIPS_PER_CHAPTER} 个——甩切只给"人↔素材"情绪升档边界，句级一律硬切` });
    }
  }
  // host-split 只允许出现在第一章、且必须是从第 1 步起的连续前缀（钩子开场专用）
  const firstChapter = Object.keys(cues)[0];
  for (const [chapterId, steps] of Object.entries(cues)) {
    const splitIdx = (steps ?? []).map((c, i) => (c?.effect === "host-split" ? i : -1)).filter((i) => i >= 0);
    if (!splitIdx.length) continue;
    if (chapterId !== firstChapter) {
      findings.push({ rule: "host-split-scope", severity: "error", detail: `${chapterId} 出现 host-split——钩子分屏只允许在第一章开头` });
    } else if (splitIdx[0] !== 0 || splitIdx.some((v, i) => v !== i)) {
      findings.push({ rule: "host-split-prefix", severity: "error", detail: `host-split 必须是第一章从第 1 步起的连续段（实际在第 ${splitIdx.map((i) => i + 1).join(",")} 步）` });
    }
  }
  if (hostFullTotal > HOST_FULL_PER_WORK) {
    findings.push({ rule: "host-full-budget", severity: "error", detail: `全片共 ${hostFullTotal} 个开场全屏（host-full），上限 ${HOST_FULL_PER_WORK} 个——它是开场专用件` });
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  return { pass: errors === 0, errors, warnings: findings.length - errors, findings };
}

export function cameraEvidence(result, limit = 5) {
  return (result.findings || [])
    .filter((f) => f.severity === "error")
    .slice(0, limit)
    .map((f) => `[${f.rule}] ${f.detail}`);
}
