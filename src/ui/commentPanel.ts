import * as vscode from 'vscode';
import type { TraceEvent } from '../trace/types';

const CONTROLLER_ID = 'debrief-replay';
const CONTROLLER_LABEL = 'Debrief Replay';

/**
 * A comment that appears in the floating panel next to code.
 */
class ReplayComment implements vscode.Comment {
  public id: string;
  public contextValue: string = '';
  public author: vscode.CommentAuthorInformation = {
    name: CONTROLLER_LABEL,
  };
  public body: vscode.MarkdownString;
  public mode = vscode.CommentMode.Preview;
  public label: string;

  constructor(content: string, label: string) {
    this.id = Date.now().toString();
    this.label = label;
    this.body = new vscode.MarkdownString(content);
    this.body.isTrusted = true;
  }
}

/**
 * Manages VS Code Comments API to show floating narration panels
 * next to highlighted code during replay.
 *
 * Follows the pattern used by Microsoft's CodeTour extension.
 */
export class CommentPanelController {
  private controller: vscode.CommentController | null = null;
  private currentThread: vscode.CommentThread | null = null;

  /**
   * Start the comment controller. Call when a replay session loads.
   */
  start(): void {
    if (this.controller) {
      this.controller.dispose();
    }
    this.controller = vscode.comments.createCommentController(
      CONTROLLER_ID,
      CONTROLLER_LABEL
    );
    // No commentingRangeProvider - we don't allow users to add comments
  }

  /**
   * Stop the comment controller. Call when a replay session ends.
   */
  stop(): void {
    this.disposeCurrentThread();
    if (this.controller) {
      this.controller.dispose();
      this.controller = null;
    }
  }

  /**
   * Dispose the current comment thread (if any).
   */
  private disposeCurrentThread(): void {
    if (this.currentThread) {
      this.currentThread.dispose();
      this.currentThread = null;
    }
  }

  /**
   * Show a comment panel for the current step, anchored to the given range.
   *
   * @param event - The trace event for this step
   * @param stepIndex - Current step index (0-based)
   * @param totalSteps - Total number of steps
   * @param uri - The file URI to attach the comment to
   * @param range - The range to anchor the comment (null for file-level)
   */
  async showStepComment(
    event: TraceEvent,
    stepIndex: number,
    totalSteps: number,
    uri: vscode.Uri,
    range: vscode.Range | null
  ): Promise<void> {
    if (!this.controller) {
      return;
    }

    this.disposeCurrentThread();

    // If no range provided, use line 0 for file-level comment
    const commentRange = range ?? new vscode.Range(0, 0, 0, 0);

    this.currentThread = this.controller.createCommentThread(
      uri,
      commentRange,
      []
    );

    // Build the comment content with narration and navigation
    let content = '';

    // Add step title as header
    if (event.title) {
      content += `**${event.title}**\n\n`;
    }

    // Add narration
    content += event.narration || '_No narration_';

    // Add navigation footer
    content += this.buildNavigationFooter(stepIndex, totalSteps);

    // Create the comment
    const label = `Step ${stepIndex + 1} of ${totalSteps}`;
    const comment = new ReplayComment(content, label);

    // Configure the thread
    this.currentThread.canReply = false;
    this.currentThread.comments = [comment];
    this.currentThread.collapsibleState =
      vscode.CommentThreadCollapsibleState.Expanded;
    this.currentThread.label = label;

    // Set thread contextValue for menu contribution conditions
    const contextParts: string[] = [];
    if (stepIndex > 0) contextParts.push('hasPrevious');
    if (stepIndex < totalSteps - 1) contextParts.push('hasNext');
    this.currentThread.contextValue = contextParts.join('.');
  }

  /**
   * Build the navigation footer with prev/next links.
   */
  private buildNavigationFooter(stepIndex: number, totalSteps: number): string {
    const hasPrev = stepIndex > 0;
    const hasNext = stepIndex < totalSteps - 1;

    if (!hasPrev && !hasNext) {
      return '';
    }

    let footer = '\n\n---\n';

    if (hasPrev) {
      footer += `[$(arrow-left) Previous](command:debrief.previousStep "Go to previous step")`;
    }

    if (hasPrev && hasNext) {
      footer += ' | ';
    }

    if (hasNext) {
      footer += `[Next $(arrow-right)](command:debrief.nextStep "Go to next step")`;
    }

    return footer;
  }

  /**
   * Show a notification for events without file context (e.g., say events).
   */
  async showCenteredNotification(event: TraceEvent): Promise<void> {
    // Truncate long narrations for the notification
    const maxLength = 200;
    const narration = event.narration || '';
    const truncated =
      narration.length > maxLength
        ? narration.slice(0, maxLength) + '...'
        : narration;

    const title = event.title ? `${event.title}: ` : '';

    await vscode.window.showInformationMessage(`${title}${truncated}`, {
      modal: false,
    });
  }

  /**
   * Show a section start notification.
   */
  async showSectionNotification(sectionTitle: string): Promise<void> {
    await vscode.window.showInformationMessage(`Section: ${sectionTitle}`, {
      modal: false,
    });
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.stop();
  }
}
