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
  message: string;
  status: string;
  created_at: string;
}

export interface JobDetail extends Job {
  events: JobEvent[];
  feedback: Feedback[];
  devServer: { running: boolean; port?: number; url?: string };
}

export interface KeyState {
  set: boolean;
  hint: string;
}

export interface Settings {
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
  };
  search: {
    directions: string;
  };
}

export interface TestResult {
  ok: boolean;
  error?: string;
  detail?: unknown;
  mode?: string;
  ready?: boolean;
  ms?: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  meta: () => req<{ stages: StageDef[]; theme: string }>("/meta"),
  sources: () => req<Source[]>("/sources"),
  addSource: (name: string, url: string) =>
    req("/sources", { method: "POST", body: JSON.stringify({ name, url }) }),
  removeSource: (id: number) => req(`/sources/${id}`, { method: "DELETE" }),
  runDiscovery: () =>
    req<{ added: number; sources: number; errors: string[] }>("/discovery/run", { method: "POST" }),
  articles: (status = "new") => req<Article[]>(`/articles?status=${status}`),
  addManualArticle: (payload: { url?: string; title?: string; text?: string }) =>
    req("/articles/manual", { method: "POST", body: JSON.stringify(payload) }),
  dismissArticle: (id: number) => req(`/articles/${id}/dismiss`, { method: "POST" }),
  selectArticle: (id: number) =>
    req<{ jobId: number }>(`/articles/${id}/select`, { method: "POST" }),
  jobs: () => req<Job[]>("/jobs"),
  job: (id: number) => req<JobDetail>(`/jobs/${id}`),
  approve: (id: number) => req(`/jobs/${id}/approve`, { method: "POST" }),
  retry: (id: number, stage?: string) =>
    req(`/jobs/${id}/retry`, { method: "POST", body: JSON.stringify({ stage }) }),
  sendFeedback: (id: number, chapter: string | null, message: string) =>
    req(`/jobs/${id}/feedback`, { method: "POST", body: JSON.stringify({ chapter, message }) }),
  devStart: (id: number) =>
    req<{ running: boolean; url?: string }>(`/jobs/${id}/devserver/start`, { method: "POST" }),
  devStop: (id: number) => req(`/jobs/${id}/devserver/stop`, { method: "POST" }),

  // settings / providers / voice / heygem — M1
  settings: () => req<Settings>("/settings"),
  saveSettings: (patch: unknown) =>
    req<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  testLlm: () => req<TestResult>("/settings/test-llm", { method: "POST" }),
  testMinimax: () => req<TestResult>("/settings/test-minimax", { method: "POST" }),
  voicePreview: (payload: { text?: string; speed?: number; emotion?: string; voiceId?: string }) =>
    req<{ ok: boolean; audioBase64?: string; error?: string }>("/voice/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  voiceClone: (payload: { filename: string; dataBase64: string; voiceId: string }) =>
    req<{ ok: boolean; voiceId?: string; demoBase64?: string; error?: string }>("/voice/clone", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  heygemHealth: () => req<TestResult>("/heygem/health"),

  // content sources — M1
  searchTopics: (directions: string) =>
    req<{ ok: boolean; found?: number; added?: number; error?: string }>("/discovery/search", {
      method: "POST",
      body: JSON.stringify({ directions }),
    }),
  douyinExtract: (url: string) =>
    req<{ ok: boolean; added?: boolean; via?: string; chars?: number; title?: string; error?: string }>(
      "/articles/douyin",
      { method: "POST", body: JSON.stringify({ url }) },
    ),
};
