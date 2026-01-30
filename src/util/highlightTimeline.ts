/**
 * Build a timeline of highlight events from word timings and line references.
 * Used to schedule when line highlights should appear/disappear during TTS playback.
 */

import type { WordTiming } from '../audio/ttsPlayer';
import type { LineReference } from './lineRefParser';

export interface HighlightEvent {
  /** Time in seconds when this event should fire */
  time: number;
  /** Whether to start or end the highlight */
  type: 'start' | 'end';
  /** Line number to highlight/unhighlight (1-indexed) */
  line: number;
}

/**
 * Build a sorted timeline of highlight events from word timings and line references.
 *
 * For each line reference:
 * - Start event fires when the first word of trigger text begins
 * - End event fires when the last word of trigger text ends
 *
 * @param wordTimings Array of word timings from Whisper transcription
 * @param lineRefs Array of parsed line references from narration
 * @returns Sorted array of highlight events
 */
export function buildHighlightTimeline(
  wordTimings: WordTiming[],
  lineRefs: LineReference[]
): HighlightEvent[] {
  const events: HighlightEvent[] = [];

  if (!wordTimings.length || !lineRefs.length) {
    return events;
  }

  for (const ref of lineRefs) {
    // Find the word timing for the start word
    const startTiming = findWordTiming(wordTimings, ref.startWord, ref.wordIndex);

    // Find the word timing for the end word (must be after start)
    const afterTime = startTiming ? startTiming.start : 0;
    const endTiming = findWordTiming(
      wordTimings,
      ref.endWord,
      ref.wordIndex + ref.text.split(/\s+/).length - 1,
      afterTime
    );

    if (startTiming) {
      events.push({
        time: startTiming.start,
        type: 'start',
        line: ref.line,
      });
    }

    if (endTiming) {
      events.push({
        time: endTiming.end,
        type: 'end',
        line: ref.line,
      });
    }
  }

  // Sort by time, with 'end' events before 'start' events at the same time
  // This prevents flicker when one highlight ends and another starts simultaneously
  return events.sort((a, b) => {
    if (a.time !== b.time) {
      return a.time - b.time;
    }
    // At same time: end before start
    return a.type === 'end' ? -1 : 1;
  });
}

/**
 * Find a word timing that matches the given word.
 *
 * @param timings Array of word timings
 * @param word Word to find (will be normalized)
 * @param expectedIndex Expected word index (hint for matching)
 * @param afterTime Only consider timings that start at or after this time
 * @returns Matching word timing or undefined
 */
function findWordTiming(
  timings: WordTiming[],
  word: string,
  expectedIndex: number = 0,
  afterTime: number = 0
): WordTiming | undefined {
  const normalized = word.toLowerCase().replace(/[^\w]/g, '');

  if (!normalized) {
    return undefined;
  }

  // Filter timings by afterTime
  const candidates = timings.filter((t) => t.start >= afterTime);

  // First try: exact match at expected index
  if (expectedIndex >= 0 && expectedIndex < candidates.length) {
    const candidate = candidates[expectedIndex];
    const candidateWord = candidate.word.toLowerCase().replace(/[^\w]/g, '');
    if (candidateWord === normalized || candidateWord.includes(normalized)) {
      return candidate;
    }
  }

  // Second try: find first match anywhere in candidates
  return candidates.find((t) => {
    const tWord = t.word.toLowerCase().replace(/[^\w]/g, '');
    return tWord === normalized || tWord.includes(normalized);
  });
}
