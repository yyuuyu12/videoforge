#!/usr/bin/env node
// Portable reference implementation of the subtitle-chunking algorithm
// described in ../references/SUBTITLE-SYNC.md. Zero dependencies — copy
// `chunkNarration` straight into a project (TS or JS, the logic is
// identical either way) and wire its output up to real/estimated timing.
//
// Usage as a CLI sanity check:
//   node chunk-subtitle.mjs "一段很长的口播文案……"
//
// Usage as a module:
//   import { chunkNarration } from "./chunk-subtitle.mjs";
//   const pieces = chunkNarration(narrationText); // string[]

const SENTENCE_END = /[。！？.!?…]/;
const SOFT_BREAK = /[，、；,;]/;
const TARGET_CHARS = 10;
const HARD_MAX_CHARS = 14;
const ABSOLUTE_MAX_CHARS = 22;
// Runs of these characters are kept atomic (never split mid-run): Latin
// letters, digits, and the punctuation that shows up inside file/code
// tokens (`.`, `/`, `_`, `-`). This is what keeps `SKILL.md`,
// `scripts/style_match.py`, `brand-guidelines` etc. from being cut in half.
const TOKEN_RUN = /[A-Za-z0-9_./-]+/y;

function tokenize(text) {
  const atoms = [];
  let i = 0;
  while (i < text.length) {
    TOKEN_RUN.lastIndex = i;
    const m = TOKEN_RUN.exec(text);
    if (m && m.index === i) {
      atoms.push(m[0]);
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

export function chunkNarration(text) {
  const atoms = tokenize(text);
  const chunks = [];
  let buf = "";

  const flush = (stripTrailingSoftBreak) => {
    const out = (stripTrailingSoftBreak ? buf.replace(/[，、；,;]\s*$/, "") : buf).trim();
    if (out) chunks.push(out);
    buf = "";
  };

  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];

    // A break character landing as the very first thing in a fresh chunk
    // (because the PREVIOUS chunk got cut just short of it) is the same
    // dangling-punctuation artifact as a trailing one — drop it rather than
    // start a subtitle line with a stray "，".
    if (buf === "" && atom.length === 1 && (SENTENCE_END.test(atom) || SOFT_BREAK.test(atom))) {
      continue;
    }
    // A multi-char atomic token (an English word / file path) large enough
    // to blow the budget by itself would otherwise get glued onto whatever
    // came before it into one oversized chunk (that token can't be split,
    // but what precedes it can) — flush first so the token starts its own
    // fresh chunk instead.
    if (buf !== "" && atom.length > 1 && buf.trim().length + atom.length > ABSOLUTE_MAX_CHARS) {
      flush(false);
    }

    buf += atom;
    const bufLen = buf.trim().length;
    const isSentenceEnd = atom.length === 1 && SENTENCE_END.test(atom);
    const isSoftBreak = atom.length === 1 && SOFT_BREAK.test(atom);

    if (isSentenceEnd) {
      flush(false); // real sentence end — keep the punctuation
    } else if (isSoftBreak && bufLen >= TARGET_CHARS) {
      flush(true); // mid-sentence split — drop the dangling comma etc.
    } else if (bufLen >= HARD_MAX_CHARS) {
      // Look ahead exactly as far as the remaining room to ABSOLUTE_MAX —
      // if a pause exists anywhere we could still reach, wait for it
      // instead of cutting through whatever word we're mid-way through.
      const roomLeft = ABSOLUTE_MAX_CHARS - bufLen;
      const shouldWaitForBreak = roomLeft > 0 && hasBreakWithin(atoms, i + 1, roomLeft);
      if (!shouldWaitForBreak) flush(false);
      // else: keep accumulating — the loop reaches that break atom shortly
      // and one of the two branches above will flush there instead.
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// CLI sanity-check mode.
if (process.argv[1] && process.argv[1].endsWith("chunk-subtitle.mjs") && process.argv[2]) {
  console.log(JSON.stringify(chunkNarration(process.argv.slice(2).join(" ")), null, 2));
}
