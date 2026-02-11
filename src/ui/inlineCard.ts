import * as vscode from 'vscode';
import type { TraceEvent } from '../trace/types';

/**
 * Manages inline line marker decorations during replay.
 * Shows a small marker on the highlighted line (e.g. ` [3]`).
 */
export class InlineCardController {
  private lineMarker: vscode.TextEditorDecorationType | null = null;
  private activeEditor: vscode.TextEditor | null = null;

  /**
   * Show step info for a highlighted range.
   */
  async showCard(
    event: TraceEvent,
    stepIndex: number,
    totalSteps: number,
    editor: vscode.TextEditor,
    line: number
  ): Promise<void> {
    this.clearLineMarker();

    // Create a small line marker decoration showing step number
    this.lineMarker = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: ` [${stepIndex + 1}]`,
        color: 'rgba(100, 149, 237, 0.7)',
        fontStyle: 'italic',
        margin: '0 0 0 1em',
      },
    });

    // Apply to the first line of the highlight (convert from 1-indexed to 0-indexed)
    const decorationLine = Math.max(0, line - 1);
    const lineLength = editor.document.lineAt(decorationLine).text.length;
    const range = new vscode.Range(
      new vscode.Position(decorationLine, lineLength),
      new vscode.Position(decorationLine, lineLength)
    );

    editor.setDecorations(this.lineMarker, [{ range }]);
    this.activeEditor = editor;
  }

  /**
   * Show a card at the top of a file (for openFile events).
   */
  async showFileCard(
    event: TraceEvent,
    stepIndex: number,
    totalSteps: number,
    editor: vscode.TextEditor
  ): Promise<void> {
    await this.showCard(event, stepIndex, totalSteps, editor, 1);
  }

  /**
   * Show notification for events without file context (say, sectionStart).
   */
  async showNotification(
    event: TraceEvent,
    stepIndex: number,
    totalSteps: number
  ): Promise<void> {
    this.clearLineMarker();
  }

  /**
   * Show section start notification.
   */
  async showSectionStart(sectionTitle: string): Promise<void> {
    this.clearLineMarker();
  }

  /**
   * Clear the line marker decoration.
   */
  clearLineMarker(): void {
    if (this.lineMarker && this.activeEditor) {
      this.activeEditor.setDecorations(this.lineMarker, []);
      this.lineMarker.dispose();
    }
    this.lineMarker = null;
    this.activeEditor = null;
  }

  /**
   * Hide all UI elements.
   */
  hide(): void {
    this.clearLineMarker();
  }

  dispose(): void {
    this.clearLineMarker();
  }
}
