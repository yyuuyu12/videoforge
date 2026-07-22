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

test("媒体裸放：<img 无 MediaFrame 记 warn，有则放行", () => {
  const bare = makeChapter({
    "Demo.tsx": 'export const D = () => <img src="/media/shot.png" alt="" />;\n',
  });
  const bareResult = lintChapters(bare);
  assert.equal(bareResult.pass, true); // warn 级不阻断
  assert.equal(lintDefectSummary(bareResult)["lint:bare-media"], 1);

  const wrapped = makeChapter({
    "Demo.tsx": 'import { MediaFrame } from "../../components/effects/MediaFrame";\nexport const D = () => <MediaFrame src="/media/shot.png" label="来源" tilt={-4} />;\n',
  });
  assert.equal(lintChapters(wrapped).findings.length, 0);

  const wrappedRaw = makeChapter({
    "Demo.tsx": 'import { MediaFrame } from "../../components/effects/MediaFrame";\nexport const D = () => <MediaFrame label="来源"><img src="/media/a.png" alt="" /></MediaFrame>;\n',
  });
  assert.equal(lintChapters(wrappedRaw).findings.length, 0);
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

function makeMultiChapter(chapters) {
  const presDir = mkdtempSync(join(tmpdir(), "vf-lint-multi-"));
  for (const [dir, files] of Object.entries(chapters)) {
    const chapterDir = join(presDir, "src", "chapters", dir);
    mkdirSync(chapterDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(chapterDir, name), content);
    }
  }
  return presDir;
}

test("跨章复读：同一句出现在 ≥3 章判 error（job-32 实证）", () => {
  const tail = "这不是孤立指标，要放进完整的分发链路里理解。";
  const presDir = makeMultiChapter({
    "01-a": { "narrations.ts": `export const narrations=["视频进入冷启动。${tail}"];\n` },
    "02-b": { "narrations.ts": `export const narrations=["随机曝光五百次。${tail}"];\n` },
    "03-c": { "narrations.ts": `export const narrations=["完播与点赞两道闸门。${tail}"];\n` },
  });
  const result = lintChapters(presDir);
  assert.equal(result.pass, false);
  const dup = result.findings.filter((f) => f.rule === "cross-chapter-repetition");
  assert.equal(dup.length, 1);
  assert.match(dup[0].detail, /3 个章节/);
});

test("跨章复读：两章重复不判、JSX 填充文案三章重复判", () => {
  const two = makeMultiChapter({
    "01-a": { "narrations.ts": 'export const narrations=["先看真实受众反馈情况"];\n' },
    "02-b": { "narrations.ts": 'export const narrations=["先看真实受众反馈情况"];\n' },
  });
  assert.equal(lintChapters(two).findings.filter((f) => f.rule === "cross-chapter-repetition").length, 0);
  const jsx = makeMultiChapter({
    "01-a": { "A.tsx": 'export const A=()=><span>{"先看真实受众反馈"}</span>;\n' },
    "02-b": { "B.tsx": 'export const B=()=><span>{"先看真实受众反馈"}</span>;\n' },
    "03-c": { "C.tsx": 'export const C=()=><span>{"先看真实受众反馈"}</span>;\n' },
  });
  const dup = lintChapters(jsx).findings.filter((f) => f.rule === "cross-chapter-repetition");
  assert.equal(dup.length, 1);
});
