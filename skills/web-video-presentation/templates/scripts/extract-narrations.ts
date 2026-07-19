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
 */
async function readChapterOrder(): Promise<{ id: string; narrationFile: string }[]> {
  const src = await readFile(REGISTRY_PATH, "utf8");
  const ids = [...src.matchAll(/id:\s*["']([^"']+)["']/g)].map((m) => m[1]!);

  const entries = await readdir(CHAPTERS_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  // 兼容两种布局（2026-07-19 job-29 实翻车：模型用扁平文件）：
  //   ① 子目录：src/chapters/<folder>/narrations.ts（folder = id 或 *-id）
  //   ② 扁平文件：src/chapters/<name>.narrations.ts（name = id 或 *-id）
  const result: { id: string; narrationFile: string }[] = [];
  for (const id of ids) {
    const folder = dirs.find((f) => f === id) ?? dirs.find((f) => f.endsWith(`-${id}`));
    if (folder && existsSync(join(CHAPTERS_DIR, folder, "narrations.ts"))) {
      result.push({ id, narrationFile: join(CHAPTERS_DIR, folder, "narrations.ts") });
      continue;
    }
    const flat = files.find((f) => f === `${id}.narrations.ts`)
      ?? files.find((f) => f.endsWith(`-${id}.narrations.ts`));
    if (flat) {
      result.push({ id, narrationFile: join(CHAPTERS_DIR, flat) });
      continue;
    }
    throw new Error(
      `chapter id "${id}" registered but no narrations found under src/chapters/ ` +
        `(looked for "${id}/narrations.ts" or "${id}.narrations.ts" or "*-${id}" variants).`,
    );
  }
  return result;
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
