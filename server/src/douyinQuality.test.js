import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyTruncatedEmbeddedText } from "./douyinQuality.js";

test("rejects a 1,000-character TikHub caption for a long video", () => {
  assert.equal(isLikelyTruncatedEmbeddedText("字".repeat(1000), 524), true);
});

test("does not reject short-video captions or non-boundary lengths", () => {
  assert.equal(isLikelyTruncatedEmbeddedText("字".repeat(1000), 90), false);
  assert.equal(isLikelyTruncatedEmbeddedText("字".repeat(999), 524), false);
  assert.equal(isLikelyTruncatedEmbeddedText("字".repeat(1001), 524), false);
});
