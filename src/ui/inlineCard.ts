import * as vscode from 'vscode';
import type { TraceEvent, StepReviewState } from '../trace/types';

/**
 * Manages inline narration display using status bar and subtle line indicators.
 * Shows step info in status bar (clickable) and a small marker on the highlighted line.
 */
export class InlineCardController {
  private lineMarker: vscode.TextEditorDecorationType | null = null;
  private activeEditor: vscode.TextEditor | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private narrationPanel: vscode.WebviewPanel | null = null;

  constructor() {
    // Main status bar item for step info
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'debrief.showNarration';
  }

  /**
   * Show step info for a highlighted range.
   * @param event The trace event
   * @param stepIndex Current step index (0-based)
   * @param totalSteps Total number of steps
   * @param editor The active editor
   * @param line The first line of the highlight (1-indexed)
   * @param reviewState Review state for styling
   */
  async showCard(
    event: TraceEvent,
    stepIndex: number,
    totalSteps: number,
    editor: vscode.TextEditor,
    line: number,
    reviewState: StepReviewState
  ): Promise<void> {
    this.clearLineMarker();

    const stepLabel = `Step ${stepIndex + 1}/${totalSteps}`;
    const title = event.title || 'Step';

    // Determine icon based on review state
    let stateIcon = '';
    let stateText = '';
    if (reviewState.status === 'approved') {
      stateIcon = '$(check) ';
      stateText = ' [Approved]';
    } else if (reviewState.status === 'flagged') {
      stateIcon = '$(warning) ';
      stateText = ' [Flagged]';
    }

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

    // Update status bar with full info
    this.statusBarItem.text = `${stateIcon}$(comment) ${stepLabel}: ${title}${stateText}`;

    // Show full narration in tooltip (multiline supported)
    const narration = event.narration || 'No narration';
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `### ${title}\n\n${narration}\n\n---\n*Click to show full narration panel*`
    );
    this.statusBarItem.show();

    // Store current narration for the show command
    this.currentNarration = { title, narration, stepLabel };
  }

  private currentNarration: { title: string; narration: string; stepLabel: string } | null = null;

  /**
   * Show the full narration in a panel (called when status bar is clicked).
   */
  showNarrationPanel(): void {
    if (!this.currentNarration) {
      return;
    }

    const { title, narration, stepLabel } = this.currentNarration;

    // Use information message for now (simple but effective)
    vscode.window.showInformationMessage(
      `${stepLabel}: ${title}\n\n${narration}`,
      { modal: false }
    );
  }

  /**
   * Show a card at the top of a file (for openFile events).
   */
  async showFileCard(
    event: TraceEvent,
    stepIndex: number,
    totalSteps: number,
    editor: vscode.TextEditor,
    reviewState: StepReviewState
  ): Promise<void> {
    // For file-level events, show at line 1
    await this.showCard(event, stepIndex, totalSteps, editor, 1, reviewState);
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

    const stepLabel = `Step ${stepIndex + 1}/${totalSteps}`;
    const title = event.title || 'Narration';
    const narration = event.narration || '';

    // Update status bar
    this.statusBarItem.text = `$(megaphone) ${stepLabel}: ${title}`;
    this.statusBarItem.tooltip = new vscode.MarkdownString(
      `### ${title}\n\n${narration}`
    );
    this.statusBarItem.show();

    this.currentNarration = { title, narration, stepLabel };
  }

  /**
   * Show section start notification.
   */
  async showSectionStart(sectionTitle: string): Promise<void> {
    this.clearLineMarker();

    this.statusBarItem.text = `$(folder-opened) Section: ${sectionTitle}`;
    this.statusBarItem.tooltip = `Starting section: ${sectionTitle}`;
    this.statusBarItem.show();

    this.currentNarration = {
      title: sectionTitle,
      narration: `Starting section: ${sectionTitle}`,
      stepLabel: 'Section'
    };
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
    this.statusBarItem.hide();
    this.currentNarration = null;
  }

  dispose(): void {
    this.clearLineMarker();
    this.statusBarItem.dispose();
    if (this.narrationPanel) {
      this.narrationPanel.dispose();
    }
  }
}
