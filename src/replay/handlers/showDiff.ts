import * as vscode from 'vscode';
import * as path from 'path';
import type { TraceEvent, DiffRef } from '../../trace/types';
import { diffRefSchema } from '../../trace/types';
import { resolveDiffRef } from '../../ui/gitContentProvider';
import type { EventHandler, HandlerContext } from './index';

export class ShowDiffHandler implements EventHandler {
  async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
    // START TTS IMMEDIATELY (non-blocking) - TTS-first pattern for natural feel
    // Skip TTS if _skipTts flag is set (e.g., on initial load)
    if (event.narration && !context._skipTts) {
      context.ttsPlayer.speakAsync(event.narration, event.id);
    }

    // If follow mode is off, show notification instead of inline card
    if (!context.followMode.isEnabled) {
      context.outputChannel.appendLine(
        `[showDiff] Follow mode off — showing notification for ${event.id}`
      );
      const stepIndex = context.engine.currentIndex;
      const totalSteps = context.engine.stepCount;
      await context.inlineCard.showNotification(event, stepIndex, totalSteps);
      return;
    }

    const diffRef = this.parseDiffRef(event);

    if (!diffRef) {
      // Fallback: if there's a filePath but no diffRef, just open the file
      if (event.filePath) {
        context.outputChannel.appendLine(
          `[showDiff] No diffRef in event ${event.id} — falling back to openFile`
        );
        const { OpenFileHandler } = await import('./openFile');
        const handler = new OpenFileHandler();
        await handler.execute(event, context);
        return;
      }

      context.outputChannel.appendLine(
        `[showDiff] No diffRef or filePath in event ${event.id} — skipped`
      );
      return;
    }

    try {
      const leftUri = resolveDiffRef(diffRef.left, context.workspaceRoot);
      const rightUri = resolveDiffRef(diffRef.right, context.workspaceRoot);
      const title = event.title || 'Diff';

      // Clear decorations — the diff editor has its own highlighting
      context.decorationManager.clearAll();

      await vscode.commands.executeCommand(
        'vscode.diff',
        leftUri,
        rightUri,
        title
      );

      // Show notification in status bar for diff views
      // (inline cards don't work well in diff editors)
      const stepIndex = context.engine.currentIndex;
      const totalSteps = context.engine.stepCount;
      await context.inlineCard.showNotification(event, stepIndex, totalSteps);

      context.outputChannel.appendLine(
        `[showDiff] ${diffRef.left} ↔ ${diffRef.right}`
      );
    } catch (err) {
      context.outputChannel.appendLine(
        `[showDiff] Failed to open diff for event ${event.id}: ${err}`
      );

      // Fallback: try opening the file directly
      if (event.filePath) {
        const { OpenFileHandler } = await import('./openFile');
        const handler = new OpenFileHandler();
        await handler.execute(event, context);
      }
    }
  }

  private parseDiffRef(event: TraceEvent): DiffRef | null {
    const raw = event.metadata?.diffRef;
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const result = diffRefSchema.safeParse(raw);
    return result.success ? result.data : null;
  }
}
