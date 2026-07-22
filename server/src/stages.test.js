import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArtifacts } from "./stages.js";

test("assertArtifacts：缺文件 / 空文件判失败，非空文件通过", () => {
  const ws = mkdtempSync(join(tmpdir(), "vf-art-"));
  try {
    const specs = [
      { file: "script.md", label: "口播稿 script.md" },
      { file: "outline.md", label: "开发计划 outline.md" },
    ];
    // 两个都缺 → 失败，note 列出全部缺失项
    const none = assertArtifacts(ws, specs);
    assert.equal(none.ok, false);
    assert.match(none.note, /script\.md/);
    assert.match(none.note, /outline\.md/);

    // 一个存在但只有空白、一个缺 → 仍失败（空白算未产出）
    writeFileSync(join(ws, "script.md"), "   \n  ", "utf8");
    const partial = assertArtifacts(ws, specs);
    assert.equal(partial.ok, false);

    // 两个都非空且长度超过阈值 → 通过
    writeFileSync(join(ws, "script.md"), "这是一段足够长的口播稿正文内容，用于验证产物校验在文件非空时放行。", "utf8");
    writeFileSync(join(ws, "outline.md"), "# Video Outline\n主题：midnight-press\n章节若干，信息池齐备，可进入下一步。", "utf8");
    const ok = assertArtifacts(ws, specs);
    assert.equal(ok.ok, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
