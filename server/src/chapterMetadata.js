import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function parseRegistryChapterTitles(source) {
  const titles = new Map();
  for (const match of source.matchAll(/\{([^{}]+)\}/g)) {
    const body = match[1];
    const id = body.match(/\bid\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    const title = body.match(/\btitle\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (id && title) titles.set(id, title);
  }
  return titles;
}

export function readRegistryChapterTitles(presentationRoot) {
  const registry = join(presentationRoot, "src", "registry", "chapters.ts");
  if (!existsSync(registry)) return new Map();
  return parseRegistryChapterTitles(readFileSync(registry, "utf8"));
}

/**
 * Create the versioned cross-stage contract used by audio and avatar stages.
 * `audio-segments.json` remains as a legacy input for old workspaces, while
 * new workspaces get one stable chapter/segment order to consume.
 */
export function buildPresentationManifest(presentationRoot) {
  const segmentsPath = join(presentationRoot, "audio-segments.json");
  if (!existsSync(segmentsPath)) throw new Error("audio-segments.json 不存在，无法建立作品 manifest");
  const raw = JSON.parse(readFileSync(segmentsPath, "utf8"));
  if (!Array.isArray(raw) || raw.some((item) => !item || typeof item.audio !== "string")) {
    throw new Error("audio-segments.json 格式无效，无法建立作品 manifest");
  }

  const titles = readRegistryChapterTitles(presentationRoot);
  const chapterIds = [];
  for (const segment of raw) {
    const id = String(segment.chapter || "");
    if (id && !chapterIds.includes(id)) chapterIds.push(id);
  }
  const chapters = chapterIds.map((id, index) => ({
    id,
    index,
    title: titles.get(id) || id,
    segments: raw.filter((segment) => String(segment.chapter || "") === id),
  }));
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chapters,
    segments: raw,
  };
  writeFileSync(join(presentationRoot, "presentation-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
