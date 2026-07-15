#!/usr/bin/env node
// Reads public/audio/<chapter>/<step>.words.json (real MiniMax word-level
// timestamps) and produces src/registry/subtitleCues.ts — a per-step array
// of {text, startMs} cues, chunked with the same rules as
// video-avatar-subtitles/references/SUBTITLE-SYNC.md (never split a token,
// prefer breaking on real punctuation, drop dangling soft-break commas).
//
// Steps with no .words.json (missing audio) get an empty cue array — the
// Subtitle component falls back to full-text display in that case.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const segments = JSON.parse(readFileSync(join(root, "audio-segments.json"), "utf8"));

// ---- chunking primitives (ported from chunk-subtitle.mjs, timestamp-aware) ----
const SENTENCE_END = /[。！？.!?…]/;
const SOFT_BREAK = /[，、；,;]/;
// Keep cues close to the requested mobile short-video rhythm: about ten
// characters, with a hard single-line ceiling and punctuation-aware breaks.
const TARGET_CHARS = 8;
const HARD_MAX_CHARS = 10;
const ABSOLUTE_MAX_CHARS = 10;
const TOKEN_RUN = /[A-Za-z0-9_./-]+/y;

function tokenize(text) {
  const atoms = [];
  let i = 0;
  while (i < text.length) {
    TOKEN_RUN.lastIndex = i;
    const m = TOKEN_RUN.exec(text);
    if (m && m.index === i) {
      atoms.push(text.slice(i, i + m[0].length));
      i += m[0].length;
    } else {
      atoms.push(text[i]);
      i += 1;
    }
  }
  return atoms;
}

function isBreakAtom(atom) {
  return atom.length === 1 && (SENTENCE_END.test(atom) || SOFT_BREAK.test(atom));
}

function hasBreakWithin(atoms, fromIndex, maxChars) {
  let charsSeen = 0;
  for (let j = fromIndex; j < atoms.length && charsSeen < maxChars; j++) {
    charsSeen += atoms[j].length;
    if (isBreakAtom(atoms[j])) return true;
  }
  return false;
}

/**
 * Same control flow as chunkNarration, but atoms carry a startMs (the real
 * timestamp of their first character) so each emitted chunk keeps the
 * startMs of its own first atom.
 */
function chunkWithTimestamps(atoms) {
  const chunks = [];
  let buf = "";
  let bufStartMs = null;

  const flush = (stripTrailingSoftBreak) => {
    const stripped = stripTrailingSoftBreak ? buf.replace(/[，、；,;]\s*$/, "") : buf;
    const out = stripped.trim();
    if (out) chunks.push({ text: out, startMs: bufStartMs ?? 0 });
    buf = "";
    bufStartMs = null;
  };

  for (let i = 0; i < atoms.length; i++) {
    const { text: atom, startMs } = atoms[i];

    if (buf === "" && atom.length === 1 && (SENTENCE_END.test(atom) || SOFT_BREAK.test(atom))) {
      continue;
    }
    if (buf !== "" && atom.length > 1 && buf.trim().length + atom.length > ABSOLUTE_MAX_CHARS) {
      flush(false);
    }

    if (buf === "") bufStartMs = startMs;
    buf += atom;
    const bufLen = buf.trim().length;
    const isSentenceEnd = atom.length === 1 && SENTENCE_END.test(atom);
    const isSoftBreak = atom.length === 1 && SOFT_BREAK.test(atom);

    if (isSentenceEnd) {
      flush(false);
    } else if (isSoftBreak && bufLen >= TARGET_CHARS) {
      flush(true);
    } else if (bufLen >= HARD_MAX_CHARS) {
      const roomLeft = ABSOLUTE_MAX_CHARS - bufLen;
      const atomTexts = atoms.map((a) => a.text);
      const shouldWaitForBreak = roomLeft > 0 && hasBreakWithin(atomTexts, i + 1, roomLeft);
      if (!shouldWaitForBreak) flush(false);
    }
  }
  if (buf.trim()) chunks.push({ text: buf.trim(), startMs: bufStartMs ?? 0 });
  return chunks;
}

function validateCues(cues, source) {
  const failures = cues.filter((cue) =>
    /\n|\r/.test(cue.text)
    || (cue.text.length > ABSOLUTE_MAX_CHARS && !/^[A-Za-z0-9_./-]+$/.test(cue.text)),
  );
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
      words.push({ text: w.word, startMs: w.time_begin });
    }
  }
  // Expand each (possibly multi-char) word into per-character atoms so the
  // tokenizer's Latin/digit run-detection still works across word boundaries
  // (MiniMax sometimes returns a whole English token as one "word" entry,
  // sometimes splits it — normalizing to per-char here makes both cases
  // tokenize identically downstream).
  const chars = [];
  for (const w of words) {
    for (const ch of w.text) chars.push({ ch, startMs: w.startMs });
  }
  const fullText = chars.map((c) => c.ch).join("");
  const rawAtoms = tokenize(fullText);
  // Re-walk rawAtoms against chars to attach each atom's startMs (the
  // timestamp of its first character).
  const atoms = [];
  let cursor = 0;
  for (const atomText of rawAtoms) {
    atoms.push({ text: atomText, startMs: chars[cursor]?.startMs ?? 0 });
    cursor += atomText.length;
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
