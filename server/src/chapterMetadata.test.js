import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPresentationManifest, parseRegistryChapterTitles } from "./chapterMetadata.js";

test("reads user-facing Chinese chapter titles from a presentation registry", () => {
  const titles = parseRegistryChapterTitles(`
    export const CHAPTERS = [
      { id: "no-formula", title: "没有公式", Component: NoFormula },
      {Component: Imitation, title:'拒绝模仿', id:'imitation'},
    ];
  `);

  assert.equal(titles.get("no-formula"), "没有公式");
  assert.equal(titles.get("imitation"), "拒绝模仿");
});

test("builds a versioned manifest from audio segments and registry titles", () => {
  const pres = mkdtempSync(join(tmpdir(), "videoforge-manifest-"));
  mkdirSync(join(pres, "src", "registry"), { recursive: true });
  writeFileSync(join(pres, "src", "registry", "chapters.ts"), `export const CHAPTERS = [
    { id: "hook", title: "开场", Component: Hook },
    { id: "close", title: "结尾", Component: Close },
  ];`);
  writeFileSync(join(pres, "audio-segments.json"), JSON.stringify([
    { chapter: "hook", step: 1, text: "先看结论", audio: "hook/1.mp3" },
    { chapter: "close", step: 1, text: "最后总结", audio: "close/1.mp3" },
  ]));

  const manifest = buildPresentationManifest(pres);
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.chapters.map((chapter) => chapter.title), ["开场", "结尾"]);
  assert.equal(manifest.segments[1].audio, "close/1.mp3");
  assert.deepEqual(JSON.parse(readFileSync(join(pres, "presentation-manifest.json"), "utf8")), manifest);
});
