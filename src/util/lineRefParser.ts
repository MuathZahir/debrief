/**
 * Parse line references from narration text.
 *
 * Syntax: [line:X]
 * - X = 1-indexed line number
 * - Used for static line highlights (no word timing)
 */

/**
 * Parse [line:X] markers from narration text.
 * Returns clean text for TTS and extracted line numbers.
 *
 * @example
 * parseLegacyLineReferences("Look at [line:79] where the counter increments.")
 * // => {
 * //   cleanText: "Look at where the counter increments.",
 * //   lines: [79]
 * // }
 */
export function parseLegacyLineReferences(narration: string): {
  cleanText: string;
  lines: number[];
} {
  const pattern = /\[line:(\d+)\]/g;
  const lines: number[] = [];
  let match;

  while ((match = pattern.exec(narration)) !== null) {
    lines.push(parseInt(match[1], 10));
  }

  // Remove markers and normalize whitespace
  const cleanText = narration.replace(pattern, '').replace(/\s+/g, ' ').trim();
  return { cleanText, lines };
}
