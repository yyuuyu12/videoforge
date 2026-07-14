#!/usr/bin/env node
// Groups each step's word-level timestamps (produced by
// synthesize-audio-node.mjs via MiniMax subtitle_enable+subtitle_type:word)
// into short "cues" — 1-2 sentences, sized to fit ONE line at the subtitle's
// large font — and emits src/registry/subtitleCues.ts, flattened in the
// exact order audio-segments.json lists steps (which must match the
// flattened order of src/registry/chapters.ts).
//
// Runtime only needs each cue's START time: the active cue is "the last one
// whose startMs <= currentTime". So imprecision in a word's *end* timestamp
// (or missing punctuation, which word-level timestamps typically drop)
// doesn't matter — only where each new cue BEGINS matters for sync.
//
// If a step has no <n>.words.json (synthesis run without subtitles, or the
// API returned none), it gets an empty cue list — App.tsx falls back to
// showing the step's full narration text statically for that step.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const audioRoot = join(root, "public", "audio");

// Derived from audio-segments.json rather than hand-maintained, so this
// script never drifts out of sync with chapters.ts as chapters are added.
const segments = JSON.parse(readFileSync(join(root, "audio-segments.json"), "utf8"));

const MAX_SOFT = 16; // prefer to close a cue at/after this many chars, on a soft break
const MAX_HARD = 22; // always close by this many chars regardless of punctuation

const SENTENCE_END = /[。！？.!?…]/;
const SOFT_BREAK = /[，、；,;]/;

// Confirmed shape (subtitle_type: "word") from a real MiniMax response:
// the top-level array holds one entry PER SENTENCE SEGMENT, each with a
// nested `timestamped_words` array — the actual per-character/word units
// with their own `time_begin`/`time_end`. The segment-level `text`/
// `time_begin`/`time_end` cover the WHOLE segment, not a single word — using
// those directly (as an earlier, undocumented-shape guess did) collapses
// each cue-group down to one giant cue per segment instead of real word-by-
// word granularity.
function normalizeWord(raw) {
  const text = raw.word ?? raw.text ?? raw.content ?? "";
  const startCandidates = [raw.time_begin, raw.begin_time, raw.start_time, raw.start, raw.bg, raw.begin];
  const endCandidates = [raw.time_end, raw.end_time, raw.stop_time, raw.end, raw.ed, raw.stop];
  const start = startCandidates.find((v) => typeof v === "number");
  const end = endCandidates.find((v) => typeof v === "number");
  if (text === "" || start === undefined || end === undefined) {
    throw new Error(
      `unrecognized word-timestamp shape, keys=[${Object.keys(raw).join(",")}] — update normalizeWord() in gen-subtitle-cues.mjs`,
    );
  }
  return { text, start, end };
}

function extractWords(json) {
  const segments = Array.isArray(json) ? json : (json.subtitles ?? json.words ?? json.data ?? json.list ?? []);
  const words = [];
  for (const seg of segments) {
    if (Array.isArray(seg.timestamped_words)) {
      words.push(...seg.timestamped_words.map(normalizeWord));
    } else {
      // Fallback for providers/shapes that return flat word-level entries
      // directly instead of nested per-segment.
      words.push(normalizeWord(seg));
    }
  }
  return words.filter((w) => w.text.trim() !== "");
}

function buildCues(words) {
  const cues = [];
  let buf = [];
  let bufLen = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.map((w) => w.text).join("");
    cues.push({
      text,
      startMs: Math.round(buf[0].start),
      endMs: Math.round(buf[buf.length - 1].end),
    });
    buf = [];
    bufLen = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    buf.push(w);
    bufLen += w.text.length;
    const isLoneSentenceEndNext =
      i + 1 < words.length &&
      words[i + 1].text.length === 1 &&
      SENTENCE_END.test(words[i + 1].text);
    if (SENTENCE_END.test(w.text)) {
      flush();
    } else if (bufLen >= MAX_SOFT && SOFT_BREAK.test(w.text)) {
      flush();
    } else if (bufLen >= MAX_HARD && !isLoneSentenceEndNext) {
      // Don't cut right before a trailing sentence-ender — that would
      // strand it as its own one-character cue next iteration. Absorb one
      // extra word past the cap so punctuation stays glued to its sentence.
      flush();
    }
  }
  flush();
  return cues;
}

const allCues = [];
let missing = 0;

for (const seg of segments) {
  const wordsPath = join(audioRoot, seg.chapter, `${seg.step}.words.json`);
  if (!existsSync(wordsPath)) {
    missing++;
    allCues.push([]);
    continue;
  }
  const json = JSON.parse(readFileSync(wordsPath, "utf8"));
  const words = extractWords(json);
  allCues.push(buildCues(words));
}

if (missing > 0) {
  console.warn(`⚠ ${missing} step(s) had no *.words.json — those will fall back to full-text subtitles at runtime`);
}

const banner = `// AUTO-GENERATED by scripts/gen-subtitle-cues.mjs — do not hand-edit.
// SUBTITLE_CUES[globalStepIndex] = short cycling-subtitle cues for that step,
// in the exact flattened order chapters appear in src/registry/chapters.ts.
// Empty array = no word-timestamp data for this step; App.tsx falls back to
// the step's full narration text.
export interface SubtitleCue {
  text: string;
  startMs: number;
  endMs: number;
}
export const SUBTITLE_CUES: SubtitleCue[][] = ${JSON.stringify(allCues)};
`;

writeFileSync(join(root, "src", "registry", "subtitleCues.ts"), banner);
console.log(`wrote cues for ${allCues.length} steps (${allCues.filter((c) => c.length > 0).length} with data, ${missing} fallback)`);
