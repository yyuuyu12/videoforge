/** TikHub's caption field can stop at exactly 1,000 characters on long videos. */
export function isLikelyTruncatedEmbeddedText(text, durationSeconds) {
  const chars = String(text || "").trim().length;
  return durationSeconds >= 180 && chars === 1000;
}
