import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { orderedAvatarAudioFiles, synchronizePresentationThemeFiles } from "./stages.js";

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

test("quality audit traverses every presentation step and keeps the worst score", async () => {
  const render = await readFile(fileURLToPath(new URL("./render.js", import.meta.url)), "utf8");
  assert.match(render, /for \(let index = 0; index < 250; index \+= 1\)/);
  assert.match(render, /page\.keyboard\.press\("ArrowRight"\)/);
  assert.match(render, /item\.score < lowest\.score/);
  assert.match(render, /subtitleText\.length > 10/);
  assert.match(render, /headingViolations\.length \* 20/);
  assert.match(render, /captureScreenshots: false/);
  assert.match(render, /quality-structure\.json/);
  assert.match(render, /rmSync\(join\(outDir, "quality-audit-worst\.txt"\)/);
});

test("chapter generation uses structure-first quality gating before screenshot repair", async () => {
  const pipeline = await readFile(fileURLToPath(new URL("./workers/pipeline.js", import.meta.url)), "utf8");
  assert.match(pipeline, /inspectPreviewQuality\(getJob\(jobId\)/);
  assert.match(pipeline, /if \(!audit\.pass\) audit = await auditPreviewQuality/);
  assert.match(pipeline, /!audit\.pass && attempt <= 3/);
  assert.match(pipeline, /repairChapterQuality\(getJob\(jobId\), audit\)/);
  assert.match(pipeline, /if \(!audit\.pass\)/);
  assert.match(pipeline, /audit\.score.*90/);
});

test("chapter progress supports numbered heading outlines and validates themes", async () => {
  const routes = await readFile(new URL("./routes.js", import.meta.url), "utf8");
  assert.match(routes, /outline\.match\(\/\^##\\s\+\\d\+\[\.\)\]/);
  assert.match(routes, /第\[一二三四五六七八九十百\]\+章/);
  assert.match(routes, /PRESENTATION_THEMES\.has\(req\.body\.theme\)/);
  assert.match(routes, /narration\.match\(\/\["'`\]/);
});

test("narration extraction accepts minified chapter imports", async () => {
  const extractor = await readFile(
    new URL("../../skills/web-video-presentation/templates/scripts/extract-narrations.ts", import.meta.url),
    "utf8",
  );
  // Resolve chapter files from the registry and filesystem rather than
  // depending on one particular import formatting.
  assert.match(extractor, /readdir\(CHAPTERS_DIR/);
  assert.match(extractor, /return join\(CHAPTERS_DIR, flat\)/);
  assert.match(extractor, /\.narrations\.ts/);
});

test("avatar layout audit accepts an absolute right-side reservation", async () => {
  const routes = await readFile(new URL("./routes.js", import.meta.url), "utf8");
  assert.match(routes, /right:\\s\*\(44\[0-9\]/);
});

test("avatar audio follows the presentation manifest instead of folder sorting", async () => {
  const root = await mkdtemp(join(tmpdir(), "videoforge-avatar-order-"));
  const audioRoot = join(root, "public", "audio");
  await mkdir(join(audioRoot, "accumulate"), { recursive: true });
  await mkdir(join(audioRoot, "hook"), { recursive: true });
  await writeFile(join(audioRoot, "accumulate", "1.mp3"), "a");
  await writeFile(join(audioRoot, "hook", "1.mp3"), "h");
  await writeFile(join(root, "audio-segments.json"), JSON.stringify([
    { audio: "hook/1.mp3" },
    { audio: "accumulate/1.mp3" },
  ]));
  const files = orderedAvatarAudioFiles(root, audioRoot);
  assert.deepEqual(files.map((file) => file.replace(/\\/g, "/").split("/").slice(-2).join("/")), [
    "hook/1.mp3",
    "accumulate/1.mp3",
  ]);
});

test("avatar preview API uses manifest chapter order", async () => {
  const routes = await readFile(fileURLToPath(new URL("./routes.js", import.meta.url)), "utf8");
  assert.match(routes, /chapterOrder = \[\.\.\.new Set/);
  assert.match(routes, /order\.get\(a\.replace/);
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
