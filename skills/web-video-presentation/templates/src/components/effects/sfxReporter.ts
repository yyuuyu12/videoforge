/**
 * 效果件音效上报（P0-A 音效层，2026-07-22）。
 *
 * 只在成片渲染器把 `window.__vfSfx` 预置为数组时才记录——普通预览/手动
 * 模式没有这个数组，调用是一次属性读取后立即返回，零开销零副作用。
 * 时间用 Date.now：与渲染器拦截的音频 playing 事件同一时钟，混音端可以
 * 直接换算到视频时间轴（对齐机制与配音完全同构）。
 *
 * delayMs 对应效果件自身的入场延迟（如 Slam 150ms、Counter 250ms）：
 * 声音要踩在视觉真正动的那一拍，不是触发信号到达的那一拍。
 */
export function reportSfx(type: "whip" | "slam" | "counter", delayMs = 0) {
  if (typeof window === "undefined") return;
  const bucket = (window as unknown as { __vfSfx?: { type: string; at: number }[] }).__vfSfx;
  if (!Array.isArray(bucket)) return;
  bucket.push({ type, at: Date.now() + delayMs });
}
