import * as vscode from 'vscode';
import * as path from 'path';
import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';
import { parseLegacyLineReferences } from '../../util/lineRefParser';
import { openResolvedSource } from '../sourceResolver';

export class HighlightRangeHandler implements EventHandler {
  async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
    // Parse legacy line references from narration for static highlights
    let cleanNarration = event.narration || '';
    let legacyLineRefs: number[] = [];

    if (event.narration) {
      const parsed = parseLegacyLineReferences(event.narration);
      cleanNarration = parsed.cleanText;
      legacyLineRefs = parsed.lines;
    }

    // START TTS - play audio while we navigate to the file
    // Only play TTS when in playing mode (not when manually clicking steps)
    if (cleanNarration && !context._skipTts && context.engine.isPlaying) {
      context.ttsPlayer.speakAsync(cleanNarration, event.id);
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

    // Check if we're switching to a different file - show transition indicator
    const currentEditor = vscode.window.activeTextEditor;
    const currentUri = currentEditor?.document.uri.toString();

    // Resolve the file from the best available source (snapshot, git, or workspace)
    const result = await openResolvedSource(event.filePath, {
      workspaceRoot: context.workspaceRoot,
      metadata: context.engine.currentSession?.metadata,
      snapshotProvider: context.snapshotContentProvider,
      outputChannel: context.outputChannel,
    });

    if (!result) {
      context.outputChannel.appendLine(
        `[highlightRange] Failed to open any source for ${event.filePath}`
      );
      return;
    }

    const { doc, source } = result;

    if (source.warning) {
      context.outputChannel.appendLine(
        `[highlightRange] ${source.warning}`
      );
    }

    // Show file transition if switching files
    const newUri = source.uri.toString();
    if (currentUri && currentUri !== newUri) {
      context.engine.showFileTransition(path.basename(event.filePath));
      await new Promise(resolve => setTimeout(resolve, 400));
      context.engine.hideFileTransition();
    }

    const editor = await vscode.window.showTextDocument(doc, {
      preview: source.kind !== 'workspace',
      preserveFocus: false,
    });

    // Debug: log the raw range from event
    context.outputChannel.appendLine(
      `[highlightRange] Raw range: startLine=${event.range.startLine}, endLine=${event.range.endLine} (source: ${source.kind})`
    );

    // Clamp lines to document bounds (1-indexed in trace, stay 1-indexed for decorationManager)
    // Line numbers are always correct when using snapshot or git authored source
    const maxLine = doc.lineCount;
    const startLine = Math.max(1, Math.min(event.range.startLine, maxLine));
    const endLine = Math.max(1, Math.min(event.range.endLine, maxLine));

    context.outputChannel.appendLine(
      `[highlightRange] Clamped range: startLine=${startLine}, endLine=${endLine}, maxLine=${maxLine}`
    );

    // Apply decorations with fade-in animation (decorationManager expects 1-indexed lines)
    await context.decorationManager.applyHighlightWithAnimation(editor, startLine, endLine);

    // Apply amber highlights for legacy [line:X] references (immediate, not timed)
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

    await context.inlineCard.showCard(
      event,
      stepIndex,
      totalSteps,
      editor,
      startLine
    );

    context.outputChannel.appendLine(
      `[highlightRange] ${event.filePath}:${startLine}-${endLine}`
    );
  }
}
