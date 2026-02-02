import * as vscode from 'vscode';
import type { TtsPlayer } from './ttsPlayer';
import type { TraceEvent } from '../trace/types';
import { parseLegacyLineReferences } from '../util/lineRefParser';

/**
 * Progress event for TTS pre-generation.
 */
export interface PregenProgressEvent {
  current: number;
  total: number;
  status: 'generating' | 'complete' | 'error';
  failedEventIds: string[];
}

/**
 * Strips line reference markers from narration text for TTS.
 */
function stripLineReferences(text: string): string {
  return parseLegacyLineReferences(text).cleanText;
}

/**
 * Background TTS pre-generation queue.
 * Generates TTS audio for all trace events on load, with retry logic.
 */
export class TtsPreloader {
  private queue: TraceEvent[] = [];
  private processed: Set<string> = new Set();
  private isProcessing = false;
  private cancelToken = false;
  private outputChannel: vscode.OutputChannel;

  private readonly _onProgress = new vscode.EventEmitter<PregenProgressEvent>();
  public readonly onProgress = this._onProgress.event;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Check if a specific event has been pre-generated.
   */
  isReady(eventId: string): boolean {
    return this.processed.has(eventId);
  }

  /**
   * Check if pre-generation is currently running.
   */
  get generating(): boolean {
    return this.isProcessing;
  }

  /**
   * Pre-generate TTS for all events with narration.
   * Runs in background, emits progress events.
   */
  async pregenerate(events: TraceEvent[], ttsPlayer: TtsPlayer): Promise<void> {
    // Filter to events with non-empty narration
    const eventsWithNarration = events.filter(e => e.narration?.trim());

    // Only queue events not already processed
    this.queue = eventsWithNarration.filter(e => !this.processed.has(e.id));

    if (this.queue.length === 0) {
      this.outputChannel.appendLine('[TtsPreloader] All events already cached, skipping');
      this._onProgress.fire({
        current: eventsWithNarration.length,
        total: eventsWithNarration.length,
        status: 'complete',
        failedEventIds: [],
      });
      return;
    }

    this.cancelToken = false;
    this.isProcessing = true;

    const total = eventsWithNarration.length;
    let current = this.processed.size;
    const failed: string[] = [];

    this.outputChannel.appendLine(
      `[TtsPreloader] Starting pre-generation for ${this.queue.length} events`
    );

    for (const event of this.queue) {
      if (this.cancelToken) {
        this.outputChannel.appendLine('[TtsPreloader] Cancelled');
        break;
      }

      const cleanText = stripLineReferences(event.narration);
      if (!cleanText.trim()) {
        current++;
        this.processed.add(event.id);
        continue;
      }

      try {
        await this.withRetry(
          () => ttsPlayer.generateOnly(cleanText, event.id),
          3,
          1000
        );
        this.processed.add(event.id);
        this.outputChannel.appendLine(
          `[TtsPreloader] Generated: ${event.id} (${current + 1}/${total})`
        );
      } catch (err) {
        failed.push(event.id);
        this.outputChannel.appendLine(
          `[TtsPreloader] Failed after retries: ${event.id} - ${err}`
        );
      }

      current++;
      this._onProgress.fire({
        current,
        total,
        status: 'generating',
        failedEventIds: failed,
      });
    }

    this.isProcessing = false;
    this.outputChannel.appendLine(
      `[TtsPreloader] Complete. ${failed.length} failures.`
    );
    this._onProgress.fire({
      current,
      total,
      status: 'complete',
      failedEventIds: failed,
    });
  }

  /**
   * Cancel in-progress pre-generation.
   */
  cancel(): void {
    this.cancelToken = true;
  }

  /**
   * Clear processed cache (call on trace reload).
   */
  reset(): void {
    this.cancel();
    this.processed.clear();
    this.queue = [];
  }

  /**
   * Move an event to the front of the queue (for prioritization when user skips ahead).
   */
  prioritize(eventId: string): void {
    const idx = this.queue.findIndex(e => e.id === eventId);
    if (idx > 0) {
      const [event] = this.queue.splice(idx, 1);
      this.queue.unshift(event);
      this.outputChannel.appendLine(`[TtsPreloader] Prioritized: ${eventId}`);
    }
  }

  /**
   * Retry a function with exponential backoff.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 3,
    baseDelayMs: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        this.outputChannel.appendLine(
          `[TtsPreloader] Attempt ${attempt}/${maxAttempts} failed: ${err}`
        );

        if (attempt < maxAttempts) {
          // Exponential backoff with jitter
          const delay = baseDelayMs * Math.pow(2, attempt - 1) * (0.5 + Math.random());
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  dispose(): void {
    this.cancel();
    this._onProgress.dispose();
  }
}
