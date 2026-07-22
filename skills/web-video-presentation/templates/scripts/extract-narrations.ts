/**
 * extract-narrations.ts — collect every chapter's narration array and emit
 * a flat segment list that the TTS pipeline can consume.
 *
 * Run via:
 *   npm run extract-narrations           # writes audio-segments.json
 *   npm run extract-narrations -- --print # also prints to stdout
 *
 * Reads chapter order from src/registry/chapters.ts via a simple regex
 * (no React/CSS evaluation needed). For each chapter it dynamically
 * imports `src/chapters/<NN>-<id>/narrations.ts` (which is React-free)
 * and flattens to:
 *
 *   [
 *     { chapter, step, text, audio: "<chapter>/<step>.mp3" },
 *     ...
 *   ]
 *
 * Step indices in the JSON are 1-indexed, matching the audio file naming
 * convention (`public/audio/<chapter>/<N>.mp3`).
 *
 * Empty narration strings are skipped (silent steps don't need a TTS file).
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const REGISTRY_PATH = resolve(ROOT, "src/registry/chapters.ts");
const CHAPTERS_DIR = resolve(ROOT, "src/chapters");
const OUT_PATH = resolve(ROOT, "audio-segments.json");

interface Segment {
  chapter: string;
  step: number;
  text: string;
  audio: string;
}

/**
 * Parse `src/registry/chapters.ts` to learn chapter id order, then match
 * each id to its folder by scanning the actual `src/chapters/` directory
 * on disk — not by parsing the shape of the import statement.
 *
 * Earlier versions matched folders via a regex over
 * `from "../chapters/<folder>/narrations"` import lines. That broke the
 * moment a generation wrote a combined import instead (e.g.
 * `import { Opening, narrations } from "../chapters/01-opening"`, which is
 * a perfectly valid ChapterDef — Component + narrations from one file) —
 * the regex found zero folders and every chapter failed to resolve
 * (job-26 real incident, 2026-07-17). Scanning disk removes the dependency
 * on any particular import shape entirely.
 *
 * Two id-discovery strategies (see below). The `id: "x"` literal path is
 * the original success path and is left untouched; the "字面量∩磁盘" fallback
 * exists because job-34 (2026-07-22) shipped a compact factory registry
 * (`const def=(id,title,narrations,Component)=>({id,title,narrations,Component})`
 * then `def("coldopen","流量奖励谁",...)`) that carries no `id:` literal at
 * all — the old code matched 0 ids, skipped the loop body, and silently
 * wrote 0 segments with exit 0, letting the pipeline pass an empty result.
 */
async function readChapterOrder(): Promise<{ id: string; narrationFile: string }[]> {
  const src = await readFile(REGISTRY_PATH, "utf8");

  const entries = await readdir(CHAPTERS_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  // 把"候选 id → 磁盘上的 narrations 文件"这层匹配抽出来给两种策略共用，
  // 兼容两种布局（2026-07-19 job-29 实翻车：模型用扁平文件）：
  //   ① 子目录：src/chapters/<folder>/narrations.ts（folder = id 或 *-id）
  //   ② 扁平文件：src/chapters/<name>.narrations.ts（name = id 或 *-id）
  // 命中返回文件路径，不命中返回 null（供 fallback 用来过滤非 id 的字面量）。
  const resolveNarration = (id: string): string | null => {
    const folder = dirs.find((f) => f === id) ?? dirs.find((f) => f.endsWith(`-${id}`));
    if (folder && existsSync(join(CHAPTERS_DIR, folder, "narrations.ts"))) {
      return join(CHAPTERS_DIR, folder, "narrations.ts");
    }
    const flat = files.find((f) => f === `${id}.narrations.ts`)
      ?? files.find((f) => f.endsWith(`-${id}.narrations.ts`));
    if (flat) {
      return join(CHAPTERS_DIR, flat);
    }
    return null;
  };

  // 策略①（既有成功路径，行为照旧）：从 `id: "x"` 对象字面量里直接读章节 id。
  // 命中任何 id 时，缺失 narrations 仍是硬错误——这条路径不放行残缺章节。
  const literalIds = [...src.matchAll(/id:\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  const result: { id: string; narrationFile: string }[] = [];
  for (const id of literalIds) {
    const narrationFile = resolveNarration(id);
    if (!narrationFile) {
      throw new Error(
        `chapter id "${id}" registered but no narrations found under src/chapters/ ` +
          `(looked for "${id}/narrations.ts" or "${id}.narrations.ts" or "*-${id}" variants).`,
      );
    }
    result.push({ id, narrationFile });
  }
  if (result.length > 0) return result;

  // 策略②「字面量∩磁盘」（2026-07-22 job-34 实翻车根因兜底）：紧凑工厂函数写法
  // 里没有任何 `id:` 字面量，策略① 匹配 0 个 id。此时把 registry 源码里所有字符串
  // 字面量（按首次出现顺序、去重）都当候选 id，只保留能在 src/chapters/ 磁盘上
  // 解析出 narrations 文件的那些——`def("coldopen",...)` 里的 "coldopen" 命中目录，
  // 而标题"流量奖励谁"/组件导入路径都解析不出文件被自然滤掉，章节顺序 = def() 调用顺序。
  const seen = new Set<string>();
  for (const m of src.matchAll(/["']([^"'\n]+)["']/g)) {
    const lit = m[1]!;
    if (seen.has(lit)) continue;
    seen.add(lit);
    const narrationFile = resolveNarration(lit);
    if (narrationFile) result.push({ id: lit, narrationFile });
  }
  if (result.length > 0) return result;

  // 两种策略都得到 0 章：registry 明明存在却解析不出任何章节 id——绝不静默写空
  // segments（job-34 就是栽在"0 章 exit 0 被静默放行"这一步，2026-07-22）。硬报错。
  throw new Error(
    `registry ${REGISTRY_PATH} 存在但解析不出任何章节 id，拒绝静默写出空 segments。` +
      `已尝试两种策略均得 0 章：` +
      `① 对象字面量 id:"x"（/id:\\s*["']…["']/g）匹配 0 个；` +
      `② 字面量∩磁盘（registry 内全部字符串字面量 ∩ src/chapters/ 下可解析出 narrations 的）匹配 0 个。` +
      `请检查 registry 是否真的引用了 src/chapters/ 下的章节。`,
  );
}

async function loadNarrations(narrationFile: string): Promise<unknown[]> {
  if (!existsSync(narrationFile)) {
    throw new Error(`missing narrations file: ${narrationFile}`);
  }
  const url = pathToFileURL(narrationFile).href;
  const mod = await import(url);
  // 兼容任意导出名（narrations / <id>Narrations / default）——扁平文件常用
  // 具名导出如 openingNarrations；取第一个数组导出。
  const arr = Array.isArray(mod.narrations)
    ? mod.narrations
    : Object.values(mod).find((v) => Array.isArray(v));
  if (!Array.isArray(arr)) {
    throw new Error(
      `narrations file ${narrationFile} must export an array (narrations 或任意具名数组)`,
    );
  }
  return arr as unknown[];
}

async function main() {
  const print = process.argv.includes("--print");
  const order = await readChapterOrder();

  const segments: Segment[] = [];
  let silentSteps = 0;
  for (const { id, narrationFile } of order) {
    const arr = await loadNarrations(narrationFile);
    arr.forEach((entry, i) => {
      const step = i + 1;
      if (typeof entry !== "string") {
        throw new Error(
          `chapter "${id}" step ${step}: narration must be a string ` +
            `(got ${typeof entry}). The {text, minHoldMs} form was removed; ` +
            `if your animation is longer than the narration, write longer ` +
            `narration, split the step, or speed the animation up.`,
        );
      }
      if (entry.trim() === "") {
        // Silent step — no TTS needed; runtime falls back to estimate.
        silentSteps++;
        return;
      }
      segments.push({
        chapter: id,
        step,
        text: entry,
        audio: `${id}/${step}.mp3`,
      });
    });
  }

  await writeFile(OUT_PATH, JSON.stringify(segments, null, 2) + "\n", "utf8");

  console.error(
    `✓ extracted ${segments.length} segments from ${order.length} chapters` +
      (silentSteps > 0 ? ` (skipped ${silentSteps} silent steps)` : ""),
  );
  console.error(`  → ${OUT_PATH}`);
  if (print) console.log(JSON.stringify(segments, null, 2));
}

main().catch((err) => {
  console.error(`✗ ${err.message ?? err}`);
  process.exit(1);
});
