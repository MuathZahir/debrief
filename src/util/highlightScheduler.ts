/**
 * Schedule highlight events during TTS playback.
 * Fires events to DecorationManager at the right times.
 */

import * as vscode from 'vscode';
import type { HighlightEvent } from './highlightTimeline';
import type { DecorationManager } from './decorations';

export class HighlightScheduler {
  private timers: NodeJS.Timeout[] = [];
  private activeLines: Set<number> = new Set();
  private outputChannel: vscode.OutputChannel | null = null;

  constructor(outputChannel?: vscode.OutputChannel) {
    this.outputChannel = outputChannel ?? null;
  }

  /**
   * Schedule highlight events to fire during playback.
   * Each event will add or remove a line from the active highlights.
   *
   * @param events Sorted array of highlight events
   * @param editor The text editor to apply decorations to
   * @param decorationManager Manager for applying decorations
   * @param onUpdate Optional callback when highlights change
   */
  schedule(
    events: HighlightEvent[],
    editor: vscode.TextEditor,
    decorationManager: DecorationManager,
    onUpdate?: (activeLines: number[]) => void
  ): void {
    this.clear();

    if (events.length === 0) {
      return;
    }

    this.log(`Scheduling ${events.length} highlight events`);

    for (const event of events) {
      const delayMs = Math.max(0, event.time * 1000);

      const timer = setTimeout(() => {
        if (event.type === 'start') {
          this.activeLines.add(event.line);
          this.log(`+line ${event.line} at ${event.time.toFixed(2)}s`);
        } else {
          this.activeLines.delete(event.line);
          this.log(`-line ${event.line} at ${event.time.toFixed(2)}s`);
        }

        // Apply updated highlights
        const lines = [...this.activeLines];
        decorationManager.applyLineReferences(editor, lines);

        if (onUpdate) {
          onUpdate(lines);
        }
      }, delayMs);

      this.timers.push(timer);
    }
  }

  /**
   * Clear all scheduled events and active highlights.
   */
  clear(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
    this.activeLines.clear();
  }

  /**
   * Get currently active highlight lines.
   */
  getActiveLines(): number[] {
    return [...this.activeLines];
  }

  /**
   * Check if any highlights are scheduled or active.
   */
  get isActive(): boolean {
    return this.timers.length > 0 || this.activeLines.size > 0;
  }

  private log(message: string): void {
    if (this.outputChannel) {
      this.outputChannel.appendLine(`[HighlightScheduler] ${message}`);
    }
  }

  dispose(): void {
    this.clear();
  }
}
