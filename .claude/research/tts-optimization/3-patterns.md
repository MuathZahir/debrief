# Pattern Analysis: TTS Optimization

## Current Implementation

### TTS Flow
**File:** `src/audio/ttsPlayer.ts`
**Current pattern:**
```typescript
// Two API calls per step:
// 1. OpenAI TTS API (speech generation)
// 2. Whisper API (word-level timings for synchronized highlights)

async speakWithTimings(text, eventId, requestId, onTimingsReady) {
  // Check cache for audio file
  let audioFilePath = this.audioCache.get(cacheKey);

  // Generate TTS if not cached
  if (!audioFilePath) {
    audioFilePath = await this.generateTts(text, cacheKey);  // ~1-2s
    this.audioCache.set(cacheKey, audioFilePath);
  }

  // Get word timings via Whisper if not cached
  let wordTimings = this.timingsCache.get(cacheKey);
  if (!wordTimings) {
    wordTimings = await this.transcribeForTimings(audioFilePath);  // ~2-4s
    this.timingsCache.set(cacheKey, wordTimings);
  }

  // Play with callback for synchronized highlights
  await this.playAudioFileWithCallback(audioFilePath, () => {
    onTimingsReady({ requestId, wordTimings, duration });
  });
}
```

**Key insight:** The Whisper call exists solely to enable `<line:X>` mid-narration highlight changes. Removing this feature eliminates the need for Whisper entirely.

### Caching Pattern
**File:** `src/audio/ttsPlayer.ts`
**Pattern:**
```typescript
// In-memory Maps for session-level caching
private audioCache: Map<string, string> = new Map();    // cacheKey -> tempFilePath
private timingsCache: Map<string, WordTiming[]> = new Map();  // DELETE this

// Cache key generation (content-based hash)
private getCacheKey(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `tts_${Math.abs(hash)}`;
}

// Temp directory for audio files
this.tempDir = path.join(os.tmpdir(), 'debrief-tts');

// File path: {tempDir}/{cacheKey}.mp3
const filePath = path.join(this.tempDir, `${cacheKey}.mp3`);
```

**For pre-generation:** Can reuse this caching pattern. Add a `pregenerate(texts[])` method that populates `audioCache` for all steps upfront.

### Audio Playback Pattern
**File:** `src/audio/audioWebview.ts`
**Pattern:**
```typescript
// Webview-based HTML5 audio player
// Provides precise timing events via postMessage

play(filePath, onPlaying, onEnded, onError, onTimeUpdate) {
  // Convert file path to webview URI
  const webviewUri = this.panel.webview.asWebviewUri(fileUri);

  // Send play command to webview
  this.panel.webview.postMessage({
    command: 'play',
    src: webviewUri.toString(),
  });
}

// Message handling for playback events
handleMessage(msg) {
  case 'playing':   this.onPlayingCallback?.();
  case 'ended':     this.onEndedCallback?.();
  case 'timeupdate': this.onTimeUpdateCallback?.(msg.currentTime);
  case 'error':     this.onErrorCallback?.(msg.message);
}
```

**Key insight:** The webview audio player already supports all needed callbacks. No changes needed for pre-generation.

## Reference Implementations

### 1. EventEmitter Pattern for Progress Events
**File:** `src/replay/engine.ts`
**Relevant because:** Need to emit pre-generation progress events to timeline UI
**Key pattern:**
```typescript
// Private emitter, public event accessor
private readonly _onStepChanged = new vscode.EventEmitter<StepChangedEvent>();
public readonly onStepChanged = this._onStepChanged.event;

private readonly _onEventsAppended = new vscode.EventEmitter<{ count: number; total: number }>();
public readonly onEventsAppended = this._onEventsAppended.event;

// Fire events
this._onStepChanged.fire({ index, event, total: this.events.length });
this._onEventsAppended.fire({ count: newEvents.length, total: this.events.length });

// Subscribe in other components
engine.onStepChanged(() => this.updateWebview());
```

**For pre-generation:** Add `_onPregenProgress` emitter with interface:
```typescript
interface PregenProgressEvent {
  current: number;   // Steps completed
  total: number;     // Total steps to generate
  failed: string[];  // Event IDs that failed
}
```

### 2. TTS Completion Listener Pattern
**File:** `src/replay/engine.ts`
**Relevant because:** Shows how to wait for TTS and handle cancellation
**Key pattern:**
```typescript
private _ttsCompletionDisposable: vscode.Disposable | null = null;
private _waitingForTtsRequestId: number | null = null;

private waitForTtsAndScheduleAdvance(event: TraceEvent): void {
  // Record which TTS we're waiting for
  this._waitingForTtsRequestId = this.context.ttsPlayer.requestId;

  // Listen for completion
  this._ttsCompletionDisposable = this.context.ttsPlayer.onPlaybackComplete(
    ({ requestId, cancelled }) => {
      if (requestId === this._waitingForTtsRequestId && this._playState === 'playing') {
        this.clearTtsCompletionListener();
        const pauseAfterTts = cancelled ? 25 : 75;  // <-- MODIFY: 100ms in sections
        this.scheduleAdvanceWithDelay(pauseAfterTts);
      }
    }
  );

  // Fallback timeout (60s max)
  this._advanceTimer = setTimeout(() => { /* advance anyway */ }, 60000);
}

private clearTtsCompletionListener(): void {
  this._ttsCompletionDisposable?.dispose();
  this._ttsCompletionDisposable = null;
  this._waitingForTtsRequestId = null;
}
```

### 3. Webview Message Communication Pattern
**File:** `src/ui/timelineView.ts` + `webview/timeline.js`
**Relevant because:** Need to add progress indicator to timeline sidebar
**Key pattern:**
```typescript
// Extension -> Webview (TypeScript)
this.view.webview.postMessage({
  command: 'updateState',
  events: this.engine.allEvents.map(e => ({ ... })),
  currentIndex: this.engine.currentIndex,
  playState: this.engine.playState,
  reviewSummary: this.engine.getReviewSummary(),
});

// Webview -> Extension (JavaScript)
vscode.postMessage({ command: 'goToStep', index: index });
vscode.postMessage({ command: 'togglePlayPause' });

// Message handler in webview
window.addEventListener('message', function (event) {
  var msg = event.data;
  switch (msg.command) {
    case 'updateState':
      events = msg.events;
      currentIndex = msg.currentIndex;
      // ... update UI
      break;
  }
});
```

**For progress indicator:** Add new message type:
```typescript
// Extension -> Webview
{ command: 'updatePregenProgress', current: 5, total: 20, status: 'generating' }
{ command: 'updatePregenProgress', current: 20, total: 20, status: 'complete' }
```

### 4. Session Load Pattern
**File:** `src/replay/engine.ts`
**Relevant because:** Pre-generation should trigger on load()
**Key pattern:**
```typescript
load(session: ReplaySession): void {
  this.clearAdvanceTimer();
  this._playState = 'stopped';
  this.reviewStates.clear();
  this.events = session.events;
  this.session = session;
  this._currentIndex = -1;
  this._onSessionLoaded.fire(session);  // <-- Trigger pre-gen here
}

appendEvents(newEvents: TraceEvent[]): void {
  this.events.push(...newEvents);
  this._onEventsAppended.fire({ count: newEvents.length, total: this.events.length });
  // <-- Also trigger pre-gen for new events
}
```

## Reusable Utilities

| Utility | File | Usage |
|---------|------|-------|
| EventEmitter pattern | `src/replay/engine.ts` | Progress events for timeline UI |
| Cache key generation | `src/audio/ttsPlayer.ts:getCacheKey()` | Reuse for pre-gen cache |
| Temp file management | `src/audio/ttsPlayer.ts` | `os.tmpdir()` + `fs.mkdirSync` |
| Request ID tracking | `src/audio/ttsPlayer.ts` | Cancel in-flight requests on reload |
| Webview postMessage | `src/ui/timelineView.ts` | Progress indicator updates |

## Event Patterns

| Event | File | Pattern |
|-------|------|---------|
| onPlaybackComplete | ttsPlayer.ts | `{ requestId: number, cancelled: boolean }` |
| onStepChanged | engine.ts | `{ index, event, total }` |
| onSessionLoaded | engine.ts | `ReplaySession` |
| onEventsAppended | engine.ts | `{ count, total }` |
| onPlayStateChanged | engine.ts | `{ playState: PlayState }` |

**New event needed:**
```typescript
// In ttsPlayer.ts or new ttsPreloader.ts
private readonly _onPregenProgress = new vscode.EventEmitter<PregenProgressEvent>();
public readonly onPregenProgress = this._onPregenProgress.event;

interface PregenProgressEvent {
  current: number;
  total: number;
  status: 'generating' | 'complete' | 'error';
  failedEventIds?: string[];
}
```

## Section Handling

**Files:** `sectionStart.ts`, `sectionEnd.ts`

**How it works:**
- `sectionStart` events mark the beginning of a logical group
- `sectionEnd` events mark the end (no-op handler, just for tree structure)
- Timeline UI builds a tree from flat events using section markers
- Currently NO section depth tracking in engine

**Current section handler (sectionStart.ts):**
```typescript
async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
  context.outputChannel.appendLine(`[sectionStart] ${event.title}`);
  await context.inlineCard.showSectionStart(event.title);

  // Only speak if there's explicit narration (not just title)
  if (event.narration && event.narration !== event.title && !context._skipTts) {
    context.ttsPlayer.speakAsync(event.narration, event.id);
  }
}
```

**Current section handler (sectionEnd.ts):**
```typescript
async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
  context.outputChannel.appendLine(`[sectionEnd] ${event.title}`);
  // No-op - timeline UI handles visual grouping
}
```

**Needed change in engine.ts:**
```typescript
// Add section depth tracking
private currentSectionDepth = 0;

// In goToStep() or handler execution:
if (event.type === 'sectionStart') this.currentSectionDepth++;
if (event.type === 'sectionEnd') this.currentSectionDepth--;

// In waitForTtsAndScheduleAdvance():
const pauseMs = this.currentSectionDepth > 0 ? 100 : 75;
```

## Timeline UI Progress Indicator

**Current HTML structure (timeline.html):**
```html
<!-- Progress bar (step progress, not pregen) -->
<div class="progress-bar-track" id="progressTrack">
  <div class="progress-bar-fill" id="progressFill"></div>
</div>

<!-- Header -->
<div class="header">
  <div class="header-title" id="headerTitle">No replay loaded</div>
  <div class="header-subtitle" id="headerSubtitle"></div>
</div>
```

**Where to add pregen progress:**
```html
<!-- Add after header, before review-bar -->
<div class="pregen-status" id="pregenStatus" style="display: none;">
  <div class="pregen-progress-bar">
    <div class="pregen-progress-fill" id="pregenFill"></div>
  </div>
  <div class="pregen-text" id="pregenText">Preparing audio (0/20)</div>
</div>
```

**Current JS state management (timeline.js):**
```javascript
let currentIndex = -1;
let events = [];
let playState = 'stopped';
// ... etc

// Add:
let pregenStatus = { current: 0, total: 0, status: 'idle' };
```

## Files to Delete

| File | Lines | Reason |
|------|-------|--------|
| `src/util/highlightTimeline.ts` | 199 | Whisper word timing -> highlight events |
| `src/util/highlightScheduler.ts` | 101 | Timer-based highlight scheduling |

## Methods to Remove/Simplify

| Method | File | Action |
|--------|------|--------|
| `transcribeForTimings()` | ttsPlayer.ts | DELETE |
| `speakAsyncWithTimings()` | ttsPlayer.ts | DELETE |
| `speakWithTimings()` | ttsPlayer.ts | DELETE |
| `timingsCache` | ttsPlayer.ts | DELETE |
| `WordTiming` interface | ttsPlayer.ts | DELETE |
| `parseLineReferences()` | lineRefParser.ts | DELETE (keep legacy `parseLegacyLineReferences`) |

## Code to Simplify in highlightRange.ts

**Current (complex):**
```typescript
if (timedRefsForScheduling.length > 0) {
  context.ttsPlayer.speakAsyncWithTimings(cleanNarration, event.id, (result) => {
    const timeline = buildHighlightTimeline(result.wordTimings, timedRefsForScheduling);
    scheduler?.schedule(timeline, activeEditor, context.decorationManager);
  });
} else {
  context.ttsPlayer.speakAsync(cleanNarration, event.id);
}
```

**After (simple):**
```typescript
if (cleanNarration && !context._skipTts && context.engine.isPlaying) {
  context.ttsPlayer.speakAsync(cleanNarration, event.id);
}
```

## Pre-generation Queue Design

**Suggested implementation in new `src/audio/ttsPreloader.ts`:**
```typescript
export class TtsPreloader {
  private queue: TraceEvent[] = [];
  private isProcessing = false;
  private cancelToken = false;

  private readonly _onProgress = new vscode.EventEmitter<PregenProgressEvent>();
  public readonly onProgress = this._onProgress.event;

  async pregenerate(events: TraceEvent[], ttsPlayer: TtsPlayer): Promise<void> {
    // Filter to events with narration
    this.queue = events.filter(e => e.narration?.trim());
    this.cancelToken = false;
    this.isProcessing = true;

    const total = this.queue.length;
    let current = 0;
    const failed: string[] = [];

    for (const event of this.queue) {
      if (this.cancelToken) break;

      try {
        await ttsPlayer.generateOnly(event.narration, event.id);  // New method
      } catch (err) {
        failed.push(event.id);
        // Retry with backoff (up to 3 attempts)
      }

      current++;
      this._onProgress.fire({ current, total, status: 'generating', failedEventIds: failed });
    }

    this.isProcessing = false;
    this._onProgress.fire({ current, total, status: 'complete', failedEventIds: failed });
  }

  cancel(): void {
    this.cancelToken = true;
  }
}
```

## Retry Pattern (for TTS failures)

**Suggested exponential backoff:**
```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}
```
