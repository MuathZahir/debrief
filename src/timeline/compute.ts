import type { Scene, SegmentTiming, TimelineFrame } from "../types.js";

/**
 * Compute the timeline of visual states based on scenes and audio timing
 */
export function computeTimeline(
  scenes: Scene[],
  segments: SegmentTiming[]
): TimelineFrame[] {
  const frames: TimelineFrame[] = [];

  for (const segment of segments) {
    const scene = scenes[segment.sceneIndex];

    // Create initial frame at segment start (no highlight)
    frames.push({
      time: segment.start,
      sceneIndex: segment.sceneIndex,
      activeHighlight: null,
    });

    if (!scene.highlights || scene.highlights.length === 0) {
      continue;
    }

    // Process each highlight
    for (const highlight of scene.highlights) {
      if (highlight.trigger_word) {
        // Find the word in the segment's word timings
        const wordTiming = findWordTiming(
          segment.wordTimings,
          highlight.trigger_word
        );

        if (wordTiming) {
          frames.push({
            time: wordTiming.start,
            sceneIndex: segment.sceneIndex,
            activeHighlight: highlight.lines,
          });
        } else {
          // Fallback: apply highlight at segment start
          frames.push({
            time: segment.start,
            sceneIndex: segment.sceneIndex,
            activeHighlight: highlight.lines,
          });
        }
      } else {
        // No trigger word = highlight for entire segment
        frames.push({
          time: segment.start,
          sceneIndex: segment.sceneIndex,
          activeHighlight: highlight.lines,
        });
      }
    }
  }

  // Sort frames by time
  frames.sort((a, b) => a.time - b.time);

  return frames;
}

/**
 * Find a word in the word timings (case-insensitive, partial match)
 */
function findWordTiming(
  wordTimings: { word: string; start: number; end: number }[],
  triggerWord: string
): { word: string; start: number; end: number } | undefined {
  const searchTerm = triggerWord.toLowerCase();

  // First, try exact match
  const exactMatch = wordTimings.find(
    (w) => w.word.toLowerCase() === searchTerm
  );
  if (exactMatch) {
    return exactMatch;
  }

  // Then, try partial match (word contains the trigger)
  const partialMatch = wordTimings.find((w) =>
    w.word.toLowerCase().includes(searchTerm)
  );
  if (partialMatch) {
    return partialMatch;
  }

  // Finally, try if trigger contains the word
  const reverseMatch = wordTimings.find((w) =>
    searchTerm.includes(w.word.toLowerCase())
  );
  if (reverseMatch) {
    return reverseMatch;
  }

  return undefined;
}

/**
 * Get the active state at a specific time
 */
export function getStateAtTime(
  timeline: TimelineFrame[],
  time: number
): TimelineFrame {
  // Find the last frame that started before or at the given time
  const applicableFrames = timeline.filter((f) => f.time <= time);

  if (applicableFrames.length === 0) {
    // Before any frame, return the first frame
    return timeline[0];
  }

  return applicableFrames[applicableFrames.length - 1];
}
