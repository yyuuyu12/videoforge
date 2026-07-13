import { useEffect, useState } from "react";
import { api, type AvatarAsset } from "../api";

export function Assets() {
  const [items, setItems] = useState<AvatarAsset[]>([]);
  const [state, setState] = useState("");
  const load = () =>
    api
      .avatarAssets()
      .then(setItems)
      .catch(() => setState("素材库读取失败"));
  useEffect(() => {
    void load();
  }, []);
  const upload = async (file: File) => {
    setState(`正在上传 ${file.name}…`);
    try {
      if (file.size > 180 * 1024 * 1024) throw new Error("视频不能超过 180MB");
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api.uploadAvatarAsset({ filename: file.name, dataBase64 });
      setState("上传成功，以后制作作品可以直接选用");
      await load();
    } catch (error) {
      setState(
        `上传失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  };
  return (
    <main className="vf-page">
      <section className="vf-page-head">
        <div>
          <p className="vf-kicker">素材库</p>
          <h2>我的数字人</h2>
          <p>在这里保存常用出镜视频，制作作品时可以直接选用。</p>
        </div>
        <label className="vf-primary vf-library-upload">
          <input
            type="file"
            accept=".mp4,.mov,video/mp4,video/quicktime"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.currentTarget.value = "";
            }}
          />
          ＋ 上传数字人
        </label>
      </section>
      {state && <p className="vf-library-state">{state}</p>}
      {items.length ? (
        <div className="vf-asset-grid">
          {items.map((item) => (
            <article className="vf-asset-card" key={item.id}>
              <video
                src={item.url}
                muted
                playsInline
                controls
                preload="metadata"
              />
              <div>
                <b>{item.name}</b>
                <span>{(item.size / 1024 / 1024).toFixed(1)} MB</span>
                <button
                  title="删除素材"
                  onClick={async () => {
                    await api.deleteAvatarAsset(item.id);
                    await load();
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="vf-empty">
          <div className="vf-empty-mark">VF</div>
          <h3>还没有数字人素材</h3>
          <p>上传一段正面出镜的 MP4 或 MOV 视频。</p>
        </section>
      )}
    </main>
  );
}
