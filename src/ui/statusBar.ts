import * as vscode from 'vscode';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StatusBarState = 'idle' | 'live' | 'replay';

export interface ReplayStatusInfo {
  step: number;
  total: number;
  speed: number;
}

export interface LiveStatusInfo {
  filePath?: string;
  title?: string;
}

// ── StatusBarController ───────────────────────────────────────────────────────

/**
 * Manages two status bar items:
 * - Primary (left-aligned): session state — live spinner, replay step count, or idle
 * - Follow mode (right-aligned): follow mode toggle — "Following" / "Free"
 */
export class StatusBarController {
  private primaryItem: vscode.StatusBarItem;
  private followItem: vscode.StatusBarItem;
  private state: StatusBarState = 'idle';

  constructor() {
    this.primaryItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.primaryItem.command = 'debrief.timeline.focus';
    this.primaryItem.name = 'Debrief Status';

    this.followItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.followItem.command = 'debrief.toggleFollowMode';
    this.followItem.name = 'Debrief Follow Mode';
  }

  // ── Primary item ──────────────────────────────────────────────────────────

  showLiveStatus(info: LiveStatusInfo): void {
    this.state = 'live';
    const label = info.filePath ?? info.title ?? 'Working...';
    this.primaryItem.text = `$(sync~spin) Debrief: ${label}`;
    this.primaryItem.tooltip = info.title
      ? `Live session: ${info.title}`
      : 'Live session in progress';
    this.primaryItem.show();
  }

  showReplayStatus(info: ReplayStatusInfo): void {
    this.state = 'replay';
    this.primaryItem.text = `$(play) Debrief: Step ${info.step}/${info.total} · ${info.speed}x`;
    this.primaryItem.tooltip = `Replay in progress — ${info.speed}x speed`;
    this.primaryItem.show();
  }

  showIdle(): void {
    this.state = 'idle';
    this.primaryItem.text = '$(check) Debrief';
    this.primaryItem.tooltip = 'Debrief — no active session';
    this.primaryItem.show();
  }

  hidePrimary(): void {
    this.primaryItem.hide();
  }

  // ── Follow mode item ─────────────────────────────────────────────────────

  updateFollowMode(enabled: boolean): void {
    this.followItem.text = enabled ? '$(eye) Following' : '$(eye-closed) Free';
    this.followItem.tooltip = enabled
      ? 'Click to pause follow mode'
      : 'Click to resume follow mode';
    this.followItem.show();
  }

  hideFollowItem(): void {
    this.followItem.hide();
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get currentState(): StatusBarState {
    return this.state;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose(): void {
    this.primaryItem.dispose();
    this.followItem.dispose();
  }
}
