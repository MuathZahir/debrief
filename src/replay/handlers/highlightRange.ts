import * as vscode from 'vscode';
import * as path from 'path';
import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';
import { parseLegacyLineReferences } from '../../util/lineRefParser';

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

    const fullPath = path.isAbsolute(event.filePath)
      ? event.filePath
      : path.join(context.workspaceRoot, event.filePath);

    // Check if we're switching to a different file - show transition indicator
    const currentEditor = vscode.window.activeTextEditor;
    const currentFile = currentEditor?.document.uri.fsPath;
    const isSwitchingFiles = currentFile && currentFile !== fullPath;

    if (isSwitchingFiles) {
      // Show transition indicator in timeline panel
      context.engine.showFileTransition(path.basename(fullPath));

      // Wait 400ms before switching (longer to let user see the banner)
      await new Promise(resolve => setTimeout(resolve, 400));

      context.engine.hideFileTransition();
    }

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

    // Apply decorations with fade-in animation (decorationManager expects 1-indexed lines)
    await context.decorationManager.applyHighlightWithAnimation(editor, startLine, endLine);

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
