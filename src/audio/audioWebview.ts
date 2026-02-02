import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Manages a hidden webview panel for audio playback.
 * Uses HTML5 Audio for precise timing and cross-platform support.
 */
export class AudioWebview {
  private panel: vscode.WebviewPanel | null = null;
  private extensionUri: vscode.Uri;
  private outputChannel: vscode.OutputChannel;
  private isReady = false;
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;

  // Callbacks for current playback
  private onPlayingCallback: (() => void) | null = null;
  private onEndedCallback: (() => void) | null = null;
  private onErrorCallback: ((error: string) => void) | null = null;
  private onTimeUpdateCallback: ((currentTime: number) => void) | null = null;

  constructor(extensionUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
    this.extensionUri = extensionUri;
    this.outputChannel = outputChannel;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /**
   * Initialize the webview panel.
   */
  async initialize(): Promise<void> {
    if (this.panel) {
      return this.readyPromise;
    }

    this.outputChannel.appendLine('[AudioWebview] Initializing...');

    this.panel = vscode.window.createWebviewPanel(
      'debriefAudioPlayer',
      'Debrief Audio',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'webview'),
          vscode.Uri.file('/'), // Allow access to temp files
        ],
        retainContextWhenHidden: true,
      }
    );

    // Hide the panel (we only need it for audio)
    // Unfortunately VS Code doesn't have a true "hidden" panel,
    // but we can minimize its visual impact
    this.panel.webview.html = this.getHtml();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage((msg) => {
      this.handleMessage(msg);
    });

    // Handle panel disposal
    this.panel.onDidDispose(() => {
      this.outputChannel.appendLine('[AudioWebview] Panel disposed');
      this.panel = null;
      this.isReady = false;
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
    });

    return this.readyPromise;
  }

  /**
   * Play an audio file.
   * @param filePath Absolute path to the audio file
   * @param onPlaying Callback when audio actually starts playing
   * @param onEnded Callback when audio finishes
   * @param onError Callback on error
   * @param onTimeUpdate Optional callback for time updates
   */
  async play(
    filePath: string,
    onPlaying: () => void,
    onEnded: () => void,
    onError?: (error: string) => void,
    onTimeUpdate?: (currentTime: number) => void
  ): Promise<void> {
    await this.initialize();

    if (!this.panel) {
      onError?.('Panel not initialized');
      return;
    }

    // Store callbacks
    this.onPlayingCallback = onPlaying;
    this.onEndedCallback = onEnded;
    this.onErrorCallback = onError || null;
    this.onTimeUpdateCallback = onTimeUpdate || null;

    // Convert file path to webview URI
    const fileUri = vscode.Uri.file(filePath);
    const webviewUri = this.panel.webview.asWebviewUri(fileUri);

    this.outputChannel.appendLine(`[AudioWebview] Playing: ${filePath}`);
    this.outputChannel.appendLine(`[AudioWebview] Webview URI: ${webviewUri.toString()}`);

    // Send play command
    this.panel.webview.postMessage({
      command: 'play',
      src: webviewUri.toString(),
    });
  }

  /**
   * Stop current playback.
   */
  stop(): void {
    if (!this.panel) return;

    this.outputChannel.appendLine('[AudioWebview] Stopping playback');
    this.panel.webview.postMessage({ command: 'stop' });

    // Clear callbacks
    this.onPlayingCallback = null;
    this.onEndedCallback = null;
    this.onErrorCallback = null;
    this.onTimeUpdateCallback = null;
  }

  /**
   * Check if webview is ready.
   */
  get ready(): boolean {
    return this.isReady;
  }

  /**
   * Handle messages from the webview.
   */
  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'ready':
        this.outputChannel.appendLine('[AudioWebview] Webview ready');
        this.isReady = true;
        this.readyResolve?.();
        break;

      case 'playing':
        this.outputChannel.appendLine(`[AudioWebview] Playing at ${msg.currentTime}s`);
        this.onPlayingCallback?.();
        break;

      case 'timeupdate':
        this.onTimeUpdateCallback?.(msg.currentTime);
        break;

      case 'ended':
        this.outputChannel.appendLine('[AudioWebview] Playback ended');
        this.onEndedCallback?.();
        break;

      case 'error':
        this.outputChannel.appendLine(`[AudioWebview] Error: ${msg.message}`);
        this.onErrorCallback?.(msg.message);
        break;

      case 'stopped':
        this.outputChannel.appendLine('[AudioWebview] Stopped');
        break;

      case 'canplaythrough':
        this.outputChannel.appendLine(`[AudioWebview] Can play through, duration: ${msg.duration}s`);
        break;

      case 'pong':
        this.outputChannel.appendLine('[AudioWebview] Pong received');
        break;
    }
  }

  /**
   * Generate the webview HTML.
   */
  private getHtml(): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      'webview',
      'audioPlayer.html'
    );
    return fs.readFileSync(htmlPath, 'utf-8');
  }

  /**
   * Dispose the webview.
   */
  dispose(): void {
    this.stop();
    this.panel?.dispose();
    this.panel = null;
  }
}
