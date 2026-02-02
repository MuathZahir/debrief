import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';
import { parseLegacyLineReferences } from '../../util/lineRefParser';

/**
 * Strip line reference markers from text for TTS.
 */
function stripLineReferences(text: string): string {
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
    // Only play TTS when in playing mode (not when manually clicking steps)
    if (event.narration && !context._skipTts && context.engine.isPlaying) {
      const cleanText = stripLineReferences(event.narration);
      context.ttsPlayer.speakAsync(cleanText, event.id);
    }

    // Show notification in status bar
    const stepIndex = context.engine.currentIndex;
    const totalSteps = context.engine.stepCount;
    await context.inlineCard.showNotification(event, stepIndex, totalSteps);
  }
}
