# Implementation Strategy: trace-detection-playback-fixes

> Research completed on 2026-02-06
> Spec: .claude/specs/trace-detection-playback-fixes.md

## Quick Reference
| Aspect | Detail |
|--------|--------|
| Complexity | Medium |
| Files affected | ~4 (fileWatcher.ts, engine.ts, extension.ts, timelineView.ts + webview/timeline.js) |
| Risk level | Low |

## Project Rules (from CLAUDE.md)
- MUST: Use `npm run build` to compile; test via F5; TTS-first pattern (audio before navigation); graceful degradation if Whisper unavailable; audio kill must be synchronous
- MUST NOT: Redesign the timeline sidebar UI; add new notification actions beyond current set; change TTS engine or voice; auto-play from manual "Load Replay" command

## Implementation Plan

### Files to Read First
| File | Why |
|------|-----|
| `src/replay/engine.ts` L300-308 | Shows `pause()` calling `ttsPlayer.stop()` -- the pattern `goToStep()` must follow |
| `src/audio/ttsPlayer.ts` L217-232 | Confirms `stop()` is safe as a no-op when nothing is playing |
| `src/ui/timelineView.ts` L56-101 | Shows `resolveWebviewView` and the fragile 100ms delay |
| `webview/timeline.js` L399-447 | Shows message listener registration and missing ready handshake |
| `src/extension.ts` L156-206, L250-307 | Both notification handlers with the same race condition |

### Files to Create/Modify
| File | Action | Purpose |
|------|--------|---------|
| `src/agent/fileWatcher.ts` | Modify | Fix glob pattern, add per-file debounce map |
| `src/replay/engine.ts` | Modify | Add `ttsPlayer.stop()` in `goToStep()` |
| `src/extension.ts` | Modify | Modal notifications, reorder load/focus, add `engine.play()` for auto-play |
| `src/ui/timelineView.ts` | Modify | Add ready handshake listener, remove 100ms delay |
| `webview/timeline.js` | Modify | Post `ready` message after registering message listener |

### Step-by-Step

#### Step 1: Fix overlapping audio (Bug 3 -- simplest, lowest risk)
**Files:** `src/replay/engine.ts`
**What:** Add `this.context.ttsPlayer.stop()` in `goToStep()` to kill any playing audio before executing the new step's handler.
**Exact change:** In the `goToStep` method (line 177), insert `this.context.ttsPlayer.stop();` immediately after line 184 (`this.clearTtsCompletionListener();`) and before line 186 (`this._currentIndex = index;`). The result at lines 182-187 becomes:

```typescript
// Cancel any pending advance timer and TTS completion listener
this.clearAdvanceTimer();
this.clearTtsCompletionListener();
this.context.ttsPlayer.stop();

this._currentIndex = index;
```

**Why this works:** `ttsPlayer.stop()` is already proven safe (used in `pause()` at line 304, used in `onSessionCleared` at extension.ts line 72). It is a no-op when nothing is playing. When audio IS playing, it kills the child process synchronously and fires `onPlaybackComplete` with `cancelled: true`. Since we already cleared the TTS completion listener on the line above, the cancelled completion event will not trigger any spurious advance. Handlers that call `speakAsync()` internally call `stop()` first anyway, so calling it here is a harmless double-stop for the playing case and a critical fix for the not-playing case (where `isPlaying` guards in handlers skip `speakAsync()`).

**Verification:** Play a session, then while audio is narrating, click a different step in the timeline. Old audio must stop immediately. Then click next/previous rapidly -- no overlapping voices.

---

#### Step 2: Fix file watcher glob + per-file debounce (Bug 1)
**Files:** `src/agent/fileWatcher.ts`
**What:** Broaden glob pattern, replace single debounce timer with a per-URI map.

**Exact changes:**

**2a. Line 19 -- Replace single timer with Map:**
Change:
```typescript
private debounceTimer: ReturnType<typeof setTimeout> | null = null;
```
To:
```typescript
private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
```

**2b. Lines 38-39 -- Fix glob pattern:**
Change:
```typescript
this.watcher = vscode.workspace.createFileSystemWatcher(
  '**/.debrief/replay/trace.jsonl'
);
```
To:
```typescript
this.watcher = vscode.workspace.createFileSystemWatcher(
  '**/.debrief/replay/**/*.jsonl'
);
```

**2c. Lines 46-50 -- Fix `stop()` to clear all timers:**
Change:
```typescript
stop(): void {
  if (this.debounceTimer) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }
  this.watcher?.dispose();
  this.watcher = null;
}
```
To:
```typescript
stop(): void {
  for (const timer of this.debounceTimers.values()) {
    clearTimeout(timer);
  }
  this.debounceTimers.clear();
  this.watcher?.dispose();
  this.watcher = null;
}
```

**2d. Lines 55-72 -- Fix `handleChange()` for per-URI debounce:**
Change:
```typescript
private handleChange(uri: vscode.Uri): void {
  // Debounce: agents may write the file incrementally
  if (this.debounceTimer) {
    clearTimeout(this.debounceTimer);
  }

  this.debounceTimer = setTimeout(() => {
    this.debounceTimer = null;

    // Check suppress flag (set by HTTP server when it writes the file)
    if (this.suppressNext) {
      this.suppressNext = false;
      return;
    }

    const directoryUri = vscode.Uri.joinPath(uri, '..');
    this._onTraceDetected.fire({ traceUri: uri, directoryUri });
  }, this.DEBOUNCE_MS);
}
```
To:
```typescript
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
```

**2e. Update JSDoc on class (lines 12-16):** Change "trace.jsonl files" to "`.jsonl` files in `.debrief/replay/`" in the class doc comment.

**Note on `suppressNext`:** The flag remains a simple boolean (not per-URI). This is acceptable because only the HTTP server sets it, and it always writes to a single known path (`trace.jsonl`). Per-URI suppress tracking is unnecessary complexity.

**Verification:** Create `.debrief/replay/custom-name.jsonl` with valid trace content. A notification should appear. Create `.debrief/replay/subfolder/deep.jsonl` -- also detected. Write to two different files rapidly -- each gets its own debounce and both fire notifications independently.

---

#### Step 3: Fix notification + timeline load race condition (Bug 2)
**Files:** `webview/timeline.js`, `src/ui/timelineView.ts`, `src/extension.ts`

This fix has three sub-parts: (a) webview ready handshake, (b) modal notification, (c) auto-play from notification.

**3a. Webview ready handshake -- `webview/timeline.js`:**
After the `window.addEventListener('message', ...)` block and the `render()` call at the bottom of the IIFE (after line 446), add a ready message:

Change (lines 445-447):
```javascript
  // ── Initial render ─────────────────────────────────────────────────────
  render();
})();
```
To:
```javascript
  // ── Initial render ─────────────────────────────────────────────────────
  render();

  // Signal to the extension that the webview is ready to receive messages
  vscode.postMessage({ command: 'ready' });
})();
```

**3b. Ready handshake listener -- `src/ui/timelineView.ts`:**
In the `resolveWebviewView` method, add a `'ready'` case to the `onDidReceiveMessage` switch, and remove the fragile 100ms setTimeout.

Change the message handler (lines 73-94) to add the `'ready'` case:
```typescript
// Handle messages from the webview
webviewView.webview.onDidReceiveMessage(async (msg) => {
  switch (msg.command) {
    case 'ready':
      // Webview JS has loaded and registered its message listener.
      // Push current state if a session is already loaded.
      if (this.engine.isLoaded) {
        this.updateWebview();
      }
      break;
    case 'goToStep':
      this.engine.goToStep(msg.index);
      break;
    case 'next':
      this.engine.next();
      break;
    case 'previous':
      this.engine.previous();
      break;
    case 'togglePlayPause':
      this.engine.togglePlayPause();
      break;
    case 'saveComment':
      await this.engine.saveComment(msg.eventId, msg.comment);
      break;
    case 'loadReplay':
      vscode.commands.executeCommand('debrief.loadReplay');
      break;
  }
});
```

Then remove the fragile 100ms delay (lines 96-100). Change:
```typescript
// If a session is already loaded, push state immediately
if (this.engine.isLoaded) {
  // Small delay to let the webview initialize
  setTimeout(() => this.updateWebview(), 100);
}
```
To:
```typescript
// State will be pushed when the webview sends the 'ready' message.
// No need for a timer — the ready handshake ensures the webview
// has registered its message listener before we send state.
```

**3c. Modal notifications + auto-play -- `src/extension.ts`:**

**File watcher notification (lines 174-187):**
Change:
```typescript
const action = await vscode.window.showInformationMessage(
  `Debrief: ${summaryText}`,
  'Walk Me Through It',
  'View Summary',
  'Dismiss'
);

if (action === 'Walk Me Through It') {
  loadedTracePath = traceUri.fsPath;
  session.tracePath = traceUri.fsPath;
  engine.load(session);
  await engine.goToStep(0);
  // Auto-open the Debrief sidebar
  await vscode.commands.executeCommand('debrief.timeline.focus');
```
To:
```typescript
const stepCount = session.events.length;
const fileCount = new Set(
  session.events.filter((e) => e.filePath).map((e) => e.filePath)
).size;

const action = await vscode.window.showInformationMessage(
  'Debrief: New walkthrough ready',
  {
    modal: true,
    detail: `${stepCount} steps across ${fileCount} files\n${path.basename(traceUri.fsPath)}`,
  },
  'Walk Me Through It',
  'View Summary'
);

if (action === 'Walk Me Through It') {
  loadedTracePath = traceUri.fsPath;
  session.tracePath = traceUri.fsPath;
  engine.load(session);
  // Open sidebar FIRST so resolveWebviewView fires and the ready
  // handshake delivers state. goToStep + play happen after.
  await vscode.commands.executeCommand('debrief.timeline.focus');
  await engine.goToStep(0);
  await engine.play();
```

Key changes:
1. `{ modal: true, detail: ... }` makes notification unmissable.
2. Removed "Dismiss" button (modal auto-adds Cancel).
3. Moved `debrief.timeline.focus` BEFORE `goToStep(0)` so the sidebar's `resolveWebviewView` fires first, the webview sends `'ready'`, and the provider pushes state. Then `goToStep(0)` and `engine.play()` fire events that `updateWebview()` can receive (since `this.view` is now set).
4. Added `await engine.play()` for auto-play from notification.

**HTTP session ended notification (lines 294-305):**
Change:
```typescript
const action = await vscode.window.showInformationMessage(
  `Debrief: ${summaryText}`,
  'Walk Me Through It',
  'Dismiss'
);

if (action === 'Walk Me Through It') {
  // Engine already has events via appendEvents — restart from beginning
  await engine.goToStep(0);
  // Auto-open the Debrief sidebar
  await vscode.commands.executeCommand('debrief.timeline.focus');
}
```
To:
```typescript
const stepCount = replaySession.events.length;
const fileCount = new Set(
  replaySession.events.filter((e) => e.filePath).map((e) => e.filePath)
).size;

const action = await vscode.window.showInformationMessage(
  'Debrief: New walkthrough ready',
  {
    modal: true,
    detail: `${stepCount} steps across ${fileCount} files`,
  },
  'Walk Me Through It'
);

if (action === 'Walk Me Through It') {
  // Open sidebar first so ready handshake delivers state
  await vscode.commands.executeCommand('debrief.timeline.focus');
  // Engine already has events via appendEvents — restart from beginning
  await engine.goToStep(0);
  await engine.play();
}
```

Same pattern: modal, focus-first, auto-play.

**Manual "Load Replay" command (lines 358-374) -- NO CHANGE:**
This command already uses `skipTts: true` and does NOT call `engine.play()`. It must remain as-is. Verified at lines 370-374.

### Utilities to Reuse
| Utility | Import | Usage |
|---------|--------|-------|
| `ttsPlayer.stop()` | Already on `this.context.ttsPlayer` in engine | Safe no-op when idle; kills audio process synchronously when playing |
| `clearAdvanceTimer()` | Private method in engine | Clears auto-advance timeout |
| `clearTtsCompletionListener()` | Private method in engine | Disposes TTS completion event listener |
| `buildNotificationSummary()` | Local function in extension.ts | Builds summary text (still used, but detail text computed inline for modal) |
| `engine.play()` | Public method on ReplayEngine | Sets playState to 'playing', re-executes current handler, schedules advance |

## Edge Cases
| Case | Handling |
|------|----------|
| Step has no narration (e.g., `sectionEnd`) and user navigates away | `ttsPlayer.stop()` is a no-op -- safe |
| Rapid next/next/next clicks while playing | Each `goToStep()` kills previous audio before executing new handler -- no overlap |
| User clicks step while engine is NOT in playing state | `goToStep()` now calls `stop()` directly, killing any orphaned audio from a previous playing session |
| Webview takes >100ms to load JS | Ready handshake eliminates the race -- state is pushed only after JS confirms ready |
| Sidebar already open when notification fires | `debrief.timeline.focus` brings it to front; `this.view` is already set so `updateWebview()` works immediately; ready message re-fires from webview if it was recreated |
| Sidebar hidden then re-shown (webview destroyed/recreated) | `resolveWebviewView` fires again, webview sends `'ready'`, provider pushes current state |
| Multiple .jsonl files created simultaneously | Per-file debounce ensures each file gets its own 500ms timer; separate notifications fire for each |
| `suppressNext` with per-file debounce | `suppressNext` remains a global boolean; only the HTTP server uses it, and it always writes to one known path |
| Modal notification dismissed via Escape/Cancel | Returns `undefined`; no action taken -- same as "Dismiss" behavior |
| `engine.play()` called when already at end | `play()` returns early if `isAtEnd` -- no error |
| `engine.play()` called when no events | `play()` returns early if `!isLoaded` -- no error |

## Testing Plan
| Scenario | How to Test |
|----------|-------------|
| Bug 1: Glob detection | Create `.debrief/replay/custom.jsonl` with valid JSONL content. Verify notification appears. Also test `.debrief/replay/sub/deep.jsonl`. |
| Bug 1: Per-file debounce | Write to `a.jsonl` and `b.jsonl` within 500ms. Both should produce notifications (not cancel each other). |
| Bug 2: Modal notification | Save a trace file. Verify a modal dialog (centered, blocking) appears instead of a toast notification. |
| Bug 2: Timeline loads correctly | Click "Walk Me Through It". Verify the sidebar shows all steps (not "No replay loaded"). |
| Bug 2: Auto-play | Click "Walk Me Through It". Verify TTS narration starts automatically. The play/pause button should show pause icon. |
| Bug 2: Manual load does NOT auto-play | Use command palette "Debrief: Load Replay". Verify no audio plays. Play/pause button shows play icon. |
| Bug 2: HTTP session notification | Start a live session via HTTP, end it. Verify modal appears. Click "Walk Me Through It" and verify timeline loads + auto-plays. |
| Bug 3: Overlapping audio - playing state | While audio is playing, click a different step. Old audio must stop instantly. New step's audio should start. |
| Bug 3: Overlapping audio - paused/manual | Pause playback (audio still speaking last words), then click a step. Audio must stop. |
| Bug 3: Rapid navigation | During playback, press Next rapidly 5 times. Only the final step's audio should be heard. No overlapping. |
| Regression: Pause | During playback, pause. Audio stops. Resume. Audio restarts from current step. |
| Regression: Auto-advance | Let playback run. After each step's TTS completes, engine should auto-advance to next step. |
| Regression: TTS pre-generation | Load a trace. Check output channel for pre-generation logs. Audio should be cached. |

## Risks
| Risk | Mitigation |
|------|------------|
| Ready handshake adds a small delay before state appears in sidebar | Negligible -- JS execution is sub-10ms. The 100ms delay it replaces was already longer. If needed, add a 50ms safety timeout that fires `updateWebview()` as a fallback in case the ready message is lost. |
| `engine.play()` re-executes the current handler | This is intentional -- `play()` at line 284-297 re-runs the handler to start TTS. Since `goToStep(0)` already ran the handler with default (non-skip) TTS, calling `play()` immediately after will re-execute and the internal `speakAsync()` call will stop the first audio and start again. This is a minor double-execution. To avoid it, call `play()` INSTEAD of `goToStep(0)` -- `play()` already calls `goToStep(0)` when `currentIndex < 0` (line 276-280). However, `engine.load()` sets `_currentIndex = -1`, so `play()` will call `goToStep(0)` automatically. **Optimization: remove the explicit `goToStep(0)` call and just call `engine.play()` after load.** |
| Moving `debrief.timeline.focus` before `goToStep(0)` changes event ordering | This is the desired fix. The sidebar must be resolved before engine events fire so `updateWebview()` has a non-null `this.view`. The ready handshake ensures state is pushed after webview JS is ready. |
| Modal dialogs block VS Code UI | Intentional per spec. The notification is in response to a deliberate action (file write to `.debrief/replay/`). VS Code docs discourage overuse, but this is an appropriate case. |
| `suppressNext` is not per-URI | Acceptable. Only the HTTP server sets it, and it always writes to `trace.jsonl`. No other code path sets it. |

## Optimization Note

In Step 3c, after `engine.load(session)`, calling both `goToStep(0)` and `engine.play()` causes the step-0 handler to execute twice (once from `goToStep`, once from `play` which re-executes the handler). Since `engine.load()` resets `_currentIndex` to -1, calling `engine.play()` alone will internally call `goToStep(0)` (see engine.ts line 276-280). The cleaner pattern for the notification handler is:

```typescript
engine.load(session);
await vscode.commands.executeCommand('debrief.timeline.focus');
await engine.play();  // This calls goToStep(0) internally since currentIndex is -1
```

This eliminates the explicit `goToStep(0)` and avoids double handler execution. Apply this optimization to both notification handlers (file watcher and HTTP session ended).
