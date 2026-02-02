import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ReplayEngine } from '../replay/engine';

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
  private extensionUri: vscode.Uri;

  constructor(
    extensionUri: vscode.Uri,
    engine: ReplayEngine
  ) {
    this.extensionUri = extensionUri;
    this.engine = engine;

    // Listen to engine events and push updates to the webview
    engine.onStepChanged(() => this.updateWebview());
    engine.onSessionLoaded(() => this.updateWebview());
    engine.onSessionCleared(() => this.clearWebview());
    engine.onPlayStateChanged(() => this.updateWebview());
    engine.onEventsAppended(() => this.updateWebview());

    // Forward file transition events to webview
    engine.onFileTransition((transition) => {
      if (this.view) {
        this.view.webview.postMessage({
          command: transition.show ? 'showTransition' : 'hideTransition',
          fileName: transition.fileName,
        });
      }
    });

    // Forward pre-generation progress events to webview
    engine.onPregenProgress((progress) => {
      if (this.view) {
        this.view.webview.postMessage({
          command: 'updatePregenProgress',
          current: progress.current,
          total: progress.total,
          status: progress.status,
        });
      }
    });
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
    webviewView.webview.onDidReceiveMessage(async (msg) => {
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
        case 'saveComment':
          await this.engine.saveComment(msg.eventId, msg.comment);
          break;
        case 'loadReplay':
          vscode.commands.executeCommand('debrief.loadReplay');
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
        comment: e.comment,
        risks: e.risks,  // Agent-specified risks (from trace file)
      })),
      currentIndex: this.engine.currentIndex,
      playState: this.engine.playState,
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
