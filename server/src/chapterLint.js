import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 章节静态 linter（QUALITY-ARCHITECTURE §8 L2 的执行器）。
 *
 * 把浏览器审计里反复出现的"可确定缺陷"降级为毫秒级静态规则：
 * 不用起浏览器就能在章节生成后 / 对话修改后立刻抓到违规，
 * 并给出精确到文件+行号的证据（修复 Agent 不再靠截图猜）。
 *
 * 例外通道：同一行带 `lint-allow` 注释可豁免（设计性特例自担责任）。
 * 规则分级：error 在受保护事务中阻断；warn 只记账观察。
 */

export const MIN_FONT_PX = 20;
const CJK_LITERAL_LIMIT = 45;

function walkChapterFiles(root, base = root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return walkChapterFiles(path, base);
    if (!/\.(tsx|ts|css)$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return [path.slice(base.length + 1).replace(/\\/g, "/")];
  });
}

function lintLine(rel, lineText, lineNo, findings, fileUsesMediaFrame = false) {
  if (lineText.includes("lint-allow")) return;
  // 媒体裸放（效果 v2b，竞品实证"截图永不平放"）：章节里出现 <img 但全文件
  // 未使用 MediaFrame 包装。warn 级先记账校准，稳定后可升 error。
  if (rel.endsWith(".tsx") && /<img[\s>]/.test(lineText) && !fileUsesMediaFrame) {
    findings.push({ file: rel, line: lineNo, rule: "bare-media", severity: "warn", detail: "截图/媒体图片裸放——应包 <MediaFrame>（描边浮卡+角标+框内运动），见 CHAPTER-CRAFT 媒体容器条目" });
  }
  // 字号下限：css `font-size: NNpx` 与 tsx 内联 `fontSize: NN|"NNpx"`
  for (const m of lineText.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
    const px = Number.parseFloat(m[1]);
    if (px < MIN_FONT_PX) {
      findings.push({ file: rel, line: lineNo, rule: "font-size-min", severity: "error", detail: `${px}px 低于 ${MIN_FONT_PX}px 下限（手机端不可读）` });
    }
  }
  for (const m of lineText.matchAll(/fontSize:\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/g)) {
    const px = Number.parseFloat(m[1]);
    if (px < MIN_FONT_PX) {
      findings.push({ file: rel, line: lineNo, rule: "font-size-min", severity: "error", detail: `内联 fontSize ${px} 低于 ${MIN_FONT_PX}px 下限` });
    }
  }
  // 主题纪律：章节内写死十六进制色（应使用主题 token var(--…)）
  if (/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/.test(lineText) && !lineText.includes("var(--")) {
    findings.push({ file: rel, line: lineNo, rule: "hardcoded-color", severity: "warn", detail: "写死颜色绕过主题 token，换主题时会失配" });
  }
  // 单块中文超长（CHAPTER-CRAFT 信息预算：提示拆 step 或删减）
  if (rel.endsWith(".tsx")) {
    for (const m of lineText.matchAll(/["'`]([^"'`]{20,}?)["'`]/g)) {
      const cjk = (m[1].match(/[一-鿿]/g) || []).length;
      if (cjk > CJK_LITERAL_LIMIT) {
        findings.push({ file: rel, line: lineNo, rule: "overlong-text", severity: "warn", detail: `单块 ${cjk} 个中文字符，超出单屏信息预算，应拆 step 或删减` });
      }
    }
  }
}

/** 跨章复读检测（2026-07-22 job-32 实证：12/13 章旁白挂同一句尾巴、
 *  "观察A/观察B"填充文案三章逐字复读——单文件规则看不见跨章重复）。
 *  按句子粒度统计（字符串字面量按 。！？； 切句，≥6 个中文字符才计），
 *  同一句出现在 ≥3 个章节 = error（复读机文案，喂修复循环改写）。 */
const DUP_MIN_CJK = 6;
const DUP_MIN_CHAPTERS = 3;

function collectDuplicateSentences(root, findings) {
  const owners = new Map(); // sentence -> { chapters: Map(chapterKey -> {file, line}) }
  for (const rel of walkChapterFiles(root)) {
    if (!/\.(tsx|ts)$/.test(rel)) continue;
    const chapterKey = rel.includes("/") ? rel.split("/")[0] : rel.replace(/\.(narrations)?\.?tsx?$/, "");
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (text.includes("lint-allow")) return;
      for (const m of text.matchAll(/["'`]([^"'`]{6,})["'`]/g)) {
        for (const raw of m[1].split(/[。！？；\n]/)) {
          const sentence = raw.trim();
          const cjk = (sentence.match(/[一-鿿]/g) || []).length;
          if (cjk < DUP_MIN_CJK) continue;
          const entry = owners.get(sentence) || { chapters: new Map() };
          if (!entry.chapters.has(chapterKey)) entry.chapters.set(chapterKey, { file: rel, line: index + 1 });
          owners.set(sentence, entry);
        }
      }
    });
  }
  for (const [sentence, entry] of owners) {
    if (entry.chapters.size < DUP_MIN_CHAPTERS) continue;
    const first = entry.chapters.values().next().value;
    findings.push({
      file: first.file,
      line: first.line,
      rule: "cross-chapter-repetition",
      severity: "error",
      detail: `「${sentence.slice(0, 24)}」在 ${entry.chapters.size} 个章节逐字复读（${[...entry.chapters.keys()].slice(0, 4).join("、")}）——填充式文案，须改写为各章独有的具体内容`,
    });
  }
}

/** 对 presentation/src/chapters 下全部 tsx/ts/css 做静态检查。 */
export function lintChapters(presDir) {
  const root = join(presDir, "src", "chapters");
  const findings = [];
  for (const rel of walkChapterFiles(root)) {
    const content = readFileSync(join(root, rel), "utf8");
    const usesMediaFrame = content.includes("MediaFrame");
    content.split("\n").forEach((text, index) => lintLine(rel, text, index + 1, findings, usesMediaFrame));
  }
  collectDuplicateSentences(root, findings);
  const errors = findings.filter((f) => f.severity === "error");
  return {
    pass: errors.length === 0,
    errors: errors.length,
    warnings: findings.length - errors.length,
    findings,
    checkedAt: new Date().toISOString(),
  };
}

/** 账本归因：按规则聚合计数（喂 repeat-offenders 铁律）。 */
export function lintDefectSummary(result) {
  const defects = {};
  for (const f of result.findings || []) {
    const key = `lint:${f.rule}`;
    defects[key] = (defects[key] || 0) + 1;
  }
  return defects;
}

/** 给修复/反馈 Agent 的精确证据行（文件+行号，不靠截图猜）。 */
export function lintEvidence(result, limit = 10) {
  return (result.findings || [])
    .filter((f) => f.severity === "error")
    .slice(0, limit)
    .map((f) => `${f.file}:${f.line} [${f.rule}] ${f.detail}`);
}
