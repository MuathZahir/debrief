import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Provides content for `debrief-snapshot://` URIs by reading from the
 * snapshot directory associated with the current replay session.
 *
 * URI format: debrief-snapshot:/<filePath>
 * Example:    debrief-snapshot:/src/auth/handler.ts
 *
 * The snapshot root is set by ReplayEngine.load() and cleared by
 * ReplayEngine.clear(). Only one session is active at a time.
 */
export class SnapshotContentProvider
  implements vscode.TextDocumentContentProvider
{
  private _snapshotRoot: string | null = null;

  setSnapshotRoot(root: string | null): void {
    this._snapshotRoot = root;
  }

  get snapshotRoot(): string | null {
    return this._snapshotRoot;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (!this._snapshotRoot) {
      throw new Error(
        'No snapshot root set — is a replay session loaded?'
      );
    }

    const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    const fullPath = path.join(this._snapshotRoot, filePath);

    try {
      return await fs.promises.readFile(fullPath, 'utf-8');
    } catch {
      throw new Error(
        `Snapshot not found: ${filePath} (looked in ${this._snapshotRoot})`
      );
    }
  }

  /**
   * Check whether a snapshot exists for a given file path.
   */
  hasSnapshot(filePath: string): boolean {
    if (!this._snapshotRoot) {
      return false;
    }
    const normalized = filePath.replace(/\\/g, '/');
    const fullPath = path.join(this._snapshotRoot, normalized);
    return fs.existsSync(fullPath);
  }
}
