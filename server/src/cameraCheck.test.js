import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCameraCues, cameraEvidence } from "./cameraCheck.js";

function makeRegistry(obj) {
  const presDir = mkdtempSync(join(tmpdir(), "vf-cam-"));
  mkdirSync(join(presDir, "src", "registry"), { recursive: true });
  writeFileSync(
    join(presDir, "src", "registry", "cameraCues.ts"),
    `export const CAMERA_CUES: Record<string, unknown[]> = ${JSON.stringify(obj)};\n`,
  );
  return presDir;
}

test("registry 缺失 = 不用镜头，直接通过", () => {
  const presDir = mkdtempSync(join(tmpdir(), "vf-cam-none-"));
  assert.equal(validateCameraCues(presDir).pass, true);
});

test("合法镜头声明通过", () => {
  const presDir = makeRegistry({
    hook: [null, { effect: "focus", target: ".card", zoom: 1.8 }, { effect: "overview" }],
  });
  const r = validateCameraCues(presDir);
  assert.equal(r.pass, true);
});

test("focus 缺 target 判 error", () => {
  const presDir = makeRegistry({ hook: [{ effect: "focus", zoom: 1.5 }] });
  const r = validateCameraCues(presDir);
  assert.equal(r.pass, false);
  assert.match(cameraEvidence(r)[0], /camera-target/);
});

test("zoom 越界与未知词表判 error", () => {
  const presDir = makeRegistry({
    hook: [{ effect: "focus", target: ".a", zoom: 4 }, { effect: "shake", target: ".b" }],
  });
  const r = validateCameraCues(presDir);
  assert.equal(r.errors, 2);
});

test("host/host-full 免 target，预算独立（host 每章 ≤1、host-full 全片 ≤1）", () => {
  const ok = makeRegistry({
    hook: [{ effect: "host-full" }, { effect: "host" }],
    ch2: [{ effect: "host" }],
  });
  assert.equal(validateCameraCues(ok).pass, true);

  const tooManyHosts = makeRegistry({ hook: [{ effect: "host" }, null, { effect: "host" }] });
  const r1 = validateCameraCues(tooManyHosts);
  assert.equal(r1.pass, false);
  assert.match(cameraEvidence(r1)[0], /host-budget/);

  const tooManyFull = makeRegistry({ hook: [{ effect: "host-full" }], ch2: [{ effect: "host-full" }] });
  const r2 = validateCameraCues(tooManyFull);
  assert.equal(r2.pass, false);
  assert.match(cameraEvidence(r2)[0], /host-full-budget/);
});

test("每章镜头预算 ≤3", () => {
  const presDir = makeRegistry({
    hook: [
      { effect: "focus", target: ".a" },
      { effect: "pan", target: ".b" },
      { effect: "spotlight", target: ".c" },
      { effect: "focus", target: ".d" },
    ],
  });
  const r = validateCameraCues(presDir);
  assert.equal(r.pass, false);
  assert.match(cameraEvidence(r)[0], /camera-budget/);
});
