#!/usr/bin/env node
// jq-free replacement runner for audio-segments.json → MiniMax t2a_v2 synthesis.
// Same behavior as scripts/synthesize-audio.sh + tts-providers/minimax-http.sh,
// implemented in Node so it doesn't need the `jq` CLI (unavailable in this
// Windows Git Bash environment and blocked from auto-install).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error("✗ MINIMAX_API_KEY is not set");
  process.exit(1);
}

const MINIMAX_BASE = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com";
const MODEL = process.env.MINIMAX_MODEL || "speech-2.8-hd";
// GongheJiucun02 is a PERMANENT cloned voice_id (already paid for, one-time
// voice_clone call — see F:/Projects/harnessH5video/clone-voice.sh). This
// script only ever calls t2a_v2 (generation), never voice_clone, so re-running
// this file can never re-trigger the cloning charge — only the (much
// cheaper, ~¥0.35/1000 chars) generation cost. Don't remove this default.
const VOICE = process.env.MINIMAX_DEFAULT_VOICE || "GongheJiucun02";
const SPEED = Number(process.env.MINIMAX_SPEED || "1.0");
const FORCE = process.argv.includes("--force");

const segments = JSON.parse(readFileSync(join(root, "audio-segments.json"), "utf8"));

let ok = 0, skipped = 0, failed = 0, synthesizedChars = 0;

for (let i = 0; i < segments.length; i++) {
  const seg = segments[i];
  const outPath = join(root, "public", "audio", seg.audio);
  const label = `[${String(i + 1).padStart(2, "0")}/${segments.length}] ${seg.audio}`;

  if (!FORCE && existsSync(outPath)) {
    console.log(`${label}  skip (exists)`);
    skipped++;
    continue;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  if (i > 0) await new Promise((r) => setTimeout(r, 1500));

  const t0 = Date.now();
  try {
    const resp = await fetch(`${MINIMAX_BASE}/v1/t2a_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        text: seg.text,
        stream: false,
        voice_setting: { voice_id: VOICE, speed: SPEED, vol: 1.0, pitch: 0 },
        audio_setting: {
          format: "mp3",
          sample_rate: 32000,
          bitrate: 128000,
          channel: 1,
        },
        // Word-level timestamps drive the cycling subtitle + precise
        // audio-visual sync (see gen-subtitle-cues.mjs). Sentence-level
        // ("sentence") is the default but too coarse for 1-2-sentence cues.
        subtitle_enable: true,
        subtitle_type: "word",
      }),
    });
    const data = await resp.json();
    const code = data?.base_resp?.status_code;
    const audioHex = data?.data?.audio;
    if (code !== 0 || !audioHex) {
      throw new Error(`TTS failed: ${JSON.stringify(data?.base_resp)}`);
    }
    writeFileSync(outPath, Buffer.from(audioHex, "hex"));

    const subtitleUrl = data?.data?.subtitle_file;
    if (subtitleUrl) {
      const subResp = await fetch(subtitleUrl);
      const words = await subResp.json();
      const wordsPath = outPath.replace(/\.mp3$/, ".words.json");
      writeFileSync(wordsPath, JSON.stringify(words));
    } else {
      console.warn(`${label}  ⚠ no subtitle_file in response — cues will fall back to full text`);
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${label}  ✓ ${secs}s`);
    ok++;
    synthesizedChars += String(seg.text || "").length;
  } catch (err) {
    console.error(`${label}  ✗ FAILED — ${err.message}`);
    failed++;
  }
}

console.log("");
console.log(`done: ${ok} synthesized, ${skipped} skipped, ${failed} failed`);
console.log(`VF_USAGE ${JSON.stringify({ requests: ok, characters: synthesizedChars })}`);
if (failed > 0) process.exit(1);
