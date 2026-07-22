import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChapterStructure } from "./cameraChoreographer.js";

/**
 * readChapterStructure 的形状兼容锁（"解析 AI 代码不能猜形状"教训第 4 次
 * 回写）：四种实证合法写法各锁一条，新形状缺陷出现时先在这里加用例。
 */

function makePres({ registry, chapters }) {
  const presDir = mkdtempSync(join(tmpdir(), "vf-struct-"));
  mkdirSync(join(presDir, "src", "registry"), { recursive: true });
  writeFileSync(join(presDir, "src", "registry", "chapters.ts"), registry);
  for (const [rel, content] of Object.entries(chapters)) {
    const path = join(presDir, "src", "chapters", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return presDir;
}

test("形状①②：registry 字面量 id（双/单引号）", () => {
  const presDir = makePres({
    registry: `export const CHAPTERS=[{id:"intro",title:"开"},{id:'body',title:'中'}];`,
    chapters: {
      "intro/narrations.ts": `export const narrations=["a","b"];`,
      "body/narrations.ts": `export const narrations=["c"];`,
    },
  });
  const s = readChapterStructure(presDir);
  assert.deepEqual(s.order, ["intro", "body"]);
  assert.deepEqual(s.steps, [2, 1]);
});

test("形状③：扁平文件布局 <id>.narrations.ts", () => {
  const presDir = makePres({
    registry: `export const CHAPTERS=[{id:"solo",title:"独"}];`,
    chapters: { "solo.narrations.ts": `export const narrations=["x","y","z"];` },
  });
  const s = readChapterStructure(presDir);
  assert.deepEqual(s.order, ["solo"]);
  assert.deepEqual(s.steps, [3]);
});

test("形状④：id 从章节模块 re-export 且 ≠ 目录名（job-32 实证）", () => {
  const presDir = makePres({
    registry: [
      `import C1,{id as i1,narrations as n1} from "../chapters/01-coldopen";`,
      `import C2,{id as i2,narrations as n2} from "../chapters/03-coldstart";`,
      `export const CHAPTERS=[{id:i1,narrations:n1,Component:C1},{id:i2,narrations:n2,Component:C2}];`,
    ].join("\n"),
    chapters: {
      "01-coldopen/index.tsx": `export const id="coldopen";export default function C(){return null}`,
      "01-coldopen/narrations.ts": `export const narrations=["一","二"];`,
      "03-coldstart/index.tsx": `export const id="coldstart";export default function C(){return null}`,
      "03-coldstart/narrations.ts": `export const narrations=["三"];`,
    },
  });
  const s = readChapterStructure(presDir);
  assert.deepEqual(s.order, ["coldopen", "coldstart"]);
  assert.deepEqual(s.dirs, ["01-coldopen", "03-coldstart"]);
  assert.deepEqual(s.steps, [2, 1]);
});
