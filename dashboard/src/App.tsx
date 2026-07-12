import { useEffect, useState } from "react";
import { api, type StageDef } from "./api";
import { Articles } from "./pages/Articles";
import { Jobs } from "./pages/Jobs";
import { JobDetail } from "./pages/JobDetail";
import { Settings } from "./pages/Settings";

type Tab = "articles" | "jobs" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("articles");
  const [openJob, setOpenJob] = useState<number | null>(null);
  const [stages, setStages] = useState<StageDef[]>([]);

  useEffect(() => {
    api.meta().then((m) => setStages(m.stages)).catch(() => {});
  }, []);

  return (
    <div>
      <div className="topbar">
        <h1>
          Video<span>Forge</span>
        </h1>
        <div className="tabs">
          <button
            className={tab === "articles" && openJob === null ? "active" : ""}
            onClick={() => {
              setTab("articles");
              setOpenJob(null);
            }}
          >
            选题
          </button>
          <button
            className={tab === "jobs" || openJob !== null ? "active" : ""}
            onClick={() => {
              setTab("jobs");
              setOpenJob(null);
            }}
          >
            任务
          </button>
          <button
            className={tab === "settings" && openJob === null ? "active" : ""}
            onClick={() => {
              setTab("settings");
              setOpenJob(null);
            }}
          >
            设置
          </button>
        </div>
      </div>

      {openJob !== null ? (
        <JobDetail jobId={openJob} stages={stages} onBack={() => setOpenJob(null)} />
      ) : tab === "articles" ? (
        <Articles
          onJobCreated={(id) => {
            setOpenJob(id);
          }}
        />
      ) : tab === "jobs" ? (
        <Jobs stages={stages} onOpen={setOpenJob} />
      ) : (
        <Settings />
      )}
    </div>
  );
}
