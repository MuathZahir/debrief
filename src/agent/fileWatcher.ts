import * as vscode from 'vscode';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TraceDetectedEvent {
  traceUri: vscode.Uri;
  directoryUri: vscode.Uri;
}

// ── TraceFileWatcher ──────────────────────────────────────────────────────────

/**
 * Watches for `.jsonl` files in `.debrief/replay/` (and subdirectories)
 * across all workspace folders. Fires `onTraceDetected` when a trace file
 * is created or modified, with a 500ms per-file debounce to handle
 * incremental agent writes.
 */
export class TraceFileWatcher {
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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
      '**/.debrief/replay/**/*.jsonl'
    );

    this.watcher.onDidCreate((uri) => this.handleChange(uri));
    this.watcher.onDidChange((uri) => this.handleChange(uri));
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.watcher?.dispose();
    this.watcher = null;
  }

  private handleChange(uri: vscode.Uri): void {
    const key = uri.toString();

    // Debounce per file: agents may write the file incrementally
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);

      // Check suppress flag (set by HTTP server when it writes the file)
      if (this.suppressNext) {
        this.suppressNext = false;
        return;
      }

      const directoryUri = vscode.Uri.joinPath(uri, '..');
      this._onTraceDetected.fire({ traceUri: uri, directoryUri });
    }, this.DEBOUNCE_MS));
  }

  dispose(): void {
    this.stop();
    this._onTraceDetected.dispose();
  }
}
