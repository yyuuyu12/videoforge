import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 字幕 cue 数据校验器（QUALITY-ARCHITECTURE §5 契约的确定性执法）。
 *
 * 回写来源：job-13/14 实测旧切分器产出 20-24 字的超长 cue（用户可见
 * 症状："几十个字两三行"），同类缺陷 ≥2 次 → 按铁律转确定性规则。
 * subtitle_cues 阶段生成后立即校验，违规即阶段失败，超长 cue 从此
 * 不可能溜过门禁。
 */

export const CUE_HARD_LIMIT = 10; // 中文硬上限（目标 8）

export function readCueRegistry(presDir) {
  const path = join(presDir, "src", "registry", "subtitleCues.ts");
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(/=\s*(\{[\s\S]*\});/);
  if (!match) return null;
  try {
    // registry 是我们自己 generator 的产物（对象字面量），本地可信
    return new Function(`return ${match[1]}`)();
  } catch {
    return null;
  }
}

export function validateSubtitleCues(presDir) {
  const cues = readCueRegistry(presDir);
  const findings = [];
  if (!cues) {
    return { pass: false, errors: 1, warnings: 0, findings: [{ rule: "registry-missing", severity: "error", detail: "subtitleCues.ts 缺失或无法解析" }] };
  }
  for (const [chapterId, steps] of Object.entries(cues)) {
    steps.forEach((stepCues, stepIndex) => {
      const where = `${chapterId} 第 ${stepIndex + 1} 步`;
      if (!stepCues || !stepCues.length) {
        // 有音频却没 cue = TTS 没返回逐字时间戳（words.json 缺失），播放层
        // 会退化成 1800ms 墙钟轮换——必然不同步，是 error；无音频的过场步
        // 没有同步问题，保持 warn 观察。
        const audioPath = join(presDir, "public", "audio", chapterId, `${stepIndex + 1}.mp3`);
        if (existsSync(audioPath)) {
          findings.push({ rule: "step-silent-fallback", severity: "error", detail: `${where} 有音频但没有 cue（words.json 缺失）——字幕将走 1800ms 墙钟轮换必然不同步，需重跑音频合成取回逐字时间戳` });
        } else {
          findings.push({ rule: "step-no-cues", severity: "warn", detail: `${where} 没有 cue（无音频过场步，播放时走整段兜底）` });
        }
        return;
      }
      let lastStart = -1;
      stepCues.forEach((cue, cueIndex) => {
        // 上限按正文计：尾部保留的？！是窄字符且承载语气，不占字数预算
        const chars = [...String(cue.text || "").replace(/[？！?!]+$/, "")].length;
        // 电影字幕契约：cue 尾部不允许出现分隔标点（。，、；：…），？！保留
        if (/[。．.，,、；;：:…]$/.test(String(cue.text || ""))) {
          findings.push({ rule: "cue-trailing-punct", severity: "error", detail: `${where} 第 ${cueIndex + 1} 条以分隔标点结尾（"${String(cue.text).slice(-6)}"）——展示层已分页，尾标点应剥离` });
        }
        // 纯拉丁/数字词或短语（如 "Transformer"、"Claude Free"）是窄字符
        // 且不可按中文规则拆分，与切分器规则一致地豁免
        const unsplittableLatin = /^[A-Za-z0-9_.\/\- ]+$/.test(String(cue.text || ""));
        if (chars > CUE_HARD_LIMIT && !unsplittableLatin) {
          findings.push({ rule: "cue-too-long", severity: "error", detail: `${where} 第 ${cueIndex + 1} 条 ${chars} 字（"${String(cue.text).slice(0, 14)}…"）超过 ${CUE_HARD_LIMIT} 字硬上限` });
        }
        if (!(Number(cue.startMs) > lastStart)) {
          findings.push({ rule: "cue-time-order", severity: "error", detail: `${where} 第 ${cueIndex + 1} 条时间戳未递增（${cue.startMs}ms）` });
        }
        lastStart = Number(cue.startMs);
        // 字级时间轴（效果 v2b）：charMs 必须与 text 逐字对齐——错位会把
        // WordMark/效果触发的时刻指到别的字上
        if (cue.charMs != null && cue.charMs.length !== [...String(cue.text || "")].length) {
          findings.push({ rule: "cue-charms-misaligned", severity: "error", detail: `${where} 第 ${cueIndex + 1} 条 charMs ${cue.charMs.length} 项 ≠ 文本 ${[...String(cue.text || "")].length} 字——字级时间轴错位` });
        }
      });
    });
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  return { pass: errors === 0, errors, warnings: findings.length - errors, findings, checkedAt: new Date().toISOString() };
}

export function cueEvidence(result, limit = 6) {
  return (result.findings || [])
    .filter((f) => f.severity === "error")
    .slice(0, limit)
    .map((f) => `[${f.rule}] ${f.detail}`);
}
