import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';
import {
  parseLineReferences,
  parseLegacyLineReferences,
} from '../../util/lineRefParser';

/**
 * Strip line reference markers from text for TTS.
 * Supports both new XML syntax <line:X>text</line:X> (keeps inner text)
 * and legacy [line:X] syntax (removes markers entirely).
 */
function stripLineReferences(text: string): string {
  // Check for new XML-style syntax
  if (/<line:\d+>/.test(text)) {
    return parseLineReferences(text).cleanText;
  }
  // Fall back to legacy syntax
  return parseLegacyLineReferences(text).cleanText;
}

/**
 * Say handler — narration-only, no editor action.
 * Updates status bar and plays TTS audio.
 */
export class SayHandler implements EventHandler {
  async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
    context.outputChannel.appendLine(
      `[say] ${event.narration.slice(0, 80)}${event.narration.length > 80 ? '...' : ''}`
    );

    // START TTS IMMEDIATELY (non-blocking) - TTS-first pattern for natural feel
    // Strip [line:X] markers from TTS text
    // Skip TTS if _skipTts flag is set (e.g., on initial load)
    if (event.narration && !context._skipTts) {
      const cleanText = stripLineReferences(event.narration);
      context.ttsPlayer.speakAsync(cleanText, event.id);
    }

    // Show notification in status bar
    const stepIndex = context.engine.currentIndex;
    const totalSteps = context.engine.stepCount;
    await context.inlineCard.showNotification(event, stepIndex, totalSteps);
  }
}
