import { useEffect, useState } from "react";
import { api, type Job, type StageDef } from "../api";

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "排队中",
  running: "运行中",
  waiting_approval: "待审批",
  failed: "失败",
  done: "完成",
  cancelling: "取消中",
  cancelled: "已取消",
};

export function Jobs({
  stages,
  onOpen,
}: {
  stages: StageDef[];
  onOpen: (id: number) => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    const load = () => api.jobs().then(setJobs).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const stageLabel = (id: string) => stages.find((s) => s.id === id)?.label ?? id;

  return (
    <div>
      {jobs.map((j) => (
        <div key={j.id} className="card" style={{ cursor: "pointer" }} onClick={() => onOpen(j.id)}>
          <div className="row spread">
            <div>
              <h3>
                #{j.id} {j.title ?? "(未命名)"}
              </h3>
              <div className="muted">
                阶段：{stageLabel(j.stage)} · 更新于 {j.updated_at}
              </div>
            </div>
            <span className={`badge ${j.status}`}>{STATUS_LABEL[j.status]}</span>
          </div>
        </div>
      ))}
      {jobs.length === 0 && <div className="muted">还没有任务——去"选题"页选一篇文章。</div>}
    </div>
  );
}
