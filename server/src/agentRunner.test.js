import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeApiTool, isWorkspacePath, parseChatCompletion } from "./agentRunner.js";
import { config } from "./config.js";

test("Agent workspace paths stay inside the configured workspace root", () => {
  const root = config.workspacesRoot;
  assert.equal(isWorkspacePath(root), true);
  assert.equal(isWorkspacePath(`${root}/job-1/presentation`), true);
  assert.equal(isWorkspacePath(`${root}/../settings.local.json`), false);
  assert.equal(isWorkspacePath("C:/Windows"), false);
});

test("parseChatCompletion 解析非流式 JSON", () => {
  const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "你好" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const r = parseChatCompletion(body, "application/json");
  assert.equal(r.ok, true);
  assert.equal(r.data.choices[0].message.content, "你好");
  assert.equal(r.data.usage.completion_tokens, 2);
});

test("parseChatCompletion 聚合 SSE 流式的 content", () => {
  const sse = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"先"}}]}',
    'data: {"choices":[{"delta":{"content":"看"}}]}',
    'data: {"choices":[{"delta":{"content":"三件事"},"finish_reason":"stop"}],"usage":{"completion_tokens":4}}',
    "data: [DONE]",
  ].join("\n\n");
  const r = parseChatCompletion(sse, "text/event-stream");
  assert.equal(r.ok, true);
  assert.equal(r.data.choices[0].message.content, "先看三件事");
  assert.equal(r.data.choices[0].finish_reason, "stop");
  assert.equal(r.data.usage.completion_tokens, 4);
});

test("parseChatCompletion 聚合 SSE 流式的 tool_calls（按 index 合并 name/arguments）", () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{\\"path\\":\\"a"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".ts\\"}"}}]}}]}',
    "data: [DONE]",
  ].join("\n\n");
  const r = parseChatCompletion(sse, "text/event-stream");
  assert.equal(r.ok, true);
  const call = r.data.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "write_file");
  assert.equal(call.function.arguments, '{"path":"a.ts"}');
  assert.equal(call.id, "call_1");
});

test("parseChatCompletion 空响应报错、垃圾响应报错", () => {
  assert.equal(parseChatCompletion("", "").ok, false);
  assert.equal(parseChatCompletion("<html>502</html>", "text/html").ok, false);
});

test("executeApiTool 写限工作区内、读放行仓库内 skills 方法论", async () => {
  const ws = mkdtempSync(join(tmpdir(), "vf-tool-"));
  try {
    // 写：工作区内成功
    await executeApiTool(ws, "write_file", { path: "script.md", content: "口播稿" });
    assert.equal(readFileSync(join(ws, "script.md"), "utf8"), "口播稿");
    // 写：越界（../）被拒
    await assert.rejects(
      () => executeApiTool(ws, "write_file", { path: "../escape.md", content: "x" }),
      /超出工作区/,
    );
    assert.equal(existsSync(join(ws, "..", "escape.md")), false);
    // 读：prompt 命令读取的仓库内 skill 方法论（工作区外）现在放行
    const skillDoc = await executeApiTool(ws, "read_file", { path: join(config.skills.webVideoPresentation, "SKILL.md") });
    assert.equal(typeof skillDoc, "string");
    assert.ok(skillDoc.length > 0);
    // 读：skills 之外的越界路径仍被拒
    await assert.rejects(
      () => executeApiTool(ws, "read_file", { path: "../../settings.local.json" }),
      /超出工作区/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
