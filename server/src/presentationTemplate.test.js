import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const templateRoot = fileURLToPath(
  new URL("../../skills/web-video-presentation/templates/src/", import.meta.url),
);

test("presentation template includes Vite client types", async () => {
  const declaration = await readFile(`${templateRoot}/vite-env.d.ts`, "utf8");
  assert.match(declaration, /reference types=["']vite\/client["']/);
});

test("presentation audio hook exposes its audio element", async () => {
  const hook = await readFile(`${templateRoot}/hooks/useAudioPlayer.ts`, "utf8");
  assert.match(hook, /return\s+\{\s*getAudioEl:\s*\(\)\s*=>\s*audioRef\.current\s*\}/);
});

test("presentation stepper accepts a chapter query parameter", async () => {
  const hook = await readFile(`${templateRoot}/hooks/useStepper.ts`, "utf8");
  assert.match(hook, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(hook, /get\(["']chapter["']\)/);
  assert.match(hook, /if \(requested\) return requested/);
});
