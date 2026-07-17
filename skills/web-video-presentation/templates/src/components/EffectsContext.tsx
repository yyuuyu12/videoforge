import { createContext, useContext } from "react";

/**
 * 效果件共享上下文：章节组件内的效果件（WordMark 等）需要知道当前
 * 章节/步与音频时钟，但 ChapterStepProps 只有 step——通过 context 下发，
 * 章节代码无需透传任何新 prop。
 */
export interface EffectsContextValue {
  chapterId: string;
  step: number;
  getAudioEl(): HTMLAudioElement | null;
}

const EffectsContext = createContext<EffectsContextValue>({
  chapterId: "",
  step: 0,
  getAudioEl: () => null,
});

export const EffectsProvider = EffectsContext.Provider;

export function useEffects(): EffectsContextValue {
  return useContext(EffectsContext);
}
