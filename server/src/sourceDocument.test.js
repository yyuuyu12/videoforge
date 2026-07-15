import test from "node:test";
import assert from "node:assert/strict";
import { createSourceDocument, formatReadableParagraphs } from "./sourceDocument.js";

test("formats long speech text into readable paragraphs without changing its wording", () => {
  const source = `${"第一句话很长，".repeat(12)}结束。${"第二句话也很长，".repeat(12)}完成！最后一句。`;
  const formatted = formatReadableParagraphs(source, 40);
  assert.ok(formatted.includes("\n\n"));
  assert.equal(formatted.replace(/\n/g, ""), source);
});

test("creates a source document with title, body and provenance", () => {
  const document = createSourceDocument({ title: "  测试作品  ", content: "第一段。\n第二段。", source: "https://example.com/video" });
  assert.match(document, /^# 测试作品\n\n/);
  assert.match(document, /第一段。\n\n第二段。/);
  assert.match(document, /来源：https:\/\/example\.com\/video\n$/);
});
