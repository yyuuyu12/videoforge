import test from "node:test";
import assert from "node:assert/strict";
import { parseRegistryChapterTitles } from "./chapterMetadata.js";

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
