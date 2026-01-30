/**
 * Parse XML-style line references from narration text.
 *
 * Syntax: <line:X>spoken text</line:X>
 * - X = 1-indexed line number
 * - spoken text = what TTS says AND the trigger words
 * - Highlight starts when first word of spoken text begins
 * - Highlight ends when last word of spoken text ends
 */

export interface LineReference {
  /** Line number (1-indexed) */
  line: number;
  /** First word of trigger text (lowercase, for matching) */
  startWord: string;
  /** Last word of trigger text (lowercase, for matching) */
  endWord: string;
  /** Full trigger text */
  text: string;
  /** Word index in clean text where this reference starts */
  wordIndex: number;
}

export interface ParsedNarration {
  /** Text for TTS (markers removed, inner text kept) */
  cleanText: string;
  /** Extracted line references with trigger words */
  lineReferences: LineReference[];
}

/**
 * Parse <line:X>...</line:X> markers from narration text.
 * Returns clean text for TTS and extracted line references.
 *
 * @example
 * parseLineReferences("<line:79>This line</line:79> increments the counter.")
 * // => {
 * //   cleanText: "This line increments the counter.",
 * //   lineReferences: [{
 * //     line: 79,
 * //     startWord: "this",
 * //     endWord: "line",
 * //     text: "This line",
 * //     wordIndex: 0
 * //   }]
 * // }
 */
export function parseLineReferences(narration: string): ParsedNarration {
  const pattern = /<line:(\d+)>(.*?)<\/line:\1>/g;
  const refs: LineReference[] = [];

  // First pass: extract all references and their positions
  let match;
  const matches: Array<{
    fullMatch: string;
    line: number;
    text: string;
    index: number;
  }> = [];

  while ((match = pattern.exec(narration)) !== null) {
    matches.push({
      fullMatch: match[0],
      line: parseInt(match[1], 10),
      text: match[2].trim(),
      index: match.index,
    });
  }

  // Build clean text by replacing markers with inner text
  let cleanText = narration;
  for (const m of matches) {
    cleanText = cleanText.replace(m.fullMatch, m.text);
  }
  // Normalize whitespace
  cleanText = cleanText.replace(/\s+/g, ' ').trim();

  // Second pass: calculate word indices in clean text
  // We need to track where each reference's text appears in the final clean text
  const cleanWords = cleanText.toLowerCase().split(/\s+/);

  for (const m of matches) {
    const words = m.text.trim().split(/\s+/);
    if (words.length === 0 || !words[0]) {
      continue;
    }

    const startWord = words[0].toLowerCase().replace(/[^\w]/g, '');
    const endWord = words[words.length - 1].toLowerCase().replace(/[^\w]/g, '');

    // Find word index by searching for the start word
    // This is approximate but works for most cases
    let wordIndex = -1;
    for (let i = 0; i < cleanWords.length; i++) {
      const cleanWord = cleanWords[i].replace(/[^\w]/g, '');
      if (cleanWord === startWord) {
        // Check if following words also match (to avoid false positives)
        let matches = true;
        for (let j = 1; j < words.length && i + j < cleanWords.length; j++) {
          const refWord = words[j].toLowerCase().replace(/[^\w]/g, '');
          const checkWord = cleanWords[i + j].replace(/[^\w]/g, '');
          if (refWord !== checkWord) {
            matches = false;
            break;
          }
        }
        if (matches) {
          wordIndex = i;
          break;
        }
      }
    }

    refs.push({
      line: m.line,
      startWord,
      endWord,
      text: m.text,
      wordIndex,
    });
  }

  return { cleanText, lineReferences: refs };
}

/**
 * Legacy parser for [line:X] syntax (backward compatibility).
 * Returns clean text and simple line numbers (no word timing support).
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
