import { existsSync, readFileSync } from "node:fs";
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
