export function formatReadableParagraphs(value, targetLength = 120) {
  const blocks = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const paragraphs = [];
  for (const block of blocks) {
    let buffer = "";
    for (const char of block) {
      buffer += char;
      const naturalBreak = /[。！？!?]/u.test(char) && buffer.length >= targetLength;
      const longClauseBreak = /[；;]/u.test(char) && buffer.length >= targetLength * 1.5;
      if (naturalBreak || longClauseBreak) {
        paragraphs.push(buffer.trim());
        buffer = "";
      }
    }
    if (buffer.trim()) paragraphs.push(buffer.trim());
  }
  return paragraphs.join("\n\n");
}

export function createSourceDocument({ title, content, source }) {
  const cleanTitle = String(title || "未命名作品").replace(/\s+/g, " ").trim();
  const body = formatReadableParagraphs(content);
  return `# ${cleanTitle}\n\n${body}\n\n---\n\n来源：${source || "手动提供"}\n`;
}
