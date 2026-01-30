import * as vscode from 'vscode';

/**
 * Manages editor decoration types for highlights.
 * Ensures old decorations are cleared before new ones are applied.
 */
export class DecorationManager {
  private activeType: vscode.TextEditorDecorationType | null = null;
  private referenceType: vscode.TextEditorDecorationType | null = null;
  private activeEditor: vscode.TextEditor | null = null;

  /**
   * Apply a whole-line highlight to a range of lines in the given editor.
   * Clears any previous highlights first.
   */
  applyHighlight(
    editor: vscode.TextEditor,
    startLine: number,
    endLine: number
  ): void {
    this.clearAll();

    this.activeType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      // Subtle left-border gutter indicator (not distracting)
      borderLeft: '3px solid rgba(56, 139, 253, 0.6)',
      backgroundColor: 'rgba(56, 139, 253, 0.05)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      overviewRulerColor: 'rgba(56, 139, 253, 0.9)',
    });

    const ranges: vscode.Range[] = [];
    const doc = editor.document;
    for (let line = startLine; line <= endLine; line++) {
      const lineIndex = line - 1; // Convert from 1-indexed to 0-indexed
      if (lineIndex >= 0 && lineIndex < doc.lineCount) {
        const lineText = doc.lineAt(lineIndex);
        ranges.push(
          new vscode.Range(
            new vscode.Position(lineIndex, 0),
            new vscode.Position(lineIndex, lineText.text.length)
          )
        );
      }
    }

    if (ranges.length > 0) {
      editor.setDecorations(this.activeType, ranges);
      this.activeEditor = editor;
    }
  }

  /**
   * Apply amber highlights to specific referenced lines (from [line:X] markers).
   * These stand out from the main blue section highlight.
   */
  applyLineReferences(editor: vscode.TextEditor, lineNumbers: number[]): void {
    this.clearReferences();

    if (lineNumbers.length === 0) {
      return;
    }

    this.referenceType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      // Amber/orange for referenced lines - stands out from blue section
      borderLeft: '3px solid rgba(217, 119, 6, 0.9)',
      backgroundColor: 'rgba(217, 119, 6, 0.15)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      overviewRulerColor: 'rgba(217, 119, 6, 0.9)',
    });

    const ranges: vscode.Range[] = [];
    const doc = editor.document;

    for (const line of lineNumbers) {
      const lineIndex = line - 1; // Convert from 1-indexed to 0-indexed
      if (lineIndex >= 0 && lineIndex < doc.lineCount) {
        const lineText = doc.lineAt(lineIndex);
        ranges.push(
          new vscode.Range(
            new vscode.Position(lineIndex, 0),
            new vscode.Position(lineIndex, lineText.text.length)
          )
        );
      }
    }

    if (ranges.length > 0) {
      editor.setDecorations(this.referenceType, ranges);
    }
  }

  /**
   * Clear only the line reference decorations.
   */
  clearReferences(): void {
    if (this.referenceType && this.activeEditor) {
      this.activeEditor.setDecorations(this.referenceType, []);
      this.referenceType.dispose();
    }
    this.referenceType = null;
  }

  /**
   * Remove all active decorations (section + references).
   */
  clearAll(): void {
    // Clear section highlight
    if (this.activeType && this.activeEditor) {
      this.activeEditor.setDecorations(this.activeType, []);
      this.activeType.dispose();
    }
    this.activeType = null;

    // Clear line references
    this.clearReferences();

    this.activeEditor = null;
  }

  dispose(): void {
    this.clearAll();
  }
}
