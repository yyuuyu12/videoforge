#!/usr/bin/env node
// Reads public/audio/<chapter>/<step>.words.json (real MiniMax word-level
// timestamps) and produces src/registry/subtitleCues.ts — a per-step array
// of {text, startMs} cues.
//
// 电影字幕契约（2026-07-16 定稿，用户拍板）：
//   1. 气口必断：。！？…；：，都是句间气口，遇到即切 cue（顿号、是
//      软断点，只在长度需要时切）——观感是"一句一句展示"。
//   2. 词完整：用 Intl.Segmenter 中文分词，cue 边界只落在词边界上，
//      绝不出现"高"留上页、"兴"落下页（MiniMax 逐字返回，没有词信息）。
//   3. 尾标点隐藏：cue 结尾的 。，、；：… 不显示（两句话已经分页展示，
//      分隔标点失去意义）；？！保留（承载语气）。
//   4. 目标 8 字、硬上限 10 字（不可拆的纯拉丁整词豁免）。
//
// Steps with no .words.json (missing audio) get an empty cue array — the
// Subtitle component falls back to full-text display in that case.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const segments = JSON.parse(readFileSync(join(root, "audio-segments.json"), "utf8"));

// ---- 电影式切分核心 ----------------------------------------------------------
const TARGET_CHARS = 8;
const HARD_MAX_CHARS = 10;
// 气口（必断）：句读级停顿。顿号只是列举间隔，作为软断点。
const HARD_BREAK = /^[。！？…；：，.!?;:,]$/;
const SOFT_BREAK = /^[、]$/;
const ANY_PUNCT = /^[。！？…；：，、.!?;:,]$/;
// cue 尾部剥离的标点（？！不在其中——语气要保留）。
const TRAILING_STRIP = /[。．.，,、；;：:…\s]+$/;

// 中文按词分组（Node 自带 ICU；latin/数字天然成词，标点单列）。
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function chunkWithTimestamps(atoms) {
  // buf 以逐字 {ch, ms} 累积——除 cue 起点外还产出 charMs 逐字时间轴，
  // 供 WordMark/useSpeechTrigger 做字级精度的效果触发（效果 v2b）。
  const chunks = [];
  let buf = []; // [{ch, ms}]
  const bufText = () => buf.map((c) => c.ch).join("");

  const flush = () => {
    const raw = bufText();
    const lead = raw.length - raw.trimStart().length;
    const out = raw.trim().replace(TRAILING_STRIP, "");
    if (out) {
      const kept = buf.slice(lead, lead + [...out].length);
      chunks.push({ text: out, startMs: kept[0]?.ms ?? 0, charMs: kept.map((c) => c.ms) });
    }
    buf = [];
  };

  for (const { text: atom, startMs, charMs } of atoms) {
    const isPunct = ANY_PUNCT.test(atom);
    if (buf.length === 0 && isPunct) continue; // cue 不以标点开头
    // 词完整：装不下整个词就先断句（标点不受此限，随后由 flush 剥离）
    if (buf.length !== 0 && !isPunct && bufText().trim().length + atom.length > HARD_MAX_CHARS) {
      flush();
    }
    [...atom].forEach((ch, i) => buf.push({ ch, ms: charMs?.[i] ?? startMs }));
    if (HARD_BREAK.test(atom)) {
      flush(); // 气口必断
    } else if (SOFT_BREAK.test(atom) && bufText().trim().length >= TARGET_CHARS) {
      flush(); // 顿号：到目标长度才断
    }
  }
  flush();
  return chunks;
}

function validateCues(cues, source) {
  // 上限按正文计：尾部保留的？！是窄字符且承载语气，不占字数预算。
  const failures = cues.filter((cue) => {
    const body = cue.text.replace(/[？！?!]+$/, "");
    return /\n|\r/.test(cue.text)
      || TRAILING_STRIP.test(cue.text)
      || ([...body].length > HARD_MAX_CHARS && !/^[A-Za-z0-9_./\- ]+$/.test(cue.text));
  });
  if (failures.length) {
    throw new Error(`subtitle cue validation failed for ${source}: ${failures.map((cue) => cue.text).join(" | ")}`);
  }
  return cues;
}

function cuesForWordsFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  // Flatten every top-level segment's timestamped_words in order. Each
  // word's `time_begin` (ms) is real-audio-relative already (confirmed by
  // inspecting real MiniMax output — first segment starts at time_begin 0).
  const words = [];
  for (const seg of data) {
    for (const w of seg.timestamped_words ?? []) {
      // MiniMax 对数字/英文按音节逐条返回时，每条都带整词文本（如 "2017"
      // 出现 4 条对应「二零一七」四个音节）——直接拼接会产出 "20172017…"
      // 的连体怪（job-14 实测）。连续同文本的拉丁/数字词条只保留第一条
      //（真实叙述里不会连念同一个数）。
      const prev = words[words.length - 1];
      if (prev && prev.text === w.word && /^[A-Za-z0-9]+$/.test(w.word)) continue;
      words.push({ text: w.word, startMs: w.time_begin });
    }
  }
  // 展开为逐字时间轴（MiniMax 中文本来就逐字；latin 偶尔整词返回，
  // 展开后由分词器重新归组，两种来源产出一致）。
  const chars = [];
  for (const w of words) {
    for (const ch of w.text) chars.push({ ch, startMs: w.startMs });
  }
  const fullText = chars.map((c) => c.ch).join("");
  // Intl.Segmenter 词级归组：cue 边界只落在词边界，"高兴"永不拆分。
  const atoms = [];
  for (const seg of segmenter.segment(fullText)) {
    const cps = [...seg.segment];
    atoms.push({
      text: seg.segment,
      startMs: chars[seg.index]?.startMs ?? 0,
      charMs: cps.map((_, k) => chars[seg.index + k]?.startMs ?? chars[seg.index]?.startMs ?? 0),
    });
  }
  return chunkWithTimestamps(atoms);
}

const byChapter = {};
let withCues = 0;
let withoutCues = 0;

for (const seg of segments) {
  const wordsPath = join(root, "public", "audio", seg.audio.replace(/\.mp3$/, ".words.json"));
  byChapter[seg.chapter] ??= [];
  if (existsSync(wordsPath)) {
    byChapter[seg.chapter].push(validateCues(cuesForWordsFile(wordsPath), wordsPath));
    withCues++;
  } else {
    byChapter[seg.chapter].push([]);
    withoutCues++;
  }
}

const lines = [];
lines.push("// AUTO-GENERATED by scripts/gen-subtitle-cues.mjs — do not hand-edit.");
lines.push("// Re-run after any re-synthesis that changes narrations.ts or audio timing.");
lines.push("");
lines.push("export interface SubtitleCue {");
lines.push("  text: string;");
lines.push("  startMs: number;");
lines.push("  /** 每个字的真实开口时刻（毫秒，与 text 逐字对齐）——词级效果触发的精度来源。 */");
lines.push("  charMs?: number[];");
lines.push("}");
lines.push("");
lines.push("// chapterId -> per-step array of cues (index = step, 0-based)");
lines.push("export const SUBTITLE_CUES: Record<string, SubtitleCue[][]> = {");
for (const [chapterId, steps] of Object.entries(byChapter)) {
  lines.push(`  "${chapterId}": ${JSON.stringify(steps)},`);
}
lines.push("};");

writeFileSync(join(root, "src/registry/subtitleCues.ts"), lines.join("\n") + "\n");
console.log(`✓ wrote src/registry/subtitleCues.ts — ${withCues} steps with cues, ${withoutCues} without`);
