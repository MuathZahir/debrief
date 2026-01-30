import * as vscode from 'vscode';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TraceDetectedEvent {
  traceUri: vscode.Uri;
  directoryUri: vscode.Uri;
}

// ── TraceFileWatcher ──────────────────────────────────────────────────────────

/**
 * Watches for `.debrief/replay/trace.jsonl` files across all workspace
 * folders. Fires `onTraceDetected` when a trace file is created or modified,
 * with a 500ms debounce to handle incremental agent writes.
 */
export class TraceFileWatcher {
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;

  /**
   * When true, the next `onTraceDetected` event will be suppressed.
   * Set this before programmatically writing a trace file (e.g. from the
   * HTTP server on session end) to prevent a duplicate notification.
   */
  public suppressNext = false;

  private readonly _onTraceDetected =
    new vscode.EventEmitter<TraceDetectedEvent>();
  public readonly onTraceDetected = this._onTraceDetected.event;

  start(): void {
    if (this.watcher) {
      return; // already watching
    }

    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/.debrief/replay/trace.jsonl'
    );

    this.watcher.onDidCreate((uri) => this.handleChange(uri));
    this.watcher.onDidChange((uri) => this.handleChange(uri));
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.dispose();
    this.watcher = null;
  }

  private handleChange(uri: vscode.Uri): void {
    // Debounce: agents may write the file incrementally
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;

      // Check suppress flag (set by HTTP server when it writes the file)
      if (this.suppressNext) {
        this.suppressNext = false;
        return;
      }

      const directoryUri = vscode.Uri.joinPath(uri, '..');
      this._onTraceDetected.fire({ traceUri: uri, directoryUri });
    }, this.DEBOUNCE_MS);
  }

  dispose(): void {
    this.stop();
    this._onTraceDetected.dispose();
  }
}
