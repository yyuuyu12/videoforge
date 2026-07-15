import { useEffect, useState } from "react";
import { api, type Settings as SettingsData, type StageDef, type VersionInfo } from "./api";
import { Articles } from "./pages/Articles";
import { Settings } from "./pages/Settings";
import { NewWork } from "./pages/NewWork";
import { Works } from "./pages/Works";
import { Workbench } from "./pages/Workbench";
import { Assets } from "./pages/Assets";
import { Usage } from "./pages/Usage";
import { Onboarding } from "./pages/Onboarding";

type Tab = "works" | "new" | "assets" | "settings" | "usage";

export default function App() {
  const [tab, setTab] = useState<Tab>("works");
  const [openJob, setOpenJob] = useState<number | null>(null);
  const [stages, setStages] = useState<StageDef[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [startupError, setStartupError] = useState("");
  const [update, setUpdate] = useState<VersionInfo | null>(null);

  useEffect(() => {
    api.meta().then((m) => setStages(m.stages)).catch(() => {});
    api.settings().then(setSettings).catch((error) => setStartupError(error.message));
    api.version().then((info) => {
      if (info.updateAvailable) setUpdate(info);
    }).catch(() => {});
  }, []);

  if (startupError) return <main className="vf-opening-loader"><strong>工作台暂时无法启动</strong><span>{startupError}</span></main>;
  if (!settings) return <main className="vf-opening-loader"><strong>正在准备工作台</strong><span>读取这台电脑上的配置…</span></main>;
  if (!settings.onboarded) {
    return <Onboarding settings={settings} onComplete={(destination) => {
      setSettings((current) => current ? { ...current, onboarded: true } : current);
      setTab(destination);
    }} />;
  }

  return (
    <div className="vf-shell">
      <header className="vf-topbar"><button className="vf-brand" onClick={() => { setTab("works"); setOpenJob(null); }}><b>VF</b><span>VideoForge</span></button><nav><button className={tab === "works" && openJob === null ? "active" : ""} onClick={() => { setTab("works"); setOpenJob(null); }}>作品</button><button className={tab === "new" ? "active" : ""} onClick={() => { setTab("new"); setOpenJob(null); }}>新建</button><button className={tab === "assets" ? "active" : ""} onClick={() => { setTab("assets"); setOpenJob(null); }}>素材库</button><button className={tab === "settings" ? "active" : ""} onClick={() => { setTab("settings"); setOpenJob(null); }}>设置</button><button className={tab === "usage" ? "active" : ""} onClick={() => { setTab("usage"); setOpenJob(null); }}>用量</button></nav><div className="vf-topbar-end"><span className="vf-online" />本机工作台</div></header>
      {update && <aside className="vf-update-banner"><span>VideoForge {update.latest} 已发布</span>{update.releaseUrl && <a href={update.releaseUrl} target="_blank" rel="noreferrer">查看新版</a>}<button title="关闭更新提示" aria-label="关闭更新提示" onClick={() => setUpdate(null)}>×</button></aside>}
      {openJob !== null ? <Workbench jobId={openJob} onBack={() => { setOpenJob(null); setTab("works"); }} /> : tab === "works" ? <Works onOpen={setOpenJob} onCreate={() => setTab("new")} /> : tab === "new" ? <NewWork onCreated={setOpenJob} /> : tab === "assets" ? <Assets /> : tab === "settings" ? <main className="vf-page"><section className="vf-page-head"><div><p className="vf-kicker">后台设置</p><h2>声音与模型统一配置</h2><p>所有密钥只保存在这台电脑上。</p></div></section><Settings /></main> : tab === "usage" ? <Usage /> : <Articles onJobCreated={setOpenJob} />}
    </div>
  );
}
