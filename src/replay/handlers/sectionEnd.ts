import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';

/**
 * sectionEnd handler — marks the end of a logical group of steps.
 * No editor action; the timeline UI uses this to close the group.
 */
export class SectionEndHandler implements EventHandler {
  async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
    context.outputChannel.appendLine(`[sectionEnd] ${event.title}`);
  }
}
