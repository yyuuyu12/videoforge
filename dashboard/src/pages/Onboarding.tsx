import { useState } from "react";
import { api, type Settings, type TestResult } from "../api";

type Destination = "new" | "assets";

export function Onboarding({ settings, onComplete }: { settings: Settings; onComplete: (destination: Destination) => void }) {
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState(settings.llm.mode);
  const [provider, setProvider] = useState(settings.llm.provider);
  const [baseUrl, setBaseUrl] = useState(settings.llm.baseUrl);
  const [model, setModel] = useState(settings.llm.model);
  const [llmKey, setLlmKey] = useState("");
  const [minimaxKey, setMinimaxKey] = useState("");
  const [llmTest, setLlmTest] = useState<TestResult | null>(null);
  const [voiceTest, setVoiceTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const testLlm = async () => {
    setBusy(true);
    setLlmTest(null);
    try {
      await api.saveSettings({ llm: { mode, provider, baseUrl, model, apiKey: llmKey } });
      setLlmKey("");
      setLlmTest(await api.testLlm());
    } catch (error) {
      setLlmTest({ ok: false, error: error instanceof Error ? error.message : "连接失败" });
    } finally {
      setBusy(false);
    }
  };

  const testVoice = async () => {
    setBusy(true);
    setVoiceTest(null);
    try {
      await api.saveSettings({ minimax: { apiKey: minimaxKey } });
      setMinimaxKey("");
      setVoiceTest(await api.testMinimax());
    } catch (error) {
      setVoiceTest({ ok: false, error: error instanceof Error ? error.message : "连接失败" });
    } finally {
      setBusy(false);
    }
  };

  const finish = async (destination: Destination) => {
    setBusy(true);
    try {
      await api.saveSettings({ onboarded: true });
      onComplete(destination);
    } finally {
      setBusy(false);
    }
  };

  return <main className="vf-onboarding">
    <header className="vf-onboarding-brand"><b>VF</b><span>VideoForge</span></header>
    <section className="vf-onboarding-shell">
      <ol className="vf-onboarding-steps" aria-label="开始使用进度">
        {["连接模型", "连接声音", "准备形象"].map((label, index) => <li className={step === index + 1 ? "active" : step > index + 1 ? "done" : ""} key={label}><b>{step > index + 1 ? "✓" : index + 1}</b><span>{label}</span></li>)}
      </ol>

      {step === 1 && <section className="vf-onboarding-panel">
        <p className="vf-kicker">第一步</p><h1>连接生成模型</h1><p>模型负责整理口播稿和制作逐章画面。先选择你已有的使用方式。</p>
        <div className="vf-onboarding-choices">
          <button className={mode === "subscription" ? "selected" : ""} onClick={() => { setMode("subscription"); setLlmTest(null); }}><b>本机 Claude 订阅</b><span>这台电脑已经登录 Claude Code 时使用</span><em>推荐</em></button>
          <button className={mode === "api" ? "selected" : ""} onClick={() => { setMode("api"); setLlmTest(null); }}><b>使用 API Key</b><span>连接 Anthropic 或 OpenAI 兼容服务</span></button>
        </div>
        {mode === "api" && <div className="vf-onboarding-fields">
          <select aria-label="模型供应商" value={provider} onChange={(event) => { setProvider(event.target.value as typeof provider); setLlmTest(null); }}><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI 兼容服务</option></select>
          {provider === "openai-compatible" && <input aria-label="服务地址" placeholder="服务地址，如 https://api.example.com/v1" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setLlmTest(null); }} />}
          <input aria-label="模型名称" placeholder="模型名称" value={model} onChange={(event) => { setModel(event.target.value); setLlmTest(null); }} />
          <input aria-label="模型 API Key" type="password" placeholder={settings.llm.apiKeyState.set ? `已配置 ${settings.llm.apiKeyState.hint}，留空保持不变` : "API Key（只保存在这台电脑）"} value={llmKey} onChange={(event) => { setLlmKey(event.target.value); setLlmTest(null); }} />
        </div>}
        <Result result={llmTest} success="模型连接正常，可以继续" />
        <footer><span>需要先验证连接，避免制作到一半才发现配置不可用。</span><div><button disabled={busy} onClick={testLlm}>{busy ? "正在检查…" : "测试连接"}</button><button className="vf-primary" disabled={!llmTest?.ok} onClick={() => setStep(2)}>下一步</button></div></footer>
      </section>}

      {step === 2 && <section className="vf-onboarding-panel">
        <p className="vf-kicker">第二步</p><h1>连接配音服务</h1><p>MiniMax 会把口播稿合成为配音。没有 Key 也可以先跳过，稍后在设置里补充。</p>
        <div className="vf-onboarding-fields single"><input aria-label="MiniMax API Key" type="password" placeholder={settings.minimax.apiKeyState.set ? `已配置 ${settings.minimax.apiKeyState.hint}，留空保持不变` : "MiniMax API Key（只保存在这台电脑）"} value={minimaxKey} onChange={(event) => { setMinimaxKey(event.target.value); setVoiceTest(null); }} /></div>
        <Result result={voiceTest} success="配音服务连接正常" />
        <footer><button className="vf-text-action" disabled={busy} onClick={() => setStep(3)}>暂时跳过</button><div><button disabled={busy} onClick={() => setStep(1)}>上一步</button><button disabled={busy || (!minimaxKey && !settings.minimax.apiKeyState.set)} onClick={testVoice}>{busy ? "正在检查…" : "保存并测试"}</button><button className="vf-primary" disabled={!voiceTest?.ok} onClick={() => setStep(3)}>下一步</button></div></footer>
      </section>}

      {step === 3 && <section className="vf-onboarding-panel">
        <p className="vf-kicker">第三步</p><h1>是否准备出镜形象？</h1><p>上传一段正面出镜视频后，可以在作品里生成同步口型的讲解头像。这一步不会克隆声音，也可以以后再做。</p>
        <div className="vf-onboarding-avatar"><div><span>画面内容</span><b>演示与字幕区域</b></div><aside><i /><strong>你的形象</strong></aside></div>
        <footer><button disabled={busy} onClick={() => setStep(2)}>上一步</button><div><button disabled={busy} onClick={() => finish("assets")}>先准备形象</button><button className="vf-primary" disabled={busy} onClick={() => finish("new")}>{busy ? "正在完成…" : "暂不使用，创建第一支作品"}</button></div></footer>
      </section>}
    </section>
  </main>;
}

function Result({ result, success }: { result: TestResult | null; success: string }) {
  if (!result) return null;
  return <div className={`vf-onboarding-result ${result.ok ? "ok" : "error"}`} role="status"><b>{result.ok ? success : "连接没有通过"}</b><span>{result.ok ? (typeof result.detail === "string" ? result.detail : "配置已保存") : `${result.error ?? "请检查填写内容"}。调整后可以重新测试。`}</span></div>;
}
