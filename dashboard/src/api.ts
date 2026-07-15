export interface Source {
  id: number;
  name: string;
  type: string;
  url: string;
  enabled: number;
}

export interface Article {
  id: number;
  source_id: number | null;
  title: string;
  url: string | null;
  summary: string | null;
  score: number | null;
  status: string;
  fetched_at: string;
}

export interface StageDef {
  id: string;
  kind: "work" | "gate";
  label: string;
}

export interface Job {
  id: number;
  article_id: number | null;
  title: string | null;
  workspace: string;
  stage: string;
  status: "queued" | "running" | "waiting_approval" | "failed" | "done";
  created_at: string;
  updated_at: string;
  excerpt?: string | null;
  coverExists?: boolean;
  error?: string | null;
}

export interface JobEvent {
  id: number;
  stage: string | null;
  level: string;
  message: string;
  ts: string;
}

export interface Feedback {
  id: number;
  chapter: string | null;
  phase: string | null;
  message: string;
  status: string;
  progress: number;
  progress_message: string | null;
  error: string | null;
  result: string | null;
  created_at: string;
}

export interface ChapterReview {
  key: string;
  index: number;
  title: string;
  steps: number;
  ready: boolean;
  status: "queued" | "generating" | "review" | "approved";
}

export interface ChapterGeneration {
  service: string;
  expected: number;
  discovered: number;
  ready: number;
  completed: number;
  approved: number;
  percent: number;
  current: { current: number; total: number; chapter: string; status: string; message: string } | null;
  message: string;
  chapters: ChapterReview[];
}

export interface RenderOutput {
  exists: boolean;
  rendering: boolean;
  durationSec?: number;
  segmentsPlaced?: number;
  segmentsExpected?: number;
  frames?: number;
  renderedAt?: string;
}

export interface JobDetail extends Job {
  meta: string;
  events: JobEvent[];
  feedback: Feedback[];
  chapterGeneration: ChapterGeneration;
  devServer: { running: boolean; port?: number; url?: string; mode?: "static" | "dev" };
  output?: RenderOutput;
}

export interface KeyState {
  set: boolean;
  hint: string;
}

export interface Settings {
  onboarded: boolean;
  llm: {
    mode: "subscription" | "api";
    provider: "anthropic" | "openai-compatible";
    baseUrl: string;
    model: string;
    apiKeyState: KeyState;
  };
  minimax: {
    baseUrl: string;
    model: string;
    voiceId: string;
    speed: number;
    emotion: string;
    apiKeyState: KeyState;
  };
  heygem: {
    baseUrl: string;
    tokenState: KeyState;
  };
  tikhub: {
    apiKeyState: KeyState;
  };
  asr: {
    baseUrl: string;
    openAiBaseUrl?: string;
    model?: string;
    apiKeyState?: KeyState;
  };
  search: {
    directions: string;
  };
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl?: string;
  checked: boolean;
  message?: string;
}

export interface TestResult {
  ok: boolean;
  configured?: boolean;
  error?: string;
  detail?: unknown;
  mode?: string;
  ready?: boolean;
  ms?: number;
}

export interface AvatarAsset {
  id: string;
  filename: string;
  name: string;
  size: number;
  url: string;
}

export interface AvatarPreview {
  id: string;
  name: string;
  url: string;
}

export interface JobAudit {
  jobId: number;
  layout: { ok: boolean; chapters: Array<{ chapter: string; reserved: boolean }> };
  audio: { ok: boolean; segments: number };
  subtitle: { enabled: boolean; ok: boolean; preset: string; position: string };
  avatar: {
    enabled: boolean;
    sourceExists: boolean;
    outputExists: boolean;
    previews: number;
    service: TestResult;
  };
  render: { ok: boolean; outputExists: boolean };
  dialogue: { total: number };
}

export interface DouyinExtraction {
  id: number;
  input_url: string;
  aweme_id: string | null;
  title: string | null;
  author: string | null;
  status: "queued" | "running" | "done" | "failed";
  stage: string;
  progress: number;
  message: string | null;
  via: string | null;
  duration_seconds: number | null;
  chars: number;
  content: string | null;
  article_id: number | null;
  job_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  steps: Array<{ id: string; ok: boolean; warning?: boolean; message: string }>;
}

export interface UsageData {
  days: number;
  totals: {
    requests: number;
    succeeded: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    minimaxCharacters: number;
    minimaxEstimatedCny: number;
  };
  services: Array<{
    service: string;
    requests: number;
    succeeded: number;
    failed: number;
    input_tokens: number;
    output_tokens: number;
    units: number;
    unit: string | null;
    avg_duration_ms: number | null;
    has_estimates: number;
  }>;
  categories: Array<{
    category: "text" | "visual" | "audio" | "avatar" | "source" | "other";
    requests: number;
    input_tokens: number;
    output_tokens: number;
    characters: number;
    audio_seconds: number;
    audio_mb: number;
  }>;
  daily: Array<{ day: string; requests: number; tokens: number; minimax_characters: number }>;
  recent: Array<{
    id: number;
    service: string;
    operation: string;
    job_id: number | null;
    status: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    units: number;
    unit: string | null;
    duration_ms: number;
    estimated: number;
    detail: string | null;
    created_at: string;
    category: "text" | "visual" | "audio" | "avatar" | "source" | "other";
  }>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

function friendlyError(status: number | null, detail: string, error?: unknown) {
  const raw = detail.trim();
  const normalized = `${raw} ${error instanceof Error ? error.name : ""}`.toLowerCase();
  if (/[一-鿿]/.test(raw) && raw.length <= 180 && !/(econn|fetch failed|stack|http \d{3})/i.test(raw)) {
    return raw;
  }
  if (normalized.includes("abort") || normalized.includes("timeout") || normalized.includes("timed out")) {
    return "服务响应时间过长，可能仍在启动或当前繁忙。请确认相关服务已启动，稍后重试。";
  }
  if (normalized.includes("heygem")) {
    return "数字人服务暂时不可用。请在设置中检查 HeyGem 地址，并确认服务已经启动。";
  }
  if (normalized.includes("whisper") || normalized.includes("asr")) {
    return "语音识别服务暂时不可用。请确认 Whisper ASR 已启动，或在设置中检查服务地址。";
  }
  if (normalized.includes("ffmpeg") || normalized.includes("ffprobe")) {
    return "导出组件不可用，暂时无法生成视频。请安装 ffmpeg，或使用包含导出组件的正式安装包。";
  }
  if (normalized.includes("econnrefused") || normalized.includes("fetch failed") || normalized.includes("networkerror") || normalized.includes("failed to fetch")) {
    return "无法连接到服务，可能是服务尚未启动或地址配置不正确。请检查服务状态和设置后重试。";
  }
  if (status === 401 || status === 403 || normalized.includes("api key") || normalized.includes("apikey") || normalized.includes("quota")) {
    return "外部服务拒绝了请求，可能是密钥无效或账户额度不足。请在设置中检查密钥和账户余额。";
  }
  if (status !== null && status >= 500) {
    return "服务暂时处理失败。请稍后重试；如果反复出现，请在设置中导出诊断文件。";
  }
  return raw || "请求没有成功。请检查当前配置后重试；如果问题持续，请导出诊断文件。";
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`/api${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch (error) {
    throw new Error(friendlyError(null, error instanceof Error ? error.message : "", error));
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    const detail = (body as { error?: string }).error ?? "";
    throw new Error(friendlyError(resp.status, detail));
  }
  return resp.json() as Promise<T>;
}

export const api = {
  meta: () => req<{ stages: StageDef[]; theme: string }>("/meta"),
  usage: (days = 30, page = 1, pageSize = 12) =>
    req<UsageData>(`/usage?days=${days}&page=${page}&pageSize=${pageSize}`),
  sources: () => req<Source[]>("/sources"),
  addSource: (name: string, url: string) =>
    req("/sources", { method: "POST", body: JSON.stringify({ name, url }) }),
  removeSource: (id: number) => req(`/sources/${id}`, { method: "DELETE" }),
  runDiscovery: () =>
    req<{ added: number; sources: number; errors: string[] }>(
      "/discovery/run",
      { method: "POST" },
    ),
  articles: (status = "new") => req<Article[]>(`/articles?status=${status}`),
  addManualArticle: (payload: {
    url?: string;
    title?: string;
    text?: string;
  }) =>
    req("/articles/manual", { method: "POST", body: JSON.stringify(payload) }),
  dismissArticle: (id: number) =>
    req(`/articles/${id}/dismiss`, { method: "POST" }),
  selectArticle: (id: number) =>
    req<{ jobId: number }>(`/articles/${id}/select`, { method: "POST" }),
  jobs: () => req<Job[]>("/jobs"),
  job: (id: number) => req<JobDetail>(`/jobs/${id}`),
  audit: (id: number) => req<JobAudit>(`/jobs/${id}/audit`),
  deleteJob: (id: number) =>
    req<{ ok: boolean; workspaceRemoved: boolean }>(`/jobs/${id}`, {
      method: "DELETE",
    }),
  approve: (id: number) => req(`/jobs/${id}/approve`, { method: "POST" }),
  approveChapter: (id: number, chapter: string) =>
    req(`/jobs/${id}/chapters/${encodeURIComponent(chapter)}/approve`, { method: "POST" }),
  retry: (id: number, stage?: string) =>
    req(`/jobs/${id}/retry`, {
      method: "POST",
      body: JSON.stringify({ stage }),
    }),
  startRender: (id: number) =>
    req<{ ok: boolean; started: boolean }>(`/jobs/${id}/render`, {
      method: "POST",
    }),
  sendFeedback: (
    id: number,
    chapter: string | null,
    message: string,
    phase?: string,
  ) =>
    req(`/jobs/${id}/feedback`, {
      method: "POST",
      body: JSON.stringify({ chapter, message, phase }),
    }),
  jobFile: (id: number, name: string) =>
    req<{ ok: boolean; name: string; content: string | null }>(
      `/jobs/${id}/files/${name}`,
    ),
  devStart: (id: number) =>
    req<{ running: boolean; url?: string }>(`/jobs/${id}/devserver/start`, {
      method: "POST",
    }),
  devStop: (id: number) =>
    req(`/jobs/${id}/devserver/stop`, { method: "POST" }),
  saveJobOptions: (id: number, patch: unknown) =>
    req<JobDetail>(`/jobs/${id}/options`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  uploadAvatar: (
    id: number,
    payload: { filename: string; dataBase64: string },
  ) =>
    req<{ ok: boolean; filename: string }>(`/jobs/${id}/avatar`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  generateAvatar: (id: number) =>
    req(`/jobs/${id}/avatar/generate`, { method: "POST" }),
  avatarAssets: () => req<AvatarAsset[]>("/assets/avatars"),
  uploadAvatarAsset: (payload: { filename: string; dataBase64: string }) =>
    req<AvatarAsset>("/assets/avatars", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteAvatarAsset: (id: string) =>
    req(`/assets/avatars/${id}`, { method: "DELETE" }),
  selectAvatarAsset: (jobId: number, assetId: string) =>
    req(`/jobs/${jobId}/avatar/select`, {
      method: "POST",
      body: JSON.stringify({ assetId }),
    }),
  avatarPreviews: (jobId: number) =>
    req<AvatarPreview[]>(`/jobs/${jobId}/avatar/previews`),

  // settings / providers / voice / heygem — M1
  settings: () => req<Settings>("/settings"),
  version: () => req<VersionInfo>("/version"),
  diagnostics: () => req<Record<string, unknown>>("/diagnostics"),
  saveSettings: (patch: unknown) =>
    req<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  testLlm: () => req<TestResult>("/settings/test-llm", { method: "POST" }),
  testMinimax: () =>
    req<TestResult>("/settings/test-minimax", { method: "POST" }),
  asrHealth: () => req<TestResult>("/asr/health"),
  voicePreview: (payload: {
    text?: string;
    speed?: number;
    emotion?: string;
    voiceId?: string;
  }) =>
    req<{ ok: boolean; audioBase64?: string; error?: string }>(
      "/voice/preview",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  voiceClone: (payload: {
    filename: string;
    dataBase64: string;
    voiceId: string;
  }) =>
    req<{ ok: boolean; voiceId?: string; demoBase64?: string; error?: string }>(
      "/voice/clone",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),
  heygemHealth: () => req<TestResult>("/heygem/health"),

  // content sources — M1
  searchTopics: (directions: string) =>
    req<{ ok: boolean; found?: number; added?: number; error?: string }>(
      "/discovery/search",
      {
        method: "POST",
        body: JSON.stringify({ directions }),
      },
    ),
  douyinExtract: (url: string) =>
    req<{
      ok: boolean;
      added?: boolean;
      articleId?: number;
      via?: string;
      chars?: number;
      title?: string;
      steps?: Array<{
        id: string;
        ok: boolean;
        warning?: boolean;
        message: string;
      }>;
      error?: string;
    }>("/articles/douyin", { method: "POST", body: JSON.stringify({ url }) }),
  douyinExtractions: () => req<DouyinExtraction[]>("/douyin/extractions"),
  createDouyinExtraction: (url: string) =>
    req<{ id: number; status: string }>("/douyin/extractions", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  retryDouyinExtraction: (id: number) =>
    req(`/douyin/extractions/${id}/retry`, { method: "POST" }),
  createWorkFromExtraction: (id: number) =>
    req<{ jobId: number; existing?: boolean }>(`/douyin/extractions/${id}/create-work`, { method: "POST" }),
};
