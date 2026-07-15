import test from "node:test";
import assert from "node:assert/strict";
import { decodeUtf8OrGb18030 } from "./textEncoding.js";

test("progress text accepts UTF-8", () => {
  const bytes = new TextEncoder().encode('{"message":"正在生成本章画面"}');
  assert.equal(decodeUtf8OrGb18030(bytes), '{"message":"正在生成本章画面"}');
});

test("progress text falls back to the Windows Chinese code page", () => {
  const prefix = Buffer.from('{"message":"', "ascii");
  const message = Buffer.from("d5fdd4dac9fab3c9b1bed5c2bbadc3e6", "hex");
  const suffix = Buffer.from('"}', "ascii");
  assert.equal(decodeUtf8OrGb18030(Buffer.concat([prefix, message, suffix])), '{"message":"正在生成本章画面"}');
});
