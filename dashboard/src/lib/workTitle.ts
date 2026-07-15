export type WorkTitleParts = {
  main: string;
  tags: string[];
  original: string;
};

export function splitWorkTitle(value: string | null | undefined): WorkTitleParts {
  const original = String(value || "未命名作品").trim() || "未命名作品";
  const tags: string[] = [];
  const main = original
    .replace(/#{1,2}[^\s#@]+|@[^\s#@]+/gu, (token) => {
      const label = token.startsWith("#") ? token.replace(/^##+/, "#") : token;
      if (!tags.includes(label)) tags.push(label);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { main: main || original, tags, original };
}
