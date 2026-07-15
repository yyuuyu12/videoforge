import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { synchronizePresentationThemeFiles } from "./stages.js";

const templateRoot = fileURLToPath(
  new URL("../../skills/web-video-presentation/templates/src/", import.meta.url),
);
const chapterCraft = fileURLToPath(
  new URL("../../skills/web-video-presentation/references/CHAPTER-CRAFT.md", import.meta.url),
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

test("presentation guidance reserves a subtitle-safe content area", async () => {
  const guidance = await readFile(chapterCraft, "utf8");
  assert.match(guidance, /底部字幕预留底部 190px/);
  assert.match(guidance, /下三分之一字幕预留底部 290px/);
  assert.match(guidance, /顶部字幕预留顶部\s*170px/);
  assert.match(guidance, /字幕与数字人安全区的并集/);
});

test("style regeneration invalidates the previous static preview", async () => {
  const stages = await readFile(fileURLToPath(new URL("./stages.js", import.meta.url)), "utf8");
  assert.match(stages, /rmSync\(join\(target, "dist", "\.build-fingerprint"\)/);
  assert.match(stages, /进度文件必须通过 write_file 工具按 UTF-8 写入/);
});

test("product-selected theme overrides agent theme drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "videoforge-theme-"));
  const workspace = join(root, "workspace");
  const skillRoot = join(root, "skill");
  const presentation = join(workspace, "presentation");
  await mkdir(join(skillRoot, "themes", "newsroom"), { recursive: true });
  await mkdir(join(presentation, "src", "styles"), { recursive: true });
  await mkdir(join(presentation, "dist"), { recursive: true });
  await writeFile(join(skillRoot, "themes", "newsroom", "tokens.css"), "/* newsroom */\n");
  await writeFile(join(presentation, "src", "styles", "tokens.css"), "/* agent drift */\n");
  await writeFile(join(presentation, ".theme"), "midnight-press\n");
  await writeFile(join(presentation, "dist", ".build-fingerprint"), "stale\n");
  await writeFile(join(workspace, "outline.md"), "theme: midnight-press\n\n**主题：** midnight-press\n");

  const result = synchronizePresentationThemeFiles({ workspace, skillRoot, theme: "newsroom" });

  assert.equal(result.drifted, true);
  assert.equal(await readFile(join(presentation, "src", "styles", "tokens.css"), "utf8"), "/* newsroom */\n");
  assert.equal(await readFile(join(presentation, ".theme"), "utf8"), "newsroom\n");
  assert.match(await readFile(join(workspace, "outline.md"), "utf8"), /^theme: newsroom$/m);
  assert.match(await readFile(join(workspace, "outline.md"), "utf8"), /^\*\*主题：\*\* newsroom$/m);
  await assert.rejects(readFile(join(presentation, "dist", ".build-fingerprint")));
});
