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

export class HighlightRangeHandler implements EventHandler {
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
          `[highlightRange] Parsed ${timedLineRefs.length} timed line refs from XML syntax`
        );
      } else {
        // Fall back to legacy [line:X] syntax
        const parsed = parseLegacyLineReferences(event.narration);
        cleanNarration = parsed.cleanText;
        legacyLineRefs = parsed.lines;
      }
    }

    // Store timed refs for scheduling after file is opened
    const timedRefsForScheduling = timedLineRefs;
    const scheduler = this.highlightScheduler;

    // START TTS - use timed version if we have XML line refs
    // Skip TTS if _skipTts flag is set (e.g., on initial load)
    if (cleanNarration && !context._skipTts) {
      if (timedRefsForScheduling.length > 0) {
        // Use new timed highlight system
        // Note: We schedule highlights in the callback AFTER the editor is opened below
        context.ttsPlayer.speakAsyncWithTimings(cleanNarration, event.id, (result) => {
          // Build highlight timeline from word timings
          const timeline = buildHighlightTimeline(result.wordTimings, timedRefsForScheduling);
          context.outputChannel.appendLine(
            `[highlightRange] Built timeline with ${timeline.length} events`
          );

          // Schedule highlights to fire during playback
          // Use the currently active editor (which should be the file we opened)
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
        `[highlightRange] Follow mode off — showing notification for ${event.id}`
      );
      const stepIndex = context.engine.currentIndex;
      const totalSteps = context.engine.stepCount;
      await context.inlineCard.showNotification(event, stepIndex, totalSteps);
      return;
    }

    if (!event.filePath || !event.range) {
      context.outputChannel.appendLine(
        `[highlightRange] Missing filePath or range in event ${event.id} — skipped`
      );
      return;
    }

    const fullPath = path.isAbsolute(event.filePath)
      ? event.filePath
      : path.join(context.workspaceRoot, event.filePath);

    const uri = vscode.Uri.file(fullPath);

    // Ensure the file is open
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      context.outputChannel.appendLine(
        `[highlightRange] Failed to open ${event.filePath}: ${err}`
      );
      return;
    }

    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: false,
    });

    // Debug: log the raw range from event
    context.outputChannel.appendLine(
      `[highlightRange] Raw range: startLine=${event.range.startLine}, endLine=${event.range.endLine}, startCol=${event.range.startCol}, endCol=${event.range.endCol}`
    );

    // Clamp lines to document bounds (1-indexed in trace, need to stay 1-indexed for decorationManager)
    const maxLine = doc.lineCount;
    const startLine = Math.max(1, Math.min(event.range.startLine, maxLine));
    const endLine = Math.max(1, Math.min(event.range.endLine, maxLine));

    context.outputChannel.appendLine(
      `[highlightRange] Clamped range: startLine=${startLine}, endLine=${endLine}, maxLine=${maxLine}`
    );

    // Apply decorations (decorationManager expects 1-indexed lines)
    context.decorationManager.applyHighlight(editor, startLine, endLine);

    // Apply amber highlights for legacy [line:X] references (immediate, not timed)
    // Timed refs from <line:X>text</line:X> are handled by the scheduler above
    if (legacyLineRefs.length > 0) {
      context.decorationManager.applyLineReferences(editor, legacyLineRefs);
      context.outputChannel.appendLine(
        `[highlightRange] Applied legacy line references: ${legacyLineRefs.join(', ')}`
      );
    }

    // Scroll highlighted range into view (VS Code Range is 0-indexed)
    const highlightRange = new vscode.Range(
      new vscode.Position(startLine - 1, 0),
      new vscode.Position(endLine - 1, 0)
    );
    editor.revealRange(highlightRange, vscode.TextEditorRevealType.InCenter);

    context.outputChannel.appendLine(
      `[highlightRange] Revealed range: lines ${startLine}-${endLine} (0-indexed: ${startLine - 1}-${endLine - 1})`
    );

    // Show inline card above the highlighted range
    const stepIndex = context.engine.currentIndex;
    const totalSteps = context.engine.stepCount;
    const reviewState = context.engine.getReviewState(event.id);

    await context.inlineCard.showCard(
      event,
      stepIndex,
      totalSteps,
      editor,
      startLine,
      reviewState
    );

    context.outputChannel.appendLine(
      `[highlightRange] ${event.filePath}:${startLine}-${endLine}`
    );
  }
}
