import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintChapters, lintDefectSummary, lintEvidence } from "./chapterLint.js";

function makeChapter(files) {
  const presDir = mkdtempSync(join(tmpdir(), "vf-lint-"));
  const chapterDir = join(presDir, "src", "chapters", "01-demo");
  mkdirSync(chapterDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(chapterDir, name), content);
  }
  return presDir;
}

test("字号下限：css 与内联样式都能抓到", () => {
  const presDir = makeChapter({
    "Demo.css": ".kicker { font-size: 14px; }\n.title { font-size: 48px; }\n",
    "Demo.tsx": 'export const D = () => <p style={{ fontSize: 16 }}>x</p>;\n',
  });
  const result = lintChapters(presDir);
  assert.equal(result.pass, false);
  assert.equal(result.errors, 2);
  const evidence = lintEvidence(result);
  assert.match(evidence[0], /Demo\.css:1 \[font-size-min\]/);
  assert.match(evidence[1], /Demo\.tsx:1 \[font-size-min\]/);
});

test("lint-allow 豁免通道", () => {
  const presDir = makeChapter({
    "Demo.css": ".fine-print { font-size: 14px; } /* lint-allow: 设计性小字 */\n",
  });
  assert.equal(lintChapters(presDir).pass, true);
});

test("警告级规则：写死颜色与超长文本只记账不阻断", () => {
  const long = "这是一段非常长的中文说明文字，".repeat(5);
  const presDir = makeChapter({
    "Demo.css": ".box { color: #ff6600; }\n",
    "Demo.tsx": `export const T = () => <p>{"${long}"}</p>;\n`,
  });
  const result = lintChapters(presDir);
  assert.equal(result.pass, true);
  assert.equal(result.warnings, 2);
  const defects = lintDefectSummary(result);
  assert.equal(defects["lint:hardcoded-color"], 1);
  assert.equal(defects["lint:overlong-text"], 1);
});

test("使用主题 token 的行不报颜色违规", () => {
  const presDir = makeChapter({
    "Demo.css": ".box { color: var(--accent); border: 1px solid var(--line, #ddd); }\n",
  });
  assert.equal(lintChapters(presDir).findings.length, 0);
});

test("干净章节全绿", () => {
  const presDir = makeChapter({
    "Demo.css": ".title { font-size: 48px; color: var(--text); }\n",
    "Demo.tsx": 'export const D = () => <h1 className="title">短标题</h1>;\n',
  });
  const result = lintChapters(presDir);
  assert.equal(result.pass, true);
  assert.equal(result.findings.length, 0);
});
