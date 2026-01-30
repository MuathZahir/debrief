import * as vscode from 'vscode';
import * as path from 'path';
import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';
import {
  parseLineReferences,
  parseLegacyLineReferences,
} from '../../util/lineRefParser';
import { buildHighlightTimeline } from '../../util/highlightTimeline';
import { HighlightScheduler } from '../../util/highlightScheduler';

export class OpenFileHandler implements EventHandler {
  private highlightScheduler: HighlightScheduler | null = null;

  async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
    // Clear any previous scheduled highlights
    if (this.highlightScheduler) {
      this.highlightScheduler.clear();
    }
    this.highlightScheduler = new HighlightScheduler(context.outputChannel);

    // Parse line references from narration
    // Support both new XML syntax <line:X>text</line:X> and legacy [line:X]
    let cleanNarration = event.narration || '';
    let legacyLineRefs: number[] = [];
    let timedLineRefs: ReturnType<typeof parseLineReferences>['lineReferences'] = [];

    if (event.narration) {
      // Check for new XML-style syntax
      if (/<line:\d+>/.test(event.narration)) {
        const parsed = parseLineReferences(event.narration);
        cleanNarration = parsed.cleanText;
        timedLineRefs = parsed.lineReferences;
        context.outputChannel.appendLine(
          `[openFile] Parsed ${timedLineRefs.length} timed line refs from XML syntax`
        );
      } else {
        // Fall back to legacy [line:X] syntax
        const parsed = parseLegacyLineReferences(event.narration);
        cleanNarration = parsed.cleanText;
        legacyLineRefs = parsed.lines;
      }
    }

    // Store refs for scheduling after file is opened
    const timedRefsForScheduling = timedLineRefs;
    const scheduler = this.highlightScheduler;

    // START TTS - use timed version if we have XML line refs
    // Skip TTS if _skipTts flag is set (e.g., on initial load)
    if (cleanNarration && !context._skipTts) {
      if (timedRefsForScheduling.length > 0) {
        // Use new timed highlight system
        context.ttsPlayer.speakAsyncWithTimings(cleanNarration, event.id, (result) => {
          const timeline = buildHighlightTimeline(result.wordTimings, timedRefsForScheduling);
          context.outputChannel.appendLine(
            `[openFile] Built timeline with ${timeline.length} events`
          );

          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && timeline.length > 0) {
            scheduler?.schedule(
              timeline,
              activeEditor,
              context.decorationManager
            );
          }
        });
      } else {
        // Use standard async TTS (no word timing needed)
        context.ttsPlayer.speakAsync(cleanNarration, event.id);
      }
    }

    // If follow mode is off, show notification instead of inline card
    if (!context.followMode.isEnabled) {
      context.outputChannel.appendLine(
        `[openFile] Follow mode off — showing notification for ${event.id}`
      );
      const stepIndex = context.engine.currentIndex;
      const totalSteps = context.engine.stepCount;
      await context.inlineCard.showNotification(event, stepIndex, totalSteps);
      return;
    }

    if (!event.filePath) {
      context.outputChannel.appendLine(
        `[openFile] No filePath in event ${event.id} — skipped`
      );
      return;
    }

    const fullPath = path.isAbsolute(event.filePath)
      ? event.filePath
      : path.join(context.workspaceRoot, event.filePath);

    const uri = vscode.Uri.file(fullPath);

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      context.outputChannel.appendLine(
        `[openFile] Failed to open ${event.filePath}: ${err}`
      );
      return;
    }

    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
    });

    // Clear previous decorations when opening a new file
    context.decorationManager.clearAll();

    // If a range is specified, reveal it
    if (event.range) {
      const revealRange = new vscode.Range(
        new vscode.Position(event.range.startLine - 1, 0),
        new vscode.Position(event.range.endLine - 1, 0)
      );
      editor.revealRange(revealRange, vscode.TextEditorRevealType.InCenter);
    }

    // Apply amber highlights for legacy [line:X] references (immediate, not timed)
    // Timed refs from <line:X>text</line:X> are handled by the scheduler above
    if (legacyLineRefs.length > 0) {
      context.decorationManager.applyLineReferences(editor, legacyLineRefs);
      context.outputChannel.appendLine(
        `[openFile] Applied legacy line references: ${legacyLineRefs.join(', ')}`
      );
    }

    // Show inline card at top of file
    const stepIndex = context.engine.currentIndex;
    const totalSteps = context.engine.stepCount;
    const reviewState = context.engine.getReviewState(event.id);

    await context.inlineCard.showFileCard(
      event,
      stepIndex,
      totalSteps,
      editor,
      reviewState
    );

    context.outputChannel.appendLine(
      `[openFile] ${event.filePath}`
    );
  }
}
