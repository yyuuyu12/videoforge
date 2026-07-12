import { loadSettings } from "./settings.js";

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

export async function extractDouyin(input) {
  const s = loadSettings();
  const key = s.tikhub.apiKey;
  if (!key) throw new Error("未配置 TikHub API key（设置页 → 内容源）");

  // ① 链接清洗 + aweme_id
  const text = String(input ?? "").trim();
  const urlMatch =
    text.match(/https?:\/\/[^\s，。,）)]+/) ||
    text.match(/(?:v\.douyin\.com|www\.douyin\.com)\/[^\s，。,]+/);
  const cleanUrl = urlMatch ? urlMatch[0].replace(/[）)>》\]]+$/, "") : text;
  const finalUrl = cleanUrl.startsWith("http") ? cleanUrl : `https://${cleanUrl}`;

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
  if (!awemeId) throw new Error("无法解析视频 ID —— 请确认是有效的抖音视频链接/分享文本");

  // ② 视频详情（新旧接口 fallback）
  const headers = { authorization: `Bearer ${key}` };
  let item = null;
  for (const apiUrl of [
    `${TIKHUB}/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${awemeId}`,
    `${TIKHUB}/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`,
  ]) {
    try {
      const r = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const d = await r.json();
        item = d?.data?.aweme_detail ?? d?.data?.item_list?.[0] ?? null;
        if (item) break;
      }
    } catch {
      /* try next */
    }
  }
  if (!item) throw new Error("TikHub 获取视频信息失败 —— 检查 key 是否有效/额度是否用尽");

  // ③ 内置字幕
  let script = "";
  let via = "";
  try {
    const r = await fetch(
      `${TIKHUB}/api/v1/douyin/app/v3/fetch_video_subtitle?aweme_id=${awemeId}`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (r.ok) {
      const d = await r.json();
      const subs = d?.data?.subtitle_infos?.[0]?.subtitle_list;
      if (subs?.length) {
        script = subs.map((x) => x.words?.map((w) => w.word).join("") || x.text).join("\n");
        via = "tikhub-subtitle";
      }
    }
  } catch {
    /* fallthrough */
  }

  // ④ Whisper ASR 兜底（用户自己的服务，可选）
  if (!script && s.asr.baseUrl) {
    const mp4 = [
      item.video?.download_addr?.url_list?.[0],
      item.video?.play_addr?.url_list?.[0],
      item.video?.bit_rate?.[0]?.play_addr?.url_list?.[0],
    ].find((u) => u?.startsWith("http"));
    if (mp4) {
      script = await asrTranscribe(mp4, s.asr.baseUrl.replace(/\/$/, ""));
      if (script) via = "whisper-asr";
    }
  }

  // ⑤ 兜底
  if (!script) {
    script = item.desc || "";
    via = "desc-only";
    if (!script) throw new Error("未能提取到文案（无字幕、未配置 ASR、且视频无描述）");
  }

  return {
    awemeId,
    title: (item.desc || `抖音视频 ${awemeId}`).split("\n")[0].slice(0, 80),
    author: item.author?.nickname ?? "",
    script,
    via,
    url: `https://www.douyin.com/video/${awemeId}`,
  };
}

/** submit + poll，最长 90s（契约同 local_asr_server：/asr/submit → /asr/task/:id）。 */
async function asrTranscribe(mp4Url, asrBaseUrl) {
  try {
    const submit = await fetch(`${asrBaseUrl}/asr/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mp4Url }),
      signal: AbortSignal.timeout(12000),
    });
    if (!submit.ok) return "";
    const { task_id } = await submit.json();
    if (!task_id) return "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const poll = await fetch(`${asrBaseUrl}/asr/task/${task_id}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (poll.ok) {
          const result = await poll.json();
          if (result.status === "done" && result.text) return result.text;
          if (result.status === "error") return "";
        }
      } catch {
        /* keep polling */
      }
    }
  } catch {
    /* fallthrough */
  }
  return "";
}
