import * as vscode from 'vscode';
import * as path from 'path';
import type { TraceEvent } from '../../trace/types';
import type { EventHandler, HandlerContext } from './index';
import { parseLegacyLineReferences } from '../../util/lineRefParser';

export class OpenFileHandler implements EventHandler {
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
    // Skip TTS if _skipTts flag is set (e.g., on initial load)
    if (cleanNarration && !context._skipTts && context.engine.isPlaying) {
      context.ttsPlayer.speakAsync(cleanNarration, event.id);
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

    // Apply amber highlights for [line:X] references
    if (legacyLineRefs.length > 0) {
      context.decorationManager.applyLineReferences(editor, legacyLineRefs);
      context.outputChannel.appendLine(
        `[openFile] Applied legacy line references: ${legacyLineRefs.join(', ')}`
      );
    }

    // Show inline card at top of file
    const stepIndex = context.engine.currentIndex;
    const totalSteps = context.engine.stepCount;

    await context.inlineCard.showFileCard(
      event,
      stepIndex,
      totalSteps,
      editor
    );

    context.outputChannel.appendLine(
      `[openFile] ${event.filePath}`
    );
  }
}
