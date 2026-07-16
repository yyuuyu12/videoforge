import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotPresentationSrc,
  diffAgainstSnapshot,
  isPathAllowed,
  restoreFromSnapshot,
  dropSnapshot,
} from "./feedbackTransaction.js";

function makePresentation() {
  const presDir = mkdtempSync(join(tmpdir(), "vf-tx-"));
  mkdirSync(join(presDir, "src", "chapters", "01-a"), { recursive: true });
  mkdirSync(join(presDir, "src", "registry"), { recursive: true });
  writeFileSync(join(presDir, "src", "chapters", "01-a", "A.tsx"), "export const A = 1;\n");
  writeFileSync(join(presDir, "src", "registry", "chapters.ts"), "export const CHAPTERS = [];\n");
  writeFileSync(join(presDir, "src", "App.tsx"), "export default function App() { return null; }\n");
  return presDir;
}

test("快照-差异-还原闭环", () => {
  const presDir = makePresentation();
  const manifest = snapshotPresentationSrc(presDir);
  assert.equal(Object.keys(manifest).length, 3);
  assert.deepEqual(diffAgainstSnapshot(presDir, manifest), []);

  // 模拟 Agent：改一个允许的、一个越界的、新增一个越界的
  writeFileSync(join(presDir, "src", "chapters", "01-a", "A.tsx"), "export const A = 2;\n");
  writeFileSync(join(presDir, "src", "App.tsx"), "export default function App() { return 1; }\n");
  writeFileSync(join(presDir, "src", "rogue.ts"), "export const bad = true;\n");

  const changed = diffAgainstSnapshot(presDir, manifest);
  assert.deepEqual(changed, ["App.tsx", "chapters/01-a/A.tsx", "rogue.ts"]);

  const violations = changed.filter((rel) => !isPathAllowed(rel, "01-a"));
  assert.deepEqual(violations, ["App.tsx", "rogue.ts"]);

  // 只还原越界文件：合法修改保留，越界修改还原，越界新增删除
  restoreFromSnapshot(presDir, manifest, violations);
  assert.match(readFileSync(join(presDir, "src", "App.tsx"), "utf8"), /return null/);
  assert.ok(!existsSync(join(presDir, "src", "rogue.ts")));
  assert.match(readFileSync(join(presDir, "src", "chapters", "01-a", "A.tsx"), "utf8"), /A = 2/);

  // 整体还原：合法修改也回到基线（回滚场景）
  restoreFromSnapshot(presDir, manifest);
  assert.match(readFileSync(join(presDir, "src", "chapters", "01-a", "A.tsx"), "utf8"), /A = 1/);
  dropSnapshot(presDir);
  assert.ok(!existsSync(join(presDir, ".feedback-snapshot")));
});

test("白名单规则：章节反馈的允许范围", () => {
  assert.ok(isPathAllowed("chapters/02-b/B.tsx", "02-b"));
  assert.ok(isPathAllowed("registry/chapters.ts", "02-b"));
  assert.ok(isPathAllowed("hooks/useStepper.ts", "02-b"));
  assert.ok(!isPathAllowed("chapters/03-c/C.tsx", "02-b"));
  assert.ok(!isPathAllowed("components/Subtitle.tsx", "02-b"));
  assert.ok(!isPathAllowed("registry/subtitleCues.ts", "02-b"));
  // 全局反馈不限路径（由分数与构建保护）
  assert.ok(isPathAllowed("components/Subtitle.tsx", null));
});
