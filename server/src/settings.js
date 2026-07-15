import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "./config.js";

/**
 * User settings that contain SECRETS (LLM / MiniMax API keys, HeyGem token).
 * Kept in a separate gitignored file — never in data.db, never in config.json
 * (which is shareable), never returned unmasked by any API. This is the
 * "BYO API key, stored locally only" layer from PRODUCT-PLAN §二.
 */
const SETTINGS_PATH = join(DATA_ROOT, "settings.local.json");

const DEFAULTS = {
  onboarded: false,
  llm: {
    // "subscription" = ride the local `claude` login (v1 behavior, no key).
    // "api" = call a provider directly with the user's own key.
    mode: "subscription",
    provider: "anthropic", // "anthropic" | "openai-compatible"
    baseUrl: "", // only for openai-compatible (e.g. https://api.deepseek.com/v1)
    apiKey: "",
    model: "gpt-5.6-sol",
  },
  minimax: {
    apiKey: "", // empty = fall back to MINIMAX_API_KEY env var (v1 behavior)
    baseUrl: "https://api.minimaxi.com",
    model: "speech-2.8-hd",
    voiceId: "GongheJiucun02",
    speed: 1.12,
    emotion: "angry",
  },
  heygem: {
    baseUrl: "http://127.0.0.1:7861",
    token: "", // reserved for the remote-gateway auth (PRODUCT-PLAN §三.9)
  },
  tikhub: {
    apiKey: "", // api.tikhub.io — 抖音视频解析/字幕（选题来源之一）
  },
  asr: {
    // Whisper ASR fallback for Douyin videos without built-in subtitles.
    // The user's own service (local_asr_server, frp: asr.yyagent.top);
    // empty = skip ASR, fall back to the video description.
    baseUrl: "",
    openAiBaseUrl: "",
    apiKey: "",
    model: "whisper-1",
  },
  search: {
    directions: "AI 编程工具, AI 行业动态", // 联网搜索选题的默认方向词
  },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? deepMerge(base[k] ?? {}, v)
        : v;
  }
  return out;
}

export function loadSettings() {
  let file = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      file = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    } catch {
      /* corrupted file → treat as empty rather than crash the server */
    }
  }
  return deepMerge(DEFAULTS, file);
}

export function saveSettings(patch) {
  const merged = deepMerge(loadSettings(), patch ?? {});
  writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

/** Resolve the MiniMax key: settings first, env var fallback. */
export function minimaxKey(settings = loadSettings()) {
  return settings.minimax.apiKey || process.env.MINIMAX_API_KEY || "";
}

const mask = (key) =>
  key ? { set: true, hint: `…${key.slice(-4)}` } : { set: false, hint: "" };

/** Settings shaped for the dashboard: secrets replaced with set/hint flags. */
export function publicSettings() {
  const s = loadSettings();
  return {
    onboarded: Boolean(s.onboarded),
    llm: { ...s.llm, apiKey: undefined, apiKeyState: mask(s.llm.apiKey) },
    minimax: {
      ...s.minimax,
      apiKey: undefined,
      // env fallback counts as "configured" — the UI should say so.
      apiKeyState: s.minimax.apiKey
        ? mask(s.minimax.apiKey)
        : process.env.MINIMAX_API_KEY
          ? { set: true, hint: "(环境变量)" }
          : { set: false, hint: "" },
    },
    heygem: { ...s.heygem, token: undefined, tokenState: mask(s.heygem.token) },
    tikhub: { apiKeyState: mask(s.tikhub.apiKey) },
    asr: { ...s.asr, apiKey: undefined, apiKeyState: mask(s.asr.apiKey) },
    search: { ...s.search },
  };
}
