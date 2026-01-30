import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ReplayEngine } from '../replay/engine';
import type { FollowModeController } from '../replay/followMode';
import { detectRisks, type RiskFlag } from '../replay/riskDetector';

/**
 * WebviewViewProvider for the Debrief Replay timeline sidebar.
 *
 * Renders the step list, narration panel, and navigation/playback controls.
 * Communicates with the webview via postMessage.
 */
export class TimelineViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'debrief.timeline';

  private view: vscode.WebviewView | null = null;
  private engine: ReplayEngine;
  private followMode: FollowModeController;
  private extensionUri: vscode.Uri;

  constructor(
    extensionUri: vscode.Uri,
    engine: ReplayEngine,
    followMode: FollowModeController
  ) {
    this.extensionUri = extensionUri;
    this.engine = engine;
    this.followMode = followMode;

    // Listen to engine events and push updates to the webview
    engine.onStepChanged(() => this.updateWebview());
    engine.onSessionLoaded(() => this.updateWebview());
    engine.onSessionCleared(() => this.clearWebview());
    engine.onPlayStateChanged(() => this.updateWebview());
    engine.onEventsAppended(() => this.updateWebview());
    engine.onReviewChanged(() => this.updateWebview());
    followMode.onFollowModeChanged(() => this.updateWebview());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg.command) {
        case 'goToStep':
          this.engine.goToStep(msg.index);
          break;
        case 'next':
          this.engine.next();
          break;
        case 'previous':
          this.engine.previous();
          break;
        case 'togglePlayPause':
          this.engine.togglePlayPause();
          break;
        case 'setSpeed':
          this.engine.setSpeed(msg.speed);
          break;
        case 'toggleFollowMode':
          this.followMode.toggle();
          break;
        case 'approveStep':
          this.engine.approveStep(msg.eventId);
          break;
        case 'flagStep':
          this.engine.flagStep(msg.eventId, msg.comment);
          break;
        case 'clearReview':
          this.engine.clearReview(msg.eventId);
          break;
      }
    });

    // If a session is already loaded, push state immediately
    if (this.engine.isLoaded) {
      // Small delay to let the webview initialize
      setTimeout(() => this.updateWebview(), 100);
    }
  }

  /**
   * Push the current engine state to the webview.
   */
  private updateWebview(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({
      command: 'updateState',
      events: this.engine.allEvents.map((e) => ({
        id: e.id,
        type: e.type,
        title: e.title,
        narration: e.narration,
        filePath: e.filePath,
        risks: detectRisks(e),
        review: this.engine.getReviewState(e.id),
      })),
      currentIndex: this.engine.currentIndex,
      playState: this.engine.playState,
      speed: this.engine.speed,
      followEnabled: this.followMode.isEnabled,
      reviewSummary: this.engine.getReviewSummary(),
    });
  }

  /**
   * Tell the webview to clear its state.
   */
  private clearWebview(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.postMessage({ command: 'clearSession' });
  }

  /**
   * Build the webview HTML, injecting the correct asset URIs.
   */
  private getHtml(webview: vscode.Webview): string {
    const webviewDir = vscode.Uri.joinPath(this.extensionUri, 'webview');
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'timeline.css')
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(webviewDir, 'timeline.js')
    );

    // Read the HTML template and replace placeholders
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      'webview',
      'timeline.html'
    );
    let html = fs.readFileSync(htmlPath, 'utf-8');
    html = html.replace('{{cssUri}}', cssUri.toString());
    html = html.replace('{{jsUri}}', jsUri.toString());

    return html;
  }
}
