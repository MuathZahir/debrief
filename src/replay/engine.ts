import * as vscode from 'vscode';
import type {
  TraceEvent,
  ReplaySession,
  StepChangedEvent,
  PlayState,
  PlayStateChangedEvent,
  StepReviewState,
  ReviewChangedEvent,
  ReviewSummary,
  ReviewExportEntry,
} from '../trace/types';
import { getHandler } from './handlers/index';
import type { HandlerContext } from './handlers/index';

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
  private _speed: number = 1.0;
  private _advanceTimer: ReturnType<typeof setTimeout> | null = null;
  private _ttsCompletionDisposable: vscode.Disposable | null = null;
  private _waitingForTtsRequestId: number | null = null;

  // Review state
  private reviewStates: Map<string, StepReviewState> = new Map();

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

  private readonly _onReviewChanged =
    new vscode.EventEmitter<ReviewChangedEvent>();
  public readonly onReviewChanged = this._onReviewChanged.event;

  constructor(context: HandlerContext) {
    this.context = context;
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

  get speed(): number {
    return this._speed;
  }

  get isPlaying(): boolean {
    return this._playState === 'playing';
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  load(session: ReplaySession): void {
    this.clearAdvanceTimer();
    this._playState = 'stopped';
    this._speed = 1.0;
    this.reviewStates.clear();
    this.events = session.events;
    this.session = session;
    this._currentIndex = -1;
    this._onSessionLoaded.fire(session);
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

    this._onEventsAppended.fire({
      count: newEvents.length,
      total: this.events.length,
    });
  }

  clear(): void {
    this.clearAdvanceTimer();
    this.clearTtsCompletionListener();
    this._playState = 'stopped';
    this.reviewStates.clear();
    this.events = [];
    this.session = null;
    this._currentIndex = -1;
    this.context.decorationManager.clearAll();
    this._onSessionCleared.fire();
  }

  // ── Navigation ─────────────────────────────────────────────────────────

  async goToStep(index: number, options?: { skipTts?: boolean }): Promise<void> {
    if (index < 0 || index >= this.events.length) {
      return;
    }

    // Cancel any pending advance timer and TTS completion listener
    this.clearAdvanceTimer();
    this.clearTtsCompletionListener();

    this._currentIndex = index;
    const event = this.events[index];

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

  play(): void {
    if (!this.isLoaded || this.isAtEnd) {
      return;
    }
    this._playState = 'playing';
    this._onPlayStateChanged.fire({
      playState: 'playing',
      speed: this._speed,
    });
    // Start waiting for current step's TTS to complete
    const event = this.currentEvent;
    if (event) {
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
      speed: this._speed,
    });
  }

  togglePlayPause(): void {
    if (this._playState === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }

  setSpeed(speed: number): void {
    const allowed = [0.5, 1.0, 2.0];
    if (!allowed.includes(speed)) {
      return;
    }
    this._speed = speed;
    this._onPlayStateChanged.fire({
      playState: this._playState,
      speed,
    });
    // If currently playing, restart the timer with the new interval
    if (this._playState === 'playing') {
      this.clearAdvanceTimer();
      this.scheduleAdvance();
    }
  }

  // ── Private: auto-advance with TTS synchronization ───────────────────

  /**
   * Wait for TTS to complete, then schedule the next advance.
   * This ensures audio plays fully before moving to the next step.
   */
  private waitForTtsAndScheduleAdvance(event: TraceEvent): void {
    // If no narration or TTS skipped, just use a timer
    if (!event.narration) {
      this.scheduleAdvanceWithDelay(1500);
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
          const pauseAfterTts = cancelled ? 200 : 400;
          this.scheduleAdvanceWithDelay(pauseAfterTts / this._speed);
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

  // ── Review state management ───────────────────────────────────────────

  approveStep(eventId: string): void {
    const state: StepReviewState = { status: 'approved' };
    this.reviewStates.set(eventId, state);
    this._onReviewChanged.fire({ eventId, state });
  }

  flagStep(eventId: string, comment?: string): void {
    const state: StepReviewState = { status: 'flagged', comment };
    this.reviewStates.set(eventId, state);
    this._onReviewChanged.fire({ eventId, state });
  }

  clearReview(eventId: string): void {
    const state: StepReviewState = { status: 'unreviewed' };
    this.reviewStates.set(eventId, state);
    this._onReviewChanged.fire({ eventId, state });
  }

  getReviewState(eventId: string): StepReviewState {
    return this.reviewStates.get(eventId) ?? { status: 'unreviewed' };
  }

  getReviewSummary(): ReviewSummary {
    let approved = 0;
    let flagged = 0;
    let unreviewed = 0;

    for (const event of this.events) {
      const state = this.reviewStates.get(event.id);
      if (!state || state.status === 'unreviewed') {
        unreviewed++;
      } else if (state.status === 'approved') {
        approved++;
      } else if (state.status === 'flagged') {
        flagged++;
      }
    }

    return { approved, flagged, unreviewed };
  }

  exportReview(): ReviewExportEntry[] {
    const entries: ReviewExportEntry[] = [];
    for (const event of this.events) {
      const state = this.reviewStates.get(event.id);
      if (state && state.status !== 'unreviewed') {
        entries.push({
          eventId: event.id,
          status: state.status,
          comment: state.comment,
        });
      }
    }
    return entries;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  dispose(): void {
    this.clearAdvanceTimer();
    this.clearTtsCompletionListener();
    this.context.decorationManager.clearAll();
    this._onStepChanged.dispose();
    this._onSessionLoaded.dispose();
    this._onSessionCleared.dispose();
    this._onPlayStateChanged.dispose();
    this._onEventsAppended.dispose();
    this._onReviewChanged.dispose();
  }
}
