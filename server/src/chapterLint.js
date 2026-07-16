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
    if (!/\.(tsx|css)$/.test(entry.name)) return [];
    return [path.slice(base.length + 1).replace(/\\/g, "/")];
  });
}

function lintLine(rel, lineText, lineNo, findings) {
  if (lineText.includes("lint-allow")) return;
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

/** 对 presentation/src/chapters 下全部 tsx/css 做静态检查。 */
export function lintChapters(presDir) {
  const root = join(presDir, "src", "chapters");
  const findings = [];
  for (const rel of walkChapterFiles(root)) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((text, index) => lintLine(rel, text, index + 1, findings));
  }
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
