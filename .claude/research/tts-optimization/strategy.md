# Implementation Strategy: TTS Optimization

> Research completed on 2026-02-01
> Spec: .claude/specs/tts-optimization.md

## Quick Reference
| Aspect | Detail |
|--------|--------|
| Complexity | Medium |
| Files affected | ~12 (6 modify, 2 delete, 1 create, 3 webview updates) |
| Risk level | Medium (core playback changes, API interactions) |

## Project Rules (from CLAUDE.md)
- MUST: Use OpenAI TTS API (stay with current provider)
- MUST: TTS-first pattern - audio starts before file navigation
- MUST: Graceful degradation - visual-only playback if TTS unavailable
- MUST: Cache TTS results to avoid regeneration
- MUST: Retry failed TTS with exponential backoff (up to 3 attempts)
- MUST: Use system audio playback (PowerShell on Windows, afplay on macOS)
- MUST NOT: Change TTS provider
- MUST NOT: Store audio in trace files (ahead-of-time caching)
- MUST NOT: Support mid-narration highlight changes (replaced by atomic steps)

## Implementation Plan

### Files to Read First
| File | Why |
|------|-----|
| `src/audio/ttsPlayer.ts` | Core TTS logic, understand caching pattern, identify Whisper code to remove |
| `src/replay/engine.ts` | EventEmitter pattern for progress events, session load flow, TTS completion handling |
| `src/ui/timelineView.ts` | Webview communication pattern for progress updates |
| `webview/timeline.js` | Message handling pattern for UI updates |
| `src/replay/handlers/highlightRange.ts` | Current Whisper integration to simplify |

### Files to Create/Modify
| File | Action | Purpose |
|------|--------|---------|
| `src/audio/ttsPreloader.ts` | Create | Background TTS generation queue with retry logic |
| `src/audio/ttsPlayer.ts` | Modify | Remove Whisper methods, add `generateOnly()` for pre-generation |
| `src/replay/engine.ts` | Modify | Track section depth, trigger pre-generation on load, emit progress events |
| `src/replay/handlers/highlightRange.ts` | Modify | Remove timed line ref parsing and HighlightScheduler usage |
| `src/ui/timelineView.ts` | Modify | Add progress indicator, wire up pre-generation events |
| `src/util/lineRefParser.ts` | Modify | Remove `parseLineReferences()` XML syntax |
| `src/util/highlightTimeline.ts` | Delete | No longer needed (Whisper word timing logic) |
| `src/util/highlightScheduler.ts` | Delete | No longer needed (timer-based highlight scheduling) |
| `webview/timeline.html` | Modify | Add progress bar HTML element |
| `webview/timeline.js` | Modify | Handle progress messages, update progress UI |
| `src/trace/types.ts` | Modify | Add `PregenProgressEvent` interface |

### Step-by-Step

#### Step 1: Create TtsPreloader
**Files:** `src/audio/ttsPreloader.ts`
**Purpose:** Background queue for TTS generation with retry logic and progress events
**Pattern:** Follow existing EventEmitter pattern from engine.ts

```typescript
import * as vscode from 'vscode';
import type { TtsPlayer } from './ttsPlayer';
import type { TraceEvent } from '../trace/types';

export interface PregenProgressEvent {
  current: number;
  total: number;
  status: 'generating' | 'complete' | 'error';
  failedEventIds?: string[];
}

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
        await this.withRetry(() => ttsPlayer.generateOnly(event.narration!, event.id));
      } catch (err) {
        failed.push(event.id);
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

  prioritize(eventId: string): void {
    // Move event to front of remaining queue
    const idx = this.queue.findIndex(e => e.id === eventId);
    if (idx > 0) {
      const [event] = this.queue.splice(idx, 1);
      this.queue.unshift(event);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 1000): Promise<T> {
    let lastError: Error;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxAttempts) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1) * (0.5 + Math.random());
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError!;
  }

  dispose(): void {
    this._onProgress.dispose();
    this.cancel();
  }
}
```

#### Step 2: Modify TtsPlayer
**Files:** `src/audio/ttsPlayer.ts`
**Changes:**
1. Remove `transcribeForTimings()` method (Whisper API call)
2. Remove `speakAsyncWithTimings()` method
3. Remove `speakWithTimings()` method
4. Remove `timingsCache: Map<string, WordTiming[]>`
5. Remove `WordTiming` interface
6. Simplify `TtsResult` interface (remove `wordTimings`)
7. Add `generateOnly(text, eventId)` method for pre-generation (generates and caches without playing)

```typescript
// New method to add
async generateOnly(text: string, eventId: string): Promise<string> {
  const cacheKey = this.getCacheKey(text);
  let audioFilePath = this.audioCache.get(cacheKey);

  if (!audioFilePath) {
    audioFilePath = await this.generateTts(text, cacheKey);
    this.audioCache.set(cacheKey, audioFilePath);
  }

  return audioFilePath;
}
```

#### Step 3: Update Engine
**Files:** `src/replay/engine.ts`
**Changes:**
1. Add `private currentSectionDepth = 0` property
2. Increment/decrement in goToStep based on event type
3. Update `waitForTtsAndScheduleAdvance()` to use section-aware pause
4. Add `TtsPreloader` instance
5. Trigger pre-generation in `load()` method
6. Forward pre-generation progress events

```typescript
// Section depth tracking
private currentSectionDepth = 0;

// In goToStep() or handler execution:
if (event.type === 'sectionStart') this.currentSectionDepth++;
if (event.type === 'sectionEnd') this.currentSectionDepth = Math.max(0, this.currentSectionDepth - 1);

// In waitForTtsAndScheduleAdvance():
const pauseMs = this.currentSectionDepth > 0 ? 100 : 75;
this.scheduleAdvanceWithDelay(pauseMs);

// In load():
this.ttsPreloader.pregenerate(session.events, this.context.ttsPlayer);
```

#### Step 4: Simplify highlightRange Handler
**Files:** `src/replay/handlers/highlightRange.ts`
**Changes:**
1. Remove import of `HighlightScheduler`
2. Remove import of `buildHighlightTimeline`
3. Remove `speakAsyncWithTimings()` call
4. Use simple `speakAsync()` for all narration
5. Remove timed line ref logic

```typescript
// Before (complex):
if (timedRefsForScheduling.length > 0) {
  context.ttsPlayer.speakAsyncWithTimings(cleanNarration, event.id, (result) => {
    const timeline = buildHighlightTimeline(result.wordTimings, timedRefsForScheduling);
    scheduler?.schedule(timeline, activeEditor, context.decorationManager);
  });
} else {
  context.ttsPlayer.speakAsync(cleanNarration, event.id);
}

// After (simple):
if (cleanNarration && !context._skipTts && context.engine.isPlaying) {
  context.ttsPlayer.speakAsync(cleanNarration, event.id);
}
```

#### Step 5: Update Timeline UI
**Files:** `src/ui/timelineView.ts`, `webview/timeline.html`, `webview/timeline.js`
**Changes:**

**timelineView.ts:**
1. Subscribe to `TtsPreloader.onProgress` events
2. Send progress updates to webview via `postMessage`

```typescript
this.ttsPreloader.onProgress((progress) => {
  this.view.webview.postMessage({
    command: 'updatePregenProgress',
    current: progress.current,
    total: progress.total,
    status: progress.status
  });
});
```

**timeline.html:**
```html
<!-- Add after header, before review-bar -->
<div class="pregen-status" id="pregenStatus" style="display: none;">
  <div class="pregen-progress-bar">
    <div class="pregen-progress-fill" id="pregenFill"></div>
  </div>
  <div class="pregen-text" id="pregenText">Preparing audio (0/20)</div>
</div>
```

**timeline.js:**
```javascript
// Add state variable
let pregenStatus = { current: 0, total: 0, status: 'idle' };

// Add message handler case
case 'updatePregenProgress':
  pregenStatus = { current: msg.current, total: msg.total, status: msg.status };
  updatePregenProgress();
  break;

// Add update function
function updatePregenProgress() {
  var el = document.getElementById('pregenStatus');
  var fill = document.getElementById('pregenFill');
  var text = document.getElementById('pregenText');

  if (pregenStatus.status === 'complete' || pregenStatus.total === 0) {
    el.style.display = 'none';
  } else {
    el.style.display = 'block';
    var pct = (pregenStatus.current / pregenStatus.total) * 100;
    fill.style.width = pct + '%';
    text.textContent = 'Preparing audio (' + pregenStatus.current + '/' + pregenStatus.total + ')';
  }
}
```

#### Step 6: Clean Up Unused Code
**Files:** Delete `src/util/highlightTimeline.ts`, `src/util/highlightScheduler.ts`; modify `src/util/lineRefParser.ts`

**lineRefParser.ts changes:**
- Remove `parseLineReferences()` function (XML `<line:X>` syntax)
- Keep `parseLegacyLineReferences()` if needed for static highlights

**Update imports across codebase:**
- Remove any imports of deleted files
- Update any files that referenced removed methods

### Utilities to Reuse
| Utility | Import | Usage |
|---------|--------|-------|
| EventEmitter | `vscode.EventEmitter` | Progress events from TtsPreloader |
| getCacheKey() | `src/audio/ttsPlayer.ts` | Content-based hash for audio caching |
| Temp directory | `os.tmpdir()` + `path.join()` | Audio file storage |
| postMessage pattern | `src/ui/timelineView.ts` | Webview communication |

## Edge Cases
| Case | Handling |
|------|----------|
| API rate limit (429) | Exponential backoff with jitter, max 3 retries per step |
| User skips ahead | Call `preloader.prioritize(eventId)` to boost next step |
| Playback catches up | Show spinner on step until audio ready; use existing `onPlaybackComplete` pattern |
| Trace reloaded | Call `preloader.cancel()`, clear caches, restart pre-generation |
| Trace appended | Generate TTS for new events only (check cache before generating) |
| Empty narration | Skip TTS for that step; use minimal pause (25ms) |
| API key missing | Show error notification, disable TTS, allow visual-only playback |
| Network failure after retries | Mark step as "no audio" in failed array, continue with next |

## Testing Plan
| What to Test | How |
|--------------|-----|
| Pre-generation completes | Load trace with 5+ steps, verify all audio cached before playback |
| Retry logic | Mock API to return 429 twice then succeed; verify 3 attempts made |
| Progress updates | Load trace, observe timeline progress indicator updates |
| Section pause timing | Create trace with section markers, verify 100ms pause within section |
| Cancel on reload | Load trace, reload mid-generation, verify old generation stops |
| Playback without audio ready | Start playback immediately after load, verify spinner appears |
| Skip ahead prioritization | Skip to step 10 while generating step 3, verify step 10 prioritized |

## Risks
| Risk | Mitigation |
|------|------------|
| Large traces overwhelm API | Sequential generation with rate limiting; respect `retry-after` header |
| Breaking existing playback | Keep `speakAsync()` unchanged; only remove Whisper-specific code paths |
| Webview state lost on reload | Use `vscode.getState()`/`setState()` for persisting collapsed sections |
| Memory leak from EventEmitters | Add dispose() to TtsPreloader; clean up in extension deactivate |
| Progress UI flicker | Debounce progress updates (update at most every 100ms) |

## Migration Checklist
- [ ] Verify no code references `transcribeForTimings`
- [ ] Verify no code references `speakAsyncWithTimings`
- [ ] Verify no code references `WordTiming` interface
- [ ] Verify no code imports `highlightTimeline.ts`
- [ ] Verify no code imports `highlightScheduler.ts`
- [ ] Verify `<line:X>` syntax no longer parsed (grep for `<line:`)
- [ ] Test playback with existing trace files (no regressions)
- [ ] Test with new trace files (section pause timing correct)
