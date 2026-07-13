import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSettings, minimaxKey } from "./settings.js";
import { recordUsage } from "./db.js";

/**
 * MiniMax REST client — contracts verified in clone-voice.sh and
 * synthesize-audio-node.mjs (see the video-avatar-subtitles skill).
 * Audio comes back HEX-encoded; voice cloning is a PAID one-time operation
 * (~¥10) so the wizard must be explicit before calling clone().
 */

function ctx() {
  const s = loadSettings();
  const key = minimaxKey(s);
  if (!key) throw new Error("未配置 MiniMax API key（设置页填写，或 setx MINIMAX_API_KEY）");
  return { key, base: s.minimax.baseUrl.replace(/\/$/, ""), mm: s.minimax };
}

async function post(url, key, body, headers = {}) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, ...headers },
    body,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data.base_resp && data.base_resp.status_code !== 0)) {
    throw new Error(
      data?.base_resp
        ? `${data.base_resp.status_code} ${data.base_resp.status_msg}`
        : `HTTP ${resp.status}`,
    );
  }
  return data;
}

/** Synthesize one line; returns mp3 as a Buffer. Used by 试听 + key test. */
export async function synthesize(text, overrides = {}) {
  const { key, base, mm } = ctx();
  const started = Date.now();
  try {
    const data = await post(
      `${base}/v1/t2a_v2`,
      key,
      JSON.stringify({
        model: mm.model,
        text,
        stream: false,
        voice_setting: {
          voice_id: overrides.voiceId ?? mm.voiceId,
          speed: overrides.speed ?? mm.speed,
          vol: 1.0,
          pitch: 0,
          ...(overrides.emotion ?? mm.emotion
            ? { emotion: overrides.emotion ?? mm.emotion }
            : {}),
        },
        audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1 },
      }),
      { "content-type": "application/json" },
    );
    const hex = data?.data?.audio;
    if (!hex) throw new Error("响应中没有音频数据");
    const audio = Buffer.from(hex, "hex");
    recordUsage({ service: "minimax", operation: "tts", units: String(text).length, unit: "characters", durationMs: Date.now() - started, detail: `${mm.model}/${overrides.voiceId ?? mm.voiceId}` });
    return audio;
  } catch (error) {
    recordUsage({ service: "minimax", operation: "tts", status: "failed", units: String(text).length, unit: "characters", durationMs: Date.now() - started, detail: error.message });
    throw error;
  }
}

export async function testKey() {
  const started = Date.now();
  const buf = await synthesize("连接测试。", { speed: 1.0 });
  return { ok: true, bytes: buf.length, ms: Date.now() - started };
}

/**
 * Voice clone (PAID, one-time). sample = { filename, dataBase64 }.
 * Steps mirror clone-voice.sh: ① upload file (purpose=voice_clone, ASCII
 * filename — OSS rejects Chinese names) ② /v1/voice_clone ③ activation
 * synth so the caller can hear the result immediately.
 */
export async function cloneVoice({ filename, dataBase64, voiceId }) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(voiceId ?? "")) {
    throw new Error("voice_id 需 8-256 位，字母开头，仅字母/数字/-/_，结尾非 -/_");
  }
  const { key, base } = ctx();
  const started = Date.now();

  const ext = (filename?.split(".").pop() || "mp3").toLowerCase();
  const work = join(tmpdir(), `vf-clone-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const asciiPath = join(work, `sample.${ext}`);
  writeFileSync(asciiPath, Buffer.from(dataBase64, "base64"));

  try {
    const form = new FormData();
    form.append("purpose", "voice_clone");
    form.append(
      "file",
      new Blob([readFileSync(asciiPath)], { type: "application/octet-stream" }),
      `sample.${ext}`,
    );
    const up = await post(`${base}/v1/files/upload`, key, form);
    const fileId = up?.file?.file_id;
    if (!fileId) throw new Error("上传成功但没有 file_id");

    await post(
      `${base}/v1/voice_clone`,
      key,
      JSON.stringify({ file_id: fileId, voice_id: voiceId }),
      { "content-type": "application/json" },
    );

    // Activation synth — also gives the user an instant 试听.
    const demo = await synthesize("你好，这是克隆出来的音色测试。", {
      voiceId,
      speed: 1.0,
      emotion: null,
    });
    recordUsage({ service: "minimax", operation: "voice-clone", durationMs: Date.now() - started, detail: voiceId });
    return { voiceId, demoBase64: demo.toString("base64") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
