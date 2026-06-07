/**
 * Strip a surrounding markdown code fence (```json … ```) from an LLM response,
 * if present. Models sometimes wrap JSON in fences despite being told not to.
 */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const codeBlockPattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = codeBlockPattern.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}
