import * as vscode from 'vscode';
import type { FollowModeChangedEvent } from '../trace/types';

/**
 * Controls whether event handlers drive the editor.
 * When disabled, handlers skip editor actions (no file opening, decoration,
 * scroll) but narration still updates in the sidebar.
 */
export class FollowModeController {
  private _enabled: boolean = true;

  private readonly _onFollowModeChanged =
    new vscode.EventEmitter<FollowModeChangedEvent>();
  public readonly onFollowModeChanged = this._onFollowModeChanged.event;

  get isEnabled(): boolean {
    return this._enabled;
  }

  toggle(): void {
    this._enabled = !this._enabled;
    this._onFollowModeChanged.fire({ enabled: this._enabled });
  }

  setEnabled(enabled: boolean): void {
    if (this._enabled !== enabled) {
      this._enabled = enabled;
      this._onFollowModeChanged.fire({ enabled: this._enabled });
    }
  }

  dispose(): void {
    this._onFollowModeChanged.dispose();
  }
}
