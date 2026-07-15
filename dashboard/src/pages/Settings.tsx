import { useEffect, useRef, useState } from "react";
import { api, type Settings as SettingsData, type TestResult } from "../api";

/**
 * 设置页 — M1 四张卡片：模型供应商 / MiniMax TTS / 声音克隆向导 / HeyGem 网关。
 * 密钥输入框永远不回显已存的 key（后端只回 set/hint），留空提交 = 保持不变。
 */
export function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [msg, setMsg] = useState("");

  const reload = () => api.settings().then(setS).catch((e) => setMsg(String(e.message)));
  useEffect(() => {
    reload();
  }, []);

  if (!s) return <div className="card">加载设置…{msg && <span className="muted"> {msg}</span>}</div>;

  return (
    <div>
      {msg && <div className="card error">{msg}</div>}
      <DiagnosticsCard />
      <LlmCard s={s} onSaved={setS} />
      <SourcesCard s={s} onSaved={setS} />
      <MinimaxCard s={s} onSaved={setS} />
      <VoiceCloneCard s={s} onSaved={setS} />
      <HeygemCard s={s} onSaved={setS} />
    </div>
  );
}

function DiagnosticsCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  const exportDiagnostics = async () => {
    setBusy(true);
    setResult("");
    try {
      const payload = await api.diagnostics();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      link.href = url;
      link.download = `videoforge-diagnostics-${stamp}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setResult("已导出诊断文件（密钥已脱敏）");
    } catch (error) {
      setResult(`导出失败：${error instanceof Error ? error.message : "无法读取诊断信息"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card vf-settings-card">
      <h3>远程排障</h3>
      <p className="muted">导出运行环境、配置状态和最近错误，便于提交问题。不包含 API key 或访问令牌。</p>
      <div className="vf-settings-actions">
        <button className="primary" disabled={busy} onClick={exportDiagnostics}>{busy ? "整理中…" : "一键导出诊断"}</button>
        {result && <span className={result.startsWith("已") ? "badge ok" : "badge err"}>{result}</span>}
      </div>
    </div>
  );
}

// ---- 共用小件 ----------------------------------------------------------------

function TestBadge({ r }: { r: TestResult | null }) {
  if (!r) return null;
  return r.ok ? (
    <span className="badge ok">
      ✓ 连接正常{r.ms != null ? ` · ${r.ms}ms` : ""}
      {typeof r.detail === "string" ? ` · ${r.detail}` : ""}
    </span>
  ) : (
    <span className="badge err">✗ {r.error ?? "失败"}</span>
  );
}

function KeyInput(props: {
  placeholder: string;
  hint: { set: boolean; hint: string };
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="password"
      style={{ flex: 1 }}
      placeholder={
        props.hint.set ? `已配置 ${props.hint.hint} — 留空保持不变` : props.placeholder
      }
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

function playBase64Mp3(b64: string) {
  new Audio(`data:audio/mpeg;base64,${b64}`).play().catch(() => {});
}

// ---- ① 模型供应商 -------------------------------------------------------------

function LlmCard({ s, onSaved }: { s: SettingsData; onSaved: (s: SettingsData) => void }) {
  const [mode, setMode] = useState(s.llm.mode);
  const [provider, setProvider] = useState(s.llm.provider);
  const [baseUrl, setBaseUrl] = useState(s.llm.baseUrl);
  const [model, setModel] = useState(s.llm.model);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.saveSettings({ llm: { mode, provider, baseUrl, model, apiKey } }));
      setApiKey("");
      setTest(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card vf-settings-card">
      <h3>模型供应商（生成文案/章节用）</h3>
      <div className="vf-settings-modes">
        <label className="vf-radio-option">
          <input type="radio" checked={mode === "subscription"} onChange={() => setMode("subscription")} />
          订阅模式（本机 claude 登录，无需 key）
        </label>
        <label className="vf-radio-option">
          <input type="radio" checked={mode === "api"} onChange={() => setMode("api")} />
          API 模式（自己的 key）
        </label>
      </div>
      {mode === "api" && (
        <>
          <div className="vf-settings-grid">
            <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="anthropic">Anthropic（Claude API）</option>
              <option value="openai-compatible">OpenAI 兼容（DeepSeek/Kimi/GLM…）</option>
            </select>
            <input
              placeholder="模型名，如 gpt-5.5 / claude-sonnet-5"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          {provider === "openai-compatible" && (
            <div className="vf-settings-field">
              <input
                placeholder="Base URL，如 https://api.deepseek.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
          )}
          <div className="vf-settings-field">
            <KeyInput placeholder="API key（只存本机，不上传）" hint={s.llm.apiKeyState} value={apiKey} onChange={setApiKey} />
          </div>
        </>
      )}
      <div className="vf-settings-actions">
        <button className="primary" disabled={busy} onClick={save}>
          保存
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setTest(await api.testLlm().catch((e) => ({ ok: false, error: String(e.message) })));
            setBusy(false);
          }}
        >
          {busy ? "…" : "测试连接"}
        </button>
        <TestBadge r={test} />
      </div>
    </div>
  );
}

// ---- ①.5 内容源（TikHub / ASR）--------------------------------------------------

function SourcesCard({ s, onSaved }: { s: SettingsData; onSaved: (s: SettingsData) => void }) {
  const [tikhubKey, setTikhubKey] = useState("");
  const [asrUrl, setAsrUrl] = useState(s.asr.baseUrl);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  return (
    <div className="card">
      <h3>内容源（抖音提取）</h3>
      <p className="muted">
        TikHub key 用于解析抖音视频与内置字幕（api.tikhub.io）；ASR 地址是无字幕视频的 Whisper
        转录兜底服务（如 http://asr.yyagent.top，留空则跳过 ASR）。
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <KeyInput
          placeholder="TikHub API key（只存本机）"
          hint={s.tikhub.apiKeyState}
          value={tikhubKey}
          onChange={setTikhubKey}
        />
        <input
          placeholder="ASR 服务地址（可选）"
          style={{ flex: 1 }}
          value={asrUrl}
          onChange={(e) => setAsrUrl(e.target.value)}
        />
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onSaved(
                await api.saveSettings({ tikhub: { apiKey: tikhubKey }, asr: { baseUrl: asrUrl } }),
              );
              setTikhubKey("");
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </button>
        <button
          disabled={busy || !asrUrl.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              if (asrUrl.trim() !== s.asr.baseUrl) {
                onSaved(await api.saveSettings({ asr: { baseUrl: asrUrl } }));
              }
              setTest(await api.asrHealth().catch((e) => ({ ok: false, error: String(e.message) })));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "检查中…" : "检查语音识别"}
        </button>
        <TestBadge r={test} />
      </div>
    </div>
  );
}

// ---- ② MiniMax TTS ------------------------------------------------------------

const EMOTIONS = ["angry", "calm", "happy", "sad", "surprised", "fearful", "disgusted"];

function MinimaxCard({ s, onSaved }: { s: SettingsData; onSaved: (s: SettingsData) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [speed, setSpeed] = useState(s.minimax.speed);
  const [emotion, setEmotion] = useState(s.minimax.emotion);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  const save = async () => {
    setBusy("save");
    try {
      onSaved(await api.saveSettings({ minimax: { apiKey, speed: Number(speed), emotion } }));
      setApiKey("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <h3>MiniMax 语音合成</h3>
      <p className="muted">
        当前音色：<b>{s.minimax.voiceId}</b> · 语速/情绪为已调教默认值（1.12 / angry），改动前建议先试听
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <KeyInput
          placeholder="MiniMax API key（sk-api-…，只存本机）"
          hint={s.minimax.apiKeyState}
          value={apiKey}
          onChange={setApiKey}
        />
      </div>
      <div className="row" style={{ marginBottom: 8, alignItems: "center" }}>
        <label>
          语速{" "}
          <input
            type="number"
            step={0.01}
            min={0.5}
            max={2}
            style={{ width: 80 }}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </label>
        <label>
          情绪{" "}
          <select value={emotion} onChange={(e) => setEmotion(e.target.value)}>
            {EMOTIONS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
            <option value="">（无）</option>
          </select>
        </label>
      </div>
      <div className="row">
        <button className="primary" disabled={busy !== null} onClick={save}>
          保存
        </button>
        <button
          disabled={busy !== null}
          onClick={async () => {
            setBusy("test");
            setTest(await api.testMinimax().catch((e) => ({ ok: false, error: String(e.message) })));
            setBusy(null);
          }}
        >
          {busy === "test" ? "…" : "测试 key"}
        </button>
        <button
          disabled={busy !== null}
          onClick={async () => {
            setBusy("prev");
            const r = await api.voicePreview({ speed: Number(speed), emotion }).catch((e) => ({
              ok: false,
              error: String(e.message),
            }));
            if (r.ok && "audioBase64" in r && r.audioBase64) playBase64Mp3(r.audioBase64);
            else setTest(r as TestResult);
            setBusy(null);
          }}
        >
          {busy === "prev" ? "合成中…" : "🔊 试听当前参数"}
        </button>
        <TestBadge r={test} />
      </div>
    </div>
  );
}

// ---- ③ 声音克隆向导 ------------------------------------------------------------

function VoiceCloneCard({ s, onSaved }: { s: SettingsData; onSaved: (s: SettingsData) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const doClone = async () => {
    if (!file || !voiceId) return;
    if (
      !window.confirm(
        `声音克隆是一次性付费操作（约 ¥10，从你的 MiniMax 账户扣费），同一个人只需克隆一次。\n\n确认用「${file.name}」克隆为音色「${voiceId}」？`,
      )
    )
      return;
    setBusy(true);
    setResult("");
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await api.voiceClone({ filename: file.name, dataBase64, voiceId });
      if (r.ok && r.demoBase64) {
        playBase64Mp3(r.demoBase64);
        setResult(`✓ 克隆成功，已设为默认音色：${r.voiceId}（正在播放试听）`);
        onSaved(await api.settings());
        setFile(null);
        setVoiceId("");
        if (fileRef.current) fileRef.current.value = "";
      } else {
        setResult(`✗ ${r.error ?? "克隆失败"}`);
      }
    } catch (err) {
      setResult(`✗ ${String((err as Error).message ?? err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>声音克隆（一次性付费 ~¥10，请勿重复克隆）</h3>
      <p className="muted">
        上传 10–300 秒、≤20MB 的清晰人声（mp3/m4a/wav），安静环境、正常语速效果最好。当前默认音色{" "}
        <b>{s.minimax.voiceId}</b> 若还满意，无需重新克隆。
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          ref={fileRef}
          type="file"
          accept=".mp3,.m4a,.wav,audio/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <input
          placeholder="新音色 ID（8+位，字母开头，如 MyVoice01）"
          style={{ flex: 1 }}
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
        />
        <button className="primary" disabled={!file || !voiceId || busy} onClick={doClone}>
          {busy ? "克隆中…" : "开始克隆"}
        </button>
      </div>
      {result && <div className={result.startsWith("✓") ? "badge ok" : "badge err"}>{result}</div>}
    </div>
  );
}

// ---- ④ HeyGem 网关 -------------------------------------------------------------

function HeygemCard({ s, onSaved }: { s: SettingsData; onSaved: (s: SettingsData) => void }) {
  const [baseUrl, setBaseUrl] = useState(s.heygem.baseUrl);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  return (
    <div className="card">
      <h3>HeyGem 对口型服务（数字人头像）</h3>
      <p className="muted">
        本机跑填 <code>http://127.0.0.1:7861</code>；低配电脑填远程网关地址 + 访问令牌。
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          placeholder="服务地址"
          style={{ flex: 1 }}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <KeyInput placeholder="访问令牌（本机可留空）" hint={s.heygem.tokenState} value={token} onChange={setToken} />
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onSaved(await api.saveSettings({ heygem: { baseUrl, token } }));
              setToken("");
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await api.heygemHealth().catch((e) => ({ ok: false, error: String(e.message) }));
            setTest(
              r.ok && !(r as TestResult & { ready?: boolean }).ready
                ? { ...r, ok: false, error: "服务在线但模型还在加载（30-90s）" }
                : (r as TestResult),
            );
            setBusy(false);
          }}
        >
          {busy ? "…" : "检查服务"}
        </button>
        <TestBadge r={test} />
      </div>
    </div>
  );
}
