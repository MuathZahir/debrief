import * as vscode from 'vscode';
import type {
  TraceEvent,
  ReplaySession,
  StepChangedEvent,
  PlayState,
  PlayStateChangedEvent,
} from '../trace/types';
import { getHandler } from './handlers/index';
import type { HandlerContext } from './handlers/index';
import { TtsPreloader, type PregenProgressEvent } from '../audio/ttsPreloader';
import * as path from 'path';

/**
 * ReplayEngine is a state machine that tracks the current step in a replay
 * session and executes event handlers when navigating between steps.
 * Also manages auto-advance playback with speed control.
 */
export class ReplayEngine {
  private events: TraceEvent[] = [];
  private _currentIndex: number = -1;
  private context: HandlerContext;
  private session: ReplaySession | null = null;

  // Playback state
  private _playState: PlayState = 'stopped';
  private _advanceTimer: ReturnType<typeof setTimeout> | null = null;
  private _ttsCompletionDisposable: vscode.Disposable | null = null;
  private _waitingForTtsRequestId: number | null = null;

  // Section depth tracking for smooth transitions
  private _currentSectionDepth: number = 0;

  // Navigation epoch — incremented on each goToStep call to detect stale handlers
  private _navigationEpoch: number = 0;

  // TTS pre-generation
  private _ttsPreloader: TtsPreloader;

  // Events
  private readonly _onStepChanged = new vscode.EventEmitter<StepChangedEvent>();
  public readonly onStepChanged = this._onStepChanged.event;

  private readonly _onSessionLoaded = new vscode.EventEmitter<ReplaySession>();
  public readonly onSessionLoaded = this._onSessionLoaded.event;

  private readonly _onSessionCleared = new vscode.EventEmitter<void>();
  public readonly onSessionCleared = this._onSessionCleared.event;

  private readonly _onPlayStateChanged =
    new vscode.EventEmitter<PlayStateChangedEvent>();
  public readonly onPlayStateChanged = this._onPlayStateChanged.event;

  private readonly _onEventsAppended =
    new vscode.EventEmitter<{ count: number; total: number }>();
  public readonly onEventsAppended = this._onEventsAppended.event;

  private readonly _onPregenProgress =
    new vscode.EventEmitter<PregenProgressEvent>();
  public readonly onPregenProgress = this._onPregenProgress.event;

  private readonly _onFileTransition =
    new vscode.EventEmitter<{ fileName: string; show: boolean }>();
  public readonly onFileTransition = this._onFileTransition.event;

  constructor(context: HandlerContext) {
    this.context = context;
    this._ttsPreloader = new TtsPreloader(context.outputChannel);

    // Forward pre-generation progress events
    this._ttsPreloader.onProgress((progress) => {
      this._onPregenProgress.fire(progress);
    });
  }

  // ── Getters ────────────────────────────────────────────────────────────

  get currentIndex(): number {
    return this._currentIndex;
  }

  get currentEvent(): TraceEvent | null {
    if (this._currentIndex < 0 || this._currentIndex >= this.events.length) {
      return null;
    }
    return this.events[this._currentIndex];
  }

  get stepCount(): number {
    return this.events.length;
  }

  get isAtStart(): boolean {
    return this._currentIndex <= 0;
  }

  get isAtEnd(): boolean {
    return this._currentIndex >= this.events.length - 1;
  }

  get isLoaded(): boolean {
    return this.events.length > 0;
  }

  get allEvents(): readonly TraceEvent[] {
    return this.events;
  }

  get currentSession(): ReplaySession | null {
    return this.session;
  }

  get playState(): PlayState {
    return this._playState;
  }

  get isPlaying(): boolean {
    return this._playState === 'playing';
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  load(session: ReplaySession): void {
    this.clearAdvanceTimer();
    this._playState = 'stopped';
    this._currentSectionDepth = 0;
    this.events = session.events;
    this.session = session;
    this._currentIndex = -1;

    // Set snapshot root for this session
    if (session.tracePath) {
      const traceDir = path.dirname(session.tracePath);
      const snapshotsDir = session.metadata?.snapshotsDir ?? 'snapshots';
      const snapshotRoot = path.join(traceDir, snapshotsDir);
      this.context.snapshotContentProvider.setSnapshotRoot(snapshotRoot);
      this.context.outputChannel.appendLine(
        `[engine] Snapshot root: ${snapshotRoot}`
      );
    } else {
      this.context.snapshotContentProvider.setSnapshotRoot(null);
    }

    this._onSessionLoaded.fire(session);

    // Start pre-generating TTS for all events in background
    this._ttsPreloader.reset();
    this._ttsPreloader.pregenerate(session.events, this.context.ttsPlayer);
  }

  /**
   * Append events to the current session without resetting state.
   * Used during live sessions when new events stream in.
   */
  appendEvents(newEvents: TraceEvent[]): void {
    if (newEvents.length === 0) {
      return;
    }

    if (!this.session) {
      // Create a new session if none exists
      this.session = { events: [] };
      this.events = this.session.events;
      this._currentIndex = -1;
      this._onSessionLoaded.fire(this.session);
    }

    this.events.push(...newEvents);
    this.session.events = this.events;

    // Pre-generate TTS for new events
    this._ttsPreloader.pregenerate(newEvents, this.context.ttsPlayer);

    this._onEventsAppended.fire({
      count: newEvents.length,
      total: this.events.length,
    });
  }

  clear(): void {
    this.clearAdvanceTimer();
    this.clearTtsCompletionListener();
    this.context.ttsPlayer.setAllowedEventId(null);
    this._ttsPreloader.reset();
    this._playState = 'stopped';
    this._currentSectionDepth = 0;
    this.events = [];
    this.session = null;
    this._currentIndex = -1;
    this.context.decorationManager.clearAll();
    this.context.snapshotContentProvider.setSnapshotRoot(null);
    this._onSessionCleared.fire();
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  async goToStep(index: number, options?: { skipTts?: boolean }): Promise<void> {
    if (index < 0 || index >= this.events.length) {
      return;
    }

    // Increment navigation epoch so stale handler executions can be detected
    const epoch = ++this._navigationEpoch;

    // Cancel any pending advance timer and TTS completion listener
    this.clearAdvanceTimer();
    this.clearTtsCompletionListener();
    this.context.ttsPlayer.stop();

    this._currentIndex = index;
    const event = this.events[index];

    // Update section depth for transition timing
    if (event.type === 'sectionStart') {
      this._currentSectionDepth++;
    } else if (event.type === 'sectionEnd') {
      this._currentSectionDepth = Math.max(0, this._currentSectionDepth - 1);
    }

    // Prioritize this step in pre-generation if not ready
    if (!this._ttsPreloader.isReady(event.id) && event.narration?.trim()) {
      this._ttsPreloader.prioritize(event.id);
    }

    // Lock TTS to this event — stale handlers from a previous goToStep
    // will be blocked from calling speakAsync for the wrong event
    this.context.ttsPlayer.setAllowedEventId(event.id);

    // Execute the handler for this event type
    const handler = getHandler(event.type);
    if (handler) {
      // Set skipTts flag on context temporarily
      const originalSkipTts = this.context._skipTts;
      this.context._skipTts = options?.skipTts ?? false;

      try {
        await handler.execute(event, this.context);
      } catch (err) {
        this.context.outputChannel.appendLine(
          `[engine] Handler error for ${event.type} (${event.id}): ${err}`
        );
      } finally {
        // Restore original skipTts flag
        this.context._skipTts = originalSkipTts;
      }
    } else {
      this.context.outputChannel.appendLine(
        `[engine] No handler for event type: ${event.type}`
      );
    }

    // If another goToStep was called during handler execution, this
    // invocation is stale. The allowedEventId guard already prevented
    // stale handlers from starting audio, so just bail out.
    if (epoch !== this._navigationEpoch) {
      return;
    }

    // Notify UI
    this._onStepChanged.fire({
      index,
      event,
      total: this.events.length,
    });

    // If playing, wait for TTS to complete then schedule the next advance
    if (this._playState === 'playing') {
      this.waitForTtsAndScheduleAdvance(event);
    }
  }

  async next(): Promise<boolean> {
    if (this.isAtEnd) {
      return false;
    }
    await this.goToStep(this._currentIndex + 1);
    return true;
  }

  async previous(): Promise<boolean> {
    if (this.isAtStart) {
      return false;
    }
    await this.goToStep(this._currentIndex - 1);
    return true;
  }

  async reset(): Promise<void> {
    this.clearAdvanceTimer();
    this._playState = 'stopped';
    this.context.decorationManager.clearAll();
    this._currentIndex = -1;
    if (this.events.length > 0) {
      await this.goToStep(0);
    }
  }

  // ── Playback controls ─────────────────────────────────────────────────

  async play(): Promise<void> {
    if (!this.isLoaded || this.isAtEnd) {
      return;
    }

    this._playState = 'playing';
    this._onPlayStateChanged.fire({
      playState: 'playing',
    });

    // If no step selected yet, start from the beginning
    if (this._currentIndex < 0) {
      await this.goToStep(0);
      // goToStep will call waitForTtsAndScheduleAdvance since we're playing
      return;
    }

    // Already on a step - start TTS and schedule advance
    const event = this.currentEvent;
    if (event) {
      // Capture epoch to detect if user navigates during handler execution
      const epoch = this._navigationEpoch;

      // Lock TTS to this event
      this.context.ttsPlayer.setAllowedEventId(event.id);

      // Re-execute the handler to start TTS (it was likely already played when user manually clicked)
      const handler = getHandler(event.type);
      if (handler) {
        try {
          await handler.execute(event, this.context);
        } catch (err) {
          this.context.outputChannel.appendLine(
            `[engine] Handler error for ${event.type} (${event.id}): ${err}`
          );
        }
      }

      // If user navigated away during handler execution, don't schedule advance
      if (epoch !== this._navigationEpoch) {
        return;
      }

      this.waitForTtsAndScheduleAdvance(event);
    }
  }

  pause(): void {
    this._playState = 'paused';
    this.clearAdvanceTimer();
    this.clearTtsCompletionListener();
    this.context.ttsPlayer.stop();  // Stop TTS when pausing
    this._onPlayStateChanged.fire({
      playState: 'paused',
    });
  }

  togglePlayPause(): void {
    if (this._playState === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }

  // ── Private: auto-advance with TTS synchronization ───────────────────

  /**
   * Wait for TTS to complete, then schedule the next advance.
   * This ensures audio plays fully before moving to the next step.
   */
  private waitForTtsAndScheduleAdvance(event: TraceEvent): void {
    // If no narration or TTS skipped, just use a short timer
    if (!event.narration) {
      this.scheduleAdvanceWithDelay(500);
      return;
    }

    // Record the TTS request ID we're waiting for
    this._waitingForTtsRequestId = this.context.ttsPlayer.requestId;

    // Listen for TTS completion
    this._ttsCompletionDisposable = this.context.ttsPlayer.onPlaybackComplete(
      ({ requestId, cancelled }) => {
        // Only advance if this completion is for our request and we're still playing
        if (
          requestId === this._waitingForTtsRequestId &&
          this._playState === 'playing'
        ) {
          this.clearTtsCompletionListener();

          // Add a brief pause after TTS completes before advancing
          // Use shorter pause within sections for smooth flow
          const baseDelay = this._currentSectionDepth > 0 ? 100 : 75;
          const pauseAfterTts = cancelled ? 25 : baseDelay;
          this.scheduleAdvanceWithDelay(pauseAfterTts);
        }
      }
    );

    // Fallback: if TTS takes too long, advance anyway (safety net)
    const maxWait = 60000; // 60 seconds max
    this._advanceTimer = setTimeout(() => {
      if (this._playState === 'playing') {
        this.context.outputChannel.appendLine(
          `[engine] TTS timeout - advancing anyway`
        );
        this.clearTtsCompletionListener();
        this.doAdvance();
      }
    }, maxWait);
  }

  /**
   * Schedule advance after a fixed delay (used when no narration).
   */
  private scheduleAdvanceWithDelay(delayMs: number): void {
    this.clearAdvanceTimer();
    this._advanceTimer = setTimeout(() => {
      this.doAdvance();
    }, delayMs);
  }

  /**
   * Actually advance to the next step.
   */
  private async doAdvance(): Promise<void> {
    if (this._playState !== 'playing') {
      return;
    }

    const didAdvance = await this.next();
    if (!didAdvance) {
      // Reached the end
      this.pause();
    }
  }

  private clearAdvanceTimer(): void {
    if (this._advanceTimer !== null) {
      clearTimeout(this._advanceTimer);
      this._advanceTimer = null;
    }
  }

  private clearTtsCompletionListener(): void {
    if (this._ttsCompletionDisposable) {
      this._ttsCompletionDisposable.dispose();
      this._ttsCompletionDisposable = null;
    }
    this._waitingForTtsRequestId = null;
  }

  // ── File transition indicator ────────────────────────────────────────

  /**
   * Show the file transition indicator in the timeline panel.
   */
  showFileTransition(fileName: string): void {
    this._onFileTransition.fire({ fileName, show: true });
  }

  /**
   * Hide the file transition indicator.
   */
  hideFileTransition(): void {
    this._onFileTransition.fire({ fileName: '', show: false });
  }

  // ── Comment persistence ───────────────────────────────────────────────

  /**
   * Save a comment on a specific event and persist to trace file.
   */
  async saveComment(eventId: string, comment: string): Promise<void> {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) {
      return;
    }

    // Update or remove comment
    if (comment.trim()) {
      event.comment = comment.trim();
    } else {
      delete event.comment;
    }

    // Persist to trace file
    await this.persistTraceFile();

    // Notify UI
    this._onStepChanged.fire({
      index: this._currentIndex,
      event: this.currentEvent!,
      total: this.events.length,
    });
  }

  /**
   * Persist current events to the trace file.
   */
  private async persistTraceFile(): Promise<void> {
    if (!this.session?.tracePath) {
      vscode.window.showWarningMessage('Cannot save comment: no trace file path');
      return;
    }

    try {
      const uri = vscode.Uri.file(this.session.tracePath);

      // Check if file exists and is writable
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        vscode.window.showWarningMessage('Cannot save comment: trace file not found');
        return;
      }

      // Build JSONL content, preserving inline metadata header
      const lines: string[] = [];

      if (this.session.metadata) {
        const header: Record<string, unknown> = {};
        if (this.session.metadata.commitSha) header.commitSha = this.session.metadata.commitSha;
        if (this.session.metadata.sourceKind) header.sourceKind = this.session.metadata.sourceKind;
        if (this.session.metadata.snapshotsDir) header.snapshotsDir = this.session.metadata.snapshotsDir;
        if (Object.keys(header).length > 0) {
          lines.push(JSON.stringify(header));
        }
      }

      for (const event of this.events) {
        lines.push(JSON.stringify(event));
      }

      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(lines.join('\n') + '\n', 'utf-8')
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save comment: ${err}`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  dispose(): void {
    this.clearAdvanceTimer();
    this.clearTtsCompletionListener();
    this._ttsPreloader.dispose();
    this.context.decorationManager.clearAll();
    this._onStepChanged.dispose();
    this._onSessionLoaded.dispose();
    this._onSessionCleared.dispose();
    this._onPlayStateChanged.dispose();
    this._onEventsAppended.dispose();
    this._onPregenProgress.dispose();
    this._onFileTransition.dispose();
  }
}
