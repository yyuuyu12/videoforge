import { loadSettings, minimaxKey } from "./settings.js";
import { health as heygemHealth } from "./heygem.js";
import { frpcRunning } from "./servicesControl.js";

/**
 * 依赖服务预检（用户需求：作品开工时就发现"服务没启动"，
 * 而不是 20 分钟后在配音/数字人环节才撞墙）。
 *
 * 两种用法：
 * - servicesStatus()：全量状态，给设置页/工作台展示；
 * - preflightForJob(meta)：按作品实际需要（是否启用数字人）出预警清单，
 *   流水线开工时记 warning 事件，硬阻断仍留在各阶段自检（服务可能中途才启动）。
 */

async function pingHealth(baseUrl, timeoutMs = 4000) {
  const started = Date.now();
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: resp.ok, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err.message };
  }
}

export async function servicesStatus() {
  const settings = loadSettings();
  const [heygem, asr, frpc] = await Promise.all([
    heygemHealth(),
    pingHealth(settings.asr.baseUrl || "http://127.0.0.1:8765"),
    frpcRunning().catch(() => false),
  ]);
  return [
    {
      service: "llm",
      label: "生成引擎",
      ok: settings.llm.mode === "subscription" ? true : Boolean(settings.llm.apiKey),
      note: settings.llm.mode === "subscription"
        ? "订阅模式（Claude Agent SDK）"
        : settings.llm.apiKey ? `API 模式（${settings.llm.model}）` : "API 模式但未配置 key",
    },
    {
      service: "minimax",
      label: "配音（MiniMax TTS）",
      ok: Boolean(minimaxKey(settings)),
      note: minimaxKey(settings) ? "API key 已配置" : "未配置 API key（设置页或 MINIMAX_API_KEY 环境变量）",
    },
    {
      service: "heygem",
      label: "数字人（HeyGem）",
      ok: heygem.ok && heygem.ready,
      note: heygem.ok
        ? heygem.ready ? `服务就绪（${heygem.ms}ms）` : "服务在线但模型未就绪"
        : `无法连接（${heygem.error || "未知错误"}）——启动命令见 OPERATIONS.md`,
    },
    {
      service: "asr",
      label: "语音识别（Whisper，仅抖音提取用）",
      ok: asr.ok,
      note: asr.ok ? `服务就绪（${asr.ms}ms）` : "未启动（不影响文章类作品）",
    },
    {
      service: "frpc",
      label: "公网隧道（frpc，仅远程调用需要）",
      ok: frpc,
      note: frpc ? "隧道进程在跑" : "未启动（本机使用不受影响）",
    },
  ];
}

/** 按作品需要生成开工预警：返回 warning 文案数组（空 = 全部就绪）。 */
export async function preflightWarnings(meta = {}) {
  const status = await servicesStatus();
  const byService = Object.fromEntries(status.map((s) => [s.service, s]));
  const warnings = [];
  if (!byService.llm.ok) warnings.push(`生成引擎未配置：${byService.llm.note}`);
  if (!byService.minimax.ok) warnings.push(`配音服务未就绪（到「配音合成」环节会失败）：${byService.minimax.note}`);
  if (meta?.avatar?.enabled && !byService.heygem.ok) {
    warnings.push(`已启用数字人但 HeyGem 未就绪（到「数字人生成」环节前请启动）：${byService.heygem.note}`);
  }
  return warnings;
}
