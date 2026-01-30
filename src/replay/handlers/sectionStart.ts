import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';

/**
 * sectionStart handler — marks the beginning of a logical group of steps.
 * Shows a section notification in status bar silently (no TTS for section names).
 *
 * Rationale: Speaking "Section: X" feels robotic and unnatural.
 * If there's actual narration content, use a 'say' event instead.
 */
export class SectionStartHandler implements EventHandler {
  async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
    context.outputChannel.appendLine(`[sectionStart] ${event.title}`);

    // Show section start in status bar silently - no TTS for section names
    // This creates a more natural flow without robotic announcements
    await context.inlineCard.showSectionStart(event.title);

    // Only speak if there's explicit narration content (not just the title)
    // Skip TTS if _skipTts flag is set (e.g., on initial load)
    if (event.narration && event.narration !== event.title && !context._skipTts) {
      context.ttsPlayer.speakAsync(event.narration, event.id);
    }
  }
}
