import { loadSettings } from "./settings.js";
import { recordUsage } from "./db.js";

/**
 * HeyGem lip-sync gateway client — PRODUCT-PLAN §三.9.
 *
 * Works against either the local service (http://127.0.0.1:7861, see the
 * heygem-service-setup memory) or the remote frp-tunneled gateway. `token`
 * is the reserved auth header for the remote case; the local service
 * ignores it. API contract (verified against heygem_server_v2.py):
 *   GET  /health                    → { status, processor_ready }
 *   POST /video/generate            → { task_id }   (audio_b64 + video_b64 | avatar_key)
 *   GET  /video/task/:id            → { status: pending|running|done|error, progress }
 *   GET  /video/file/:id            → mp4 bytes (once done)
 */

function ctx() {
  const { heygem } = loadSettings();
  const headers = heygem.token ? { authorization: `Bearer ${heygem.token}` } : {};
  return { base: heygem.baseUrl.replace(/\/$/, ""), headers };
}

export async function health() {
  const { base, headers } = ctx();
  const started = Date.now();
  try {
    const ctl = AbortSignal.timeout(4000);
    const resp = await fetch(`${base}/health`, { headers, signal: ctl });
    const data = await resp.json();
    return {
      ok: resp.ok && data.status === "ok",
      ready: Boolean(data.processor_ready),
      detail: data,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, ready: false, error: err.message, ms: Date.now() - started };
  }
}

export async function submitJob({ audioB64, videoB64, avatarKey, audioFmt = "mp3", videoFmt = "mp4" }) {
  const { base, headers } = ctx();
  const started = Date.now();
  const payload = { audio_b64: audioB64, audio_fmt: audioFmt, enhancer: false };
  if (avatarKey) payload.avatar_key = avatarKey;
  else payload.video_b64 = videoB64, (payload.video_fmt = videoFmt);
  try {
    const resp = await fetch(`${base}/video/generate`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok || !data.task_id) throw new Error(data?.detail ?? `HTTP ${resp.status}`);
    recordUsage({ service: "heygem", operation: "lip-sync", units: Math.round(Buffer.from(audioB64, "base64").length / 1024 / 1024 * 100) / 100, unit: "audio_mb", durationMs: Date.now() - started });
    return { taskId: data.task_id };
  } catch (error) {
    recordUsage({ service: "heygem", operation: "lip-sync", status: "failed", durationMs: Date.now() - started, detail: error.message });
    throw error;
  }
}

export async function taskStatus(taskId) {
  const { base, headers } = ctx();
  const resp = await fetch(`${base}/video/task/${taskId}`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function downloadResult(taskId) {
  const { base, headers } = ctx();
  const resp = await fetch(`${base}/video/file/${taskId}`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}
