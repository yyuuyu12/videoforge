import { loadSettings } from "./settings.js";
import { recordUsage } from "./db.js";

/**
 * 抖音链接 → 文案（作为选题/文章来源）。
 * 链路照搬 Copywriter/routes/extract.js（已在生产验证过）：
 *   ① 从分享文本里抠出真实链接，短链跟随重定向解析 aweme_id
 *   ② TikHub 拿视频详情（新旧两个接口做 fallback）
 *   ③ 优先用 TikHub 内置字幕（快、免费）
 *   ④ 没字幕 → 提取 mp4 地址交给用户自己的 Whisper ASR 服务（submit+poll）
 *   ⑤ 还没有 → 兜底用视频描述
 */

const TIKHUB = "https://api.tikhub.io";

export async function extractDouyin(input, { onProgress = () => {} } = {}) {
  const s = loadSettings();
  const key = s.tikhub.apiKey;
  if (!key) throw new Error("未配置 TikHub API key（设置页 → 内容源）");
  const steps = [];

  // ① 链接清洗 + aweme_id
  const text = String(input ?? "").trim();
  const urlMatch =
    text.match(/https?:\/\/[^\s，。,）)]+/) ||
    text.match(/(?:v\.douyin\.com|www\.douyin\.com)\/[^\s，。,]+/);
  const cleanUrl = urlMatch ? urlMatch[0].replace(/[）)>》\]]+$/, "") : text;
  const finalUrl = cleanUrl.startsWith("http") ? cleanUrl : `https://${cleanUrl}`;
  steps.push({ id: "link", ok: true, message: "已识别抖音分享链接" });
  await onProgress({ stage: "link", progress: 5, message: "已识别分享链接，正在请求 TikHub" });

  let awemeId = finalUrl.match(/\/video\/(\d{10,20})/)?.[1] ?? null;
  if (!awemeId) {
    try {
      const resp = await fetch(finalUrl, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
      });
      awemeId = (resp.url || "").match(/\/video\/(\d{10,20})/)?.[1] ?? null;
    } catch {
      /* fallthrough */
    }
  }
  // ② 视频详情：优先使用 TikHub 官方“分享链接直查”，不依赖本机重定向。
  const headers = { authorization: `Bearer ${key}` };
  let item = null;
  const detailUrls = [
    `${TIKHUB}/api/v1/douyin/app/v3/fetch_one_video_by_share_url?share_url=${encodeURIComponent(finalUrl)}`,
    `${TIKHUB}/api/v1/douyin/web/fetch_one_video_by_share_url?share_url=${encodeURIComponent(finalUrl)}`,
  ];
  if (awemeId) detailUrls.push(
    `${TIKHUB}/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${awemeId}`,
    `${TIKHUB}/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`,
  );
  let detailError = "";
  const tikHubStarted = Date.now();
  for (const apiUrl of detailUrls) {
    try {
      const r = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const d = await r.json();
        item = d?.data?.aweme_detail ?? d?.data?.item_list?.[0] ?? null;
        if (item) break;
        detailError = d?.message || "接口未返回作品数据";
      } else {
        detailError = `HTTP ${r.status}`;
      }
    } catch (error) {
      detailError = error.message;
    }
  }
  if (!item) {
    recordUsage({ service: "tikhub", operation: "douyin-detail", status: "failed", durationMs: Date.now() - tikHubStarted, detail: detailError });
    throw new Error(`TikHub 获取视频信息失败：${detailError || "检查链接、key 或额度"}`);
  }
  recordUsage({ service: "tikhub", operation: "douyin-detail", durationMs: Date.now() - tikHubStarted, detail: awemeId || "share-url" });
  awemeId = String(item.aweme_id || awemeId || "");
  steps.push({ id: "tikhub", ok: true, message: `TikHub 已返回视频信息${awemeId ? ` · ${awemeId}` : ""}` });
  await onProgress({ stage: "tikhub", progress: 18, message: "已获取原视频信息，正在检查字幕和原声", awemeId });

  // ③ TikHub 当前没有独立的抖音字幕接口；先检查作品数据中是否带文案/字幕结构。
  const durationSeconds = Math.max(0, Math.round(Number(item.video?.duration || 0) / 1000));
  const minimumChars = durationSeconds >= 60
    ? Math.max(200, Math.round(durationSeconds * 1.1))
    : 80;
  let script = extractEmbeddedText(item);
  let via = script ? "tikhub-embedded-text" : "";
  const embeddedChars = script.length;
  if (script && script.length < minimumChars) {
    script = "";
    via = "";
  }
  steps.push({
    id: "embedded",
    ok: Boolean(script),
    message: script
      ? `作品数据包含完整文案 · ${script.length} 字`
      : embeddedChars
        ? `内嵌文本只有 ${embeddedChars} 字，不是完整字幕，转入原声识别`
        : "作品数据没有可用字幕，转入原声识别",
  });
  await onProgress({
    stage: script ? "embedded" : "media",
    progress: script ? 88 : 25,
    message: script ? `发现完整内嵌文案 · ${script.length} 字` : `需要识别完整原声 · 视频约 ${durationSeconds} 秒`,
    durationSeconds,
  });

  // ④ STT/ASR：有自建 ASR 地址时用 submit+poll；否则复用已配置的 OpenAI 兼容网关。
  if (!script) {
    const media = findSpeechMedia(item, durationSeconds);
    let asrError = "";
    if (media?.url && s.asr.baseUrl) {
      await onProgress({ stage: "asr", progress: 30, message: `已选择${media.source === "original-mp3" ? "完整原声 MP3" : "视频音轨"}，正在提交 Whisper` });
      const asrStarted = Date.now();
      const result = await localAsrTranscribe(media.url, s.asr.baseUrl.replace(/\/$/, ""), onProgress);
      script = result.text;
      asrError = result.error;
      recordUsage({ service: "asr", operation: "transcription", status: script ? "success" : "failed", units: durationSeconds, unit: "audio_seconds", durationMs: Date.now() - asrStarted, detail: script ? `${script.length} chars` : asrError });
      if (script) via = "local-whisper-asr";
    }
    if (media?.url && !script && s.llm.provider === "openai-compatible" && s.llm.apiKey) {
      const asrStarted = Date.now();
      script = await openAiTranscribe(media.url, s);
      recordUsage({ service: "asr", operation: "openai-transcription", status: script ? "success" : "failed", units: durationSeconds, unit: "audio_seconds", durationMs: Date.now() - asrStarted, detail: script ? `${script.length} chars` : "empty response" });
      if (script) via = "openai-compatible-stt";
    }
    steps.push({
      id: "asr",
      ok: Boolean(script),
      message: script
        ? `完整原声识别完成 · ${durationSeconds || "未知"} 秒 · ${script.length} 字`
        : media?.url
          ? `语音识别失败：${asrError || "未返回文本"}`
          : "没有找到可下载的原声音频",
    });
  }

  if (script && script.length < minimumChars) {
    steps.push({ id: "quality", ok: false, message: `完整性检查未通过：${durationSeconds || "未知"} 秒视频只识别到 ${script.length} 字，至少应有约 ${minimumChars} 字` });
    throw new Error(`语音转录不完整：${durationSeconds || "长"} 秒视频只识别到 ${script.length} 字，请重试，不能把标题或描述当作完整文案`);
  }
  if (script) await onProgress({ stage: "quality", progress: 94, message: `正在检查转录完整性 · ${script.length} 字` });

  // ⑤ 兜底
  if (!script) {
    script = item.desc || "";
    via = "desc-only";
    if (!script) throw new Error("未能提取到文案（无字幕、未配置 ASR、且视频无描述）");
    steps.push({ id: "fallback", ok: true, warning: true, message: "仅提取到视频描述，不是完整口播文案" });
  }

  return {
    awemeId,
    title: (item.desc || `抖音视频 ${awemeId}`).split("\n")[0].slice(0, 80),
    author: item.author?.nickname ?? "",
    script,
    via,
    steps,
    durationSeconds,
    url: `https://www.douyin.com/video/${awemeId}`,
  };
}

function extractEmbeddedText(item) {
  const parts = [];
  if (typeof item.caption === "string") parts.push(item.caption);
  if (Array.isArray(item.video_text)) {
    for (const value of item.video_text) {
      const text = value?.text || value?.content || value?.words;
      if (typeof text === "string") parts.push(text);
    }
  }
  return [...new Set(parts.map((value) => value.trim()).filter((value) => value.length >= 8))].join("\n");
}

function findSpeechMedia(item, durationSeconds) {
  const musicUrl = item.music?.play_url?.url_list?.[0];
  const musicDuration = Number(item.music?.duration || 0);
  const musicMatchesVideo = musicUrl && durationSeconds > 0 && Math.abs(musicDuration - durationSeconds) <= 3;
  const candidates = [
    musicMatchesVideo && { url: musicUrl, source: "original-mp3" },
    { url: item.video?.audio?.url_list?.[0], source: "video-audio" },
    { url: item.video?.bit_rate_audio?.[0]?.play_addr?.url_list?.[0], source: "bitrate-audio" },
    { url: item.video?.play_addr?.url_list?.[0], source: "video-play" },
    { url: item.video?.bit_rate?.[0]?.play_addr?.url_list?.[0], source: "video-bitrate" },
    { url: item.video?.download_addr?.url_list?.[0], source: "video-download" },
  ];
  return candidates.find((item) => typeof item?.url === "string" && item.url.startsWith("http")) || null;
}

async function openAiTranscribe(mediaUrl, settings) {
  try {
    const media = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
    if (!media.ok) return "";
    const bytes = await media.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 50 * 1024 * 1024) return "";
    const contentType = media.headers.get("content-type") || "video/mp4";
    const ext = contentType.includes("audio") ? "m4a" : "mp4";
    const form = new FormData();
    form.append("model", settings.asr.model || "whisper-1");
    form.append("file", new Blob([bytes], { type: contentType }), `douyin.${ext}`);
    const baseUrl = (settings.asr.openAiBaseUrl || settings.llm.baseUrl).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.asr.apiKey || settings.llm.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) return "";
    const result = await response.json();
    return String(result.text || result.transcript || "").trim();
  } catch {
    return "";
  }
}

/** submit + poll，最长 10 分钟（长视频的 Whisper medium 推理可能明显超过 90 秒）。 */
async function localAsrTranscribe(mp4Url, asrBaseUrl, onProgress = () => {}) {
  try {
    const submit = await fetch(`${asrBaseUrl}/asr/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mp4Url }),
      signal: AbortSignal.timeout(12000),
    });
    if (!submit.ok) return { text: "", error: `ASR 提交失败 HTTP ${submit.status}` };
    const { task_id } = await submit.json();
    if (!task_id) return { text: "", error: "ASR 未返回任务编号" };
    await onProgress({ stage: "asr", progress: 34, message: "Whisper 已接收任务，开始识别完整原声" });
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const poll = await fetch(`${asrBaseUrl}/asr/task/${task_id}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (poll.ok) {
          const result = await poll.json();
          if (result.status === "done" && result.text) return { text: result.text.trim(), error: "" };
          if (result.status === "error") return { text: "", error: result.error || "ASR 识别失败" };
          if (i % 3 === 0) {
            const waited = (i + 1) * 3;
            const progress = Math.min(86, 35 + Math.round((waited / 600) * 51));
            await onProgress({ stage: "asr", progress, message: `正在识别完整原声 · 已等待 ${waited} 秒 · 页面可以安全切换` });
          }
        }
      } catch {
        /* keep polling */
      }
    }
  } catch {
    /* fallthrough */
  }
  return { text: "", error: "ASR 等待超过 10 分钟" };
}
