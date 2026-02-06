# Pattern Analysis: trace-detection-playback-fixes

## Reference Implementations

### 1. FileSystemWatcher glob pattern
**File:** `src/agent/fileWatcher.ts`
**Relevant because:** This is the exact code that needs the glob change (Bug 1).
**Key pattern:**
```typescript
// Current (too narrow):
this.watcher = vscode.workspace.createFileSystemWatcher(
  '**/.debrief/replay/trace.jsonl'
);

this.watcher.onDidCreate((uri) => this.handleChange(uri));
this.watcher.onDidChange((uri) => this.handleChange(uri));
```
VS Code's `createFileSystemWatcher` accepts a `GlobPattern` (string or `RelativePattern`). The glob `**/.debrief/replay/**/*.jsonl` is valid and will match any `.jsonl` file at any depth under `.debrief/replay/`. No `RelativePattern` is needed since the `**` prefix already scopes to workspace folders.

### 2. Single-timer debounce in fileWatcher
**File:** `src/agent/fileWatcher.ts` (lines 19, 55-72)
**Relevant because:** This is the per-file debounce bug (Bug 1). A single timer means write events to file A cancel the pending debounce for file B.
**Key pattern:**
```typescript
private debounceTimer: ReturnType<typeof setTimeout> | null = null;
private readonly DEBOUNCE_MS = 500;

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
**Fix pattern:** Replace single timer with `Map<string, ReturnType<typeof setTimeout>>` keyed by `uri.toString()`.

### 3. suppressNext flag in fileWatcher
**File:** `src/agent/fileWatcher.ts` (line 27) and `src/extension.ts` (line 260)
**Relevant because:** Shows how the HTTP server prevents duplicate notifications when it writes the trace file. The flag is set before writing, then checked/cleared in the debounce callback.
**Key pattern (setter):**
```typescript
// src/extension.ts:260 — inside httpServer.onSessionEnded handler
traceWatcher.suppressNext = true;

// Write trace.jsonl
const traceContent =
  session.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
await fs.promises.writeFile(
  path.join(dir, 'trace.jsonl'),
  traceContent,
  'utf-8'
);
```
**Key pattern (consumer):**
```typescript
// src/agent/fileWatcher.ts:65-68 — inside debounce callback
if (this.suppressNext) {
  this.suppressNext = false;
  return;
}
```
**Issue with per-file debounce:** `suppressNext` is a boolean flag, not per-URI. If switching to per-file debounce, the suppress logic needs to either remain global (acceptable since HTTP server only writes `trace.jsonl`) or become per-URI. Since the HTTP server always writes to a known path, keeping `suppressNext` as a simple boolean is fine.

### 4. Notification patterns (showInformationMessage)
**File:** `src/extension.ts` (lines 174-179, 294-298)
**Relevant because:** These are the two notification sites that need to become modal (Bug 2).
**Key pattern (file watcher notification):**
```typescript
// src/extension.ts:174-179 — non-modal notification (current)
const action = await vscode.window.showInformationMessage(
  `Debrief: ${summaryText}`,
  'Walk Me Through It',
  'View Summary',
  'Dismiss'
);
```
**Key pattern (HTTP session ended notification):**
```typescript
// src/extension.ts:294-298 — non-modal notification (current)
const action = await vscode.window.showInformationMessage(
  `Debrief: ${summaryText}`,
  'Walk Me Through It',
  'Dismiss'
);
```
**Modal pattern (existing in codebase):**
```typescript
// src/ui/inlineCard.ts:91-94 — existing modal: false usage
vscode.window.showInformationMessage(
  `${stepLabel}: ${title}\n\n${narration}`,
  { modal: false }
);
```
**Target pattern:** Change to `{ modal: true }` and include richer detail text.

### 5. "Walk Me Through It" action handler (file watcher)
**File:** `src/extension.ts` (lines 181-187)
**Relevant because:** This is where Bug 2 manifests. The sequence `engine.load()` -> `goToStep(0)` -> `focus sidebar` has a race condition. Also, `engine.play()` is never called (no auto-play).
**Key pattern:**
```typescript
if (action === 'Walk Me Through It') {
  loadedTracePath = traceUri.fsPath;
  session.tracePath = traceUri.fsPath;
  engine.load(session);
  await engine.goToStep(0);
  // Auto-open the Debrief sidebar
  await vscode.commands.executeCommand('debrief.timeline.focus');
}
```
**Race condition:** `engine.load(session)` at line 184 immediately fires `_onSessionLoaded`. The `TimelineViewProvider` listener at line 28 calls `updateWebview()`, but `this.view` is null (sidebar is closed), so the update is silently dropped. Then `debrief.timeline.focus` at line 187 triggers `resolveWebviewView`, which checks `engine.isLoaded` with a 100ms delay, but that delay is fragile.

### 6. "Walk Me Through It" action handler (HTTP session ended)
**File:** `src/extension.ts` (lines 300-305)
**Relevant because:** Same race condition as #5, plus events were already appended via `appendEvents()`.
**Key pattern:**
```typescript
if (action === 'Walk Me Through It') {
  // Engine already has events via appendEvents — restart from beginning
  await engine.goToStep(0);
  // Auto-open the Debrief sidebar
  await vscode.commands.executeCommand('debrief.timeline.focus');
}
```
**Note:** This handler does NOT call `engine.load()` (events arrived via streaming), so the timeline may already have the events if it was open. But if the sidebar was closed, same race applies.

### 7. Manual "Load Replay" command (no auto-play reference)
**File:** `src/extension.ts` (lines 360-374)
**Relevant because:** This must NOT auto-play. Already uses `skipTts: true`.
**Key pattern:**
```typescript
loadedTracePath = filePath;
session.tracePath = filePath;
engine.load(session);

// ... info message ...

// Navigate to the first step without playing TTS
await engine.goToStep(0, { skipTts: true });

// Auto-open the Debrief sidebar
await vscode.commands.executeCommand('debrief.timeline.focus');
```
Critically, `engine.play()` is never called here. The `skipTts: true` option prevents narration on the initial step. This is correct behavior that must be preserved.

### 8. Timeline webview resolveWebviewView + delayed state push
**File:** `src/ui/timelineView.ts` (lines 56-101)
**Relevant because:** This is the race-condition site (Bug 2). The 100ms delay is arbitrary and fragile.
**Key pattern:**
```typescript
resolveWebviewView(
  webviewView: vscode.WebviewView,
  _context: vscode.WebviewViewResolveContext,
  _token: vscode.CancellationToken
): void {
  this.view = webviewView;

  webviewView.webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(this.extensionUri, 'webview'),
    ],
  };

  webviewView.webview.html = this.getHtml(webviewView.webview);

  // Handle messages from the webview
  webviewView.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.command) {
      case 'goToStep':
        this.engine.goToStep(msg.index);
        break;
      // ... more handlers
    }
  });

  // If a session is already loaded, push state immediately
  if (this.engine.isLoaded) {
    // Small delay to let the webview initialize
    setTimeout(() => this.updateWebview(), 100);
  }
}
```
**No ready handshake:** The webview JS never posts a `'ready'` message. The provider relies on a hardcoded 100ms delay. If the webview HTML/JS takes longer than 100ms to parse and execute, the `updateState` message is received before the `message` event listener is registered, and the state is silently lost.

### 9. Webview message listener (client-side)
**File:** `webview/timeline.js` (lines 399-443)
**Relevant because:** Shows how the webview receives state updates. There is no `'ready'` message posted back.
**Key pattern:**
```javascript
window.addEventListener('message', function (event) {
  var msg = event.data;

  switch (msg.command) {
    case 'updateState':
      events = msg.events || [];
      currentIndex = msg.currentIndex;
      playState = msg.playState || 'stopped';
      if (currentIndex >= 0) {
        visitedSteps.add(currentIndex);
      }
      render();
      break;

    case 'clearSession':
      // ...
      break;
    // ...
  }
});

// Initial render (shows empty state)
render();
```
**Fix:** After registering the `message` listener, post a `{ command: 'ready' }` message back to the extension. The provider listens for this and pushes state.

### 10. updateWebview short-circuit
**File:** `src/ui/timelineView.ts` (lines 106-108)
**Relevant because:** When `this.view` is null (sidebar not open), ALL engine events are silently dropped.
**Key pattern:**
```typescript
private updateWebview(): void {
  if (!this.view) {
    return;
  }

  this.view.webview.postMessage({
    command: 'updateState',
    events: this.engine.allEvents.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      narration: e.narration,
      filePath: e.filePath,
      comment: e.comment,
      risks: e.risks,
    })),
    currentIndex: this.engine.currentIndex,
    playState: this.engine.playState,
  });
}
```
The `this.view` null-guard is correct (can't post to a webview that doesn't exist). The real fix is ensuring that once the view IS created, it immediately receives the current state via the ready handshake.

### 11. engine.load() fires onSessionLoaded synchronously
**File:** `src/replay/engine.ts` (lines 119-131)
**Relevant because:** The event fires synchronously during `load()`, before any async operations like `debrief.timeline.focus` have a chance to execute.
**Key pattern:**
```typescript
load(session: ReplaySession): void {
  this.clearAdvanceTimer();
  this._playState = 'stopped';
  this._currentSectionDepth = 0;
  this.events = session.events;
  this.session = session;
  this._currentIndex = -1;
  this._onSessionLoaded.fire(session);  // <-- fires synchronously HERE

  // Start pre-generating TTS for all events in background
  this._ttsPreloader.reset();
  this._ttsPreloader.pregenerate(session.events, this.context.ttsPlayer);
}
```

### 12. goToStep() does NOT stop TTS
**File:** `src/replay/engine.ts` (lines 177-235)
**Relevant because:** This is the exact code path for Bug 3 (overlapping audio).
**Key pattern:**
```typescript
async goToStep(index: number, options?: { skipTts?: boolean }): Promise<void> {
  if (index < 0 || index >= this.events.length) {
    return;
  }

  // Cancel any pending advance timer and TTS completion listener
  this.clearAdvanceTimer();
  this.clearTtsCompletionListener();
  // *** MISSING: this.context.ttsPlayer.stop() ***

  this._currentIndex = index;
  const event = this.events[index];

  // ... section depth, preloader, handler execution ...
}
```

### 13. pause() DOES stop TTS (reference for the fix)
**File:** `src/replay/engine.ts` (lines 300-308)
**Relevant because:** Shows the pattern that goToStep() should follow.
**Key pattern:**
```typescript
pause(): void {
  this._playState = 'paused';
  this.clearAdvanceTimer();
  this.clearTtsCompletionListener();
  this.context.ttsPlayer.stop();  // Stop TTS when pausing
  this._onPlayStateChanged.fire({
    playState: 'paused',
  });
}
```

### 14. TTS stop() is safe to call when nothing is playing
**File:** `src/audio/ttsPlayer.ts` (lines 217-232)
**Relevant because:** Confirms `stop()` is a safe no-op when nothing is playing. The `wasPlaying` guard prevents spurious completion events.
**Key pattern:**
```typescript
stop(): void {
  const wasPlaying = this.isPlaying;

  // Kill the current audio process if running
  if (this.currentProcess) {
    this.currentProcess.kill();
    this.currentProcess = null;
  }

  this.isPlaying = false;

  // Fire completion event if we were playing (cancelled)
  if (wasPlaying) {
    this._onPlaybackComplete.fire({ requestId: this.currentRequestId, cancelled: true });
  }
}
```

### 15. speakAsync() already calls stop() internally
**File:** `src/audio/ttsPlayer.ts` (lines 78-92)
**Relevant because:** Even though handlers call `speakAsync()` (which calls `stop()` internally), the `goToStep()` fix is still needed for cases where the new step has no narration (e.g., `sectionEnd`, or manual click with `isPlaying` guard blocking `speakAsync`).
**Key pattern:**
```typescript
speakAsync(text: string, eventId: string): void {
  // Stop any currently playing audio FIRST (before incrementing ID)
  this.stop();

  // Now increment request ID for the new request
  const requestId = ++this.currentRequestId;

  this.speakWithRequestId(text, eventId, requestId).catch(err => {
    if (requestId === this.currentRequestId) {
      this.outputChannel.appendLine(`[TtsPlayer] Async speak error: ${err}`);
    }
  });
}
```

### 16. Handler TTS guard patterns (isPlaying check)
**File:** Multiple handlers
**Relevant because:** Shows the inconsistency -- three handlers check `isPlaying`, two do not. The `goToStep()` fix makes this inconsistency less dangerous but it still exists.

**Handlers that check `context.engine.isPlaying`:**
```typescript
// src/replay/handlers/highlightRange.ts:21
if (cleanNarration && !context._skipTts && context.engine.isPlaying) {
  context.ttsPlayer.speakAsync(cleanNarration, event.id);
}

// src/replay/handlers/openFile.ts:21
if (cleanNarration && !context._skipTts && context.engine.isPlaying) {
  context.ttsPlayer.speakAsync(cleanNarration, event.id);
}

// src/replay/handlers/say.ts:25
if (event.narration && !context._skipTts && context.engine.isPlaying) {
  const cleanText = stripLineReferences(event.narration);
  context.ttsPlayer.speakAsync(cleanText, event.id);
}
```

**Handlers that do NOT check `isPlaying`:**
```typescript
// src/replay/handlers/showDiff.ts:12-14
if (event.narration && !context._skipTts) {
  context.ttsPlayer.speakAsync(event.narration, event.id);
}

// src/replay/handlers/sectionStart.ts:21-23
if (event.narration && event.narration !== event.title && !context._skipTts) {
  context.ttsPlayer.speakAsync(event.narration, event.id);
}
```
`showDiff` and `sectionStart` will call `speakAsync()` even when manually navigating (not playing). This means clicking a `showDiff` step while another step's audio plays WILL stop the old audio (since `speakAsync` calls `stop()` internally). But clicking a `highlightRange` step while not playing will NOT stop old audio (the `isPlaying` guard skips `speakAsync`). The `goToStep()` fix resolves this gap.

### 17. onSessionCleared stops TTS
**File:** `src/extension.ts` (lines 70-73)
**Relevant because:** Shows that TTS cleanup on session lifecycle transitions is already established as a pattern.
**Key pattern:**
```typescript
engine.onSessionCleared(() => {
  inlineCard.hide();
  ttsPlayer.stop();
});
```

### 18. buildNotificationSummary helper
**File:** `src/extension.ts` (lines 474-494)
**Relevant because:** Used to build the notification message text. Can be enriched with step count for the modal.
**Key pattern:**
```typescript
function buildNotificationSummary(session: ReplaySession): string {
  const fileSet = new Set(
    session.events.filter((e) => e.filePath).map((e) => e.filePath)
  );
  const diffCount = session.events.filter(
    (e) => e.type === 'showDiff'
  ).length;

  const parts: string[] = ['Agent completed'];

  if (fileSet.size > 0) {
    parts.push(
      `-- changed ${fileSet.size} file${fileSet.size !== 1 ? 's' : ''}`
    );
  }
  if (diffCount > 0) {
    parts.push(`(${diffCount} diff${diffCount !== 1 ? 's' : ''})`);
  }

  return parts.join(' ') + '.';
}
```

## Reusable Utilities

| Utility | File | Usage |
|---------|------|-------|
| `ttsPlayer.stop()` | `src/audio/ttsPlayer.ts:217-232` | Safe no-op when nothing is playing; kills child process synchronously; fires `onPlaybackComplete` with `cancelled: true` only if was playing |
| `ttsPlayer.speakAsync()` | `src/audio/ttsPlayer.ts:78-92` | Calls `stop()` internally first, then generates/plays TTS in background |
| `clearAdvanceTimer()` | `src/replay/engine.ts:391-396` | Clears the auto-advance timeout; safe no-op if no timer set |
| `clearTtsCompletionListener()` | `src/replay/engine.ts:398-404` | Disposes the TTS completion event listener; safe no-op if none set |
| `buildNotificationSummary()` | `src/extension.ts:474-494` | Builds "Agent completed -- changed N files (M diffs)." string |
| `generateSummaryMarkdown()` | `src/extension.ts:496-521` | Generates full markdown summary of a session |
| `parseLegacyLineReferences()` | `src/util/lineRefParser.ts` | Strips `<line:X>` syntax from narration text |
| `vscode.EventEmitter` pattern | Throughout | Private `_onX` + public `onX` event pattern for custom events |

## Event Flow Patterns

### engine.load() -> timelineView update (current, broken)

```
1. extension.ts:184        engine.load(session)
2. engine.ts:126           _onSessionLoaded.fire(session)  [SYNC]
3. timelineView.ts:28      engine.onSessionLoaded(() => this.updateWebview())
4. timelineView.ts:107     updateWebview() -> this.view is null -> RETURN (silently dropped)
5. extension.ts:185        await engine.goToStep(0)
6. engine.ts:225           _onStepChanged.fire(...)  [SYNC]
7. timelineView.ts:27      engine.onStepChanged(() => this.updateWebview())
8. timelineView.ts:107     updateWebview() -> this.view is null -> RETURN (silently dropped)
9. extension.ts:187        await commands.executeCommand('debrief.timeline.focus')
10. VS Code                Sidebar opens -> resolveWebviewView() called
11. timelineView.ts:61     this.view = webviewView
12. timelineView.ts:70     webviewView.webview.html = this.getHtml(...)
13. timelineView.ts:97-100 engine.isLoaded -> true -> setTimeout(updateWebview, 100)
14. [100ms later]          updateWebview() -> this.view exists -> postMessage('updateState')
15. webview/timeline.js    MAY or MAY NOT have registered message listener yet
```

Steps 4 and 8 are where the events are lost. Step 15 is where the 100ms delay may be insufficient.

### Correct flow (with ready handshake)

```
1. extension.ts            await commands.executeCommand('debrief.timeline.focus')
2. VS Code                 resolveWebviewView() called
3. timelineView.ts         this.view = webviewView, set HTML
4. webview/timeline.js     Script executes, registers message listener
5. webview/timeline.js     vscode.postMessage({ command: 'ready' })
6. timelineView.ts         onDidReceiveMessage('ready') -> updateWebview()
7. extension.ts            engine.load(session)
8. engine.ts               _onSessionLoaded.fire(session) -> updateWebview() works (view exists)
9. extension.ts            await engine.goToStep(0) -> updateWebview() works
```

OR, keeping the same call order (load before focus):

```
1. extension.ts            engine.load(session) -> events fire but view is null -> dropped (OK)
2. extension.ts            await engine.goToStep(0) -> events fire but view is null -> dropped (OK)
3. extension.ts            await commands.executeCommand('debrief.timeline.focus')
4. VS Code                 resolveWebviewView() called
5. timelineView.ts         this.view = webviewView, set HTML, register message handler
6. webview/timeline.js     Script executes, registers message listener
7. webview/timeline.js     vscode.postMessage({ command: 'ready' })
8. timelineView.ts         onDidReceiveMessage('ready') -> engine.isLoaded? -> updateWebview()
```

### goToStep -> handler -> TTS flow (current, broken for overlapping audio)

```
1. engine.ts:183           clearAdvanceTimer()
2. engine.ts:184           clearTtsCompletionListener()
3. [NO ttsPlayer.stop()]   <-- old audio process keeps running
4. engine.ts:209           handler.execute(event, context)
5. handler:                if (isPlaying) { ttsPlayer.speakAsync(text, id) }
6a. [If isPlaying]:        speakAsync -> stop() -> kill old process -> start new
6b. [If NOT isPlaying]:    speakAsync NOT called -> old audio keeps playing!
```

Case 6b is the bug: if user manually clicks a step (engine is not in "playing" state), the `isPlaying` guard in handlers prevents `speakAsync()` from being called, so the old audio process from a previous "playing" session continues.

### goToStep -> handler -> TTS flow (fixed)

```
1. engine.ts:183           clearAdvanceTimer()
2. engine.ts:184           clearTtsCompletionListener()
3. engine.ts:NEW           this.context.ttsPlayer.stop()  <-- kills old audio
4. engine.ts:209           handler.execute(event, context)
5. handler:                if (isPlaying) { ttsPlayer.speakAsync(text, id) }
6. [If isPlaying]:         speakAsync -> stop() (no-op, already stopped) -> start new
```

## Error Handling

**Pattern:** Handlers wrap execution in try/catch, log to `outputChannel`, and continue.
```typescript
// src/replay/engine.ts:208-217
try {
  await handler.execute(event, this.context);
} catch (err) {
  this.context.outputChannel.appendLine(
    `[engine] Handler error for ${event.type} (${event.id}): ${err}`
  );
}
```

**TTS errors:** Fire `onPlaybackComplete` with `cancelled: true` so auto-advance doesn't stall.
```typescript
// src/audio/ttsPlayer.ts:180-186
} catch (err) {
  this.outputChannel.appendLine(`[TtsPlayer] Failed to generate TTS: ${err}`);
  vscode.window.showWarningMessage(`TTS failed: ${err}`);
  setImmediate(() => {
    if (requestId === this.currentRequestId) {
      this._onPlaybackComplete.fire({ requestId, cancelled: true });
    }
  });
  return;
}
```

**File operations:** Graceful fallbacks -- if a file can't be opened, the handler logs and returns.
```typescript
// src/replay/handlers/highlightRange.ts:66-73
try {
  doc = await vscode.workspace.openTextDocument(uri);
} catch (err) {
  context.outputChannel.appendLine(
    `[highlightRange] Failed to open ${event.filePath}: ${err}`
  );
  return;
}
```

## Key Code Paths

### Bug 1: File watcher glob + per-file debounce

| Step | File | Lines | What happens |
|------|------|-------|-------------|
| 1 | `src/agent/fileWatcher.ts` | 38-39 | `createFileSystemWatcher('**/.debrief/replay/trace.jsonl')` -- only matches exact filename |
| 2 | `src/agent/fileWatcher.ts` | 42-43 | `onDidCreate` and `onDidChange` both call `handleChange(uri)` |
| 3 | `src/agent/fileWatcher.ts` | 55-72 | `handleChange()` uses single `debounceTimer` -- write to file A cancels pending timer for file B |
| 4 | `src/agent/fileWatcher.ts` | 46-53 | `stop()` clears single timer -- needs to iterate map |
| 5 | `src/agent/fileWatcher.ts` | 65-68 | `suppressNext` flag is global boolean, not per-URI (acceptable, only HTTP server uses it) |

### Bug 2: Notification + timeline load race condition

| Step | File | Lines | What happens |
|------|------|-------|-------------|
| 1 | `src/extension.ts` | 174-179 | `showInformationMessage` (non-modal) -- easy to miss |
| 2 | `src/extension.ts` | 184 | `engine.load(session)` fires `_onSessionLoaded` synchronously |
| 3 | `src/replay/engine.ts` | 126 | `_onSessionLoaded.fire(session)` |
| 4 | `src/ui/timelineView.ts` | 28 | Listener calls `updateWebview()` |
| 5 | `src/ui/timelineView.ts` | 107-108 | `updateWebview()` short-circuits: `if (!this.view) return` -- sidebar is closed |
| 6 | `src/extension.ts` | 185 | `await engine.goToStep(0)` fires `_onStepChanged` -- also dropped at step 5 |
| 7 | `src/extension.ts` | 187 | `await commands.executeCommand('debrief.timeline.focus')` |
| 8 | `src/ui/timelineView.ts` | 56 | `resolveWebviewView()` called by VS Code |
| 9 | `src/ui/timelineView.ts` | 61 | `this.view = webviewView` |
| 10 | `src/ui/timelineView.ts` | 70 | HTML is set on webview |
| 11 | `src/ui/timelineView.ts` | 97-100 | `engine.isLoaded` -> true -> `setTimeout(updateWebview, 100)` |
| 12 | `webview/timeline.js` | 399-446 | Message listener registered at script execution time |
| 13 | `webview/timeline.js` | 446 | `render()` called (shows empty state) |
| 14 | [100ms later] | `src/ui/timelineView.ts` | `updateWebview()` posts `'updateState'` -- may arrive before or after JS executes |

**Second occurrence (HTTP session ended):**
| Step | File | Lines | What happens |
|------|------|-------|-------------|
| 1 | `src/extension.ts` | 294-298 | Same non-modal `showInformationMessage` |
| 2 | `src/extension.ts` | 302 | `await engine.goToStep(0)` -- engine already has events via `appendEvents()` |
| 3 | `src/extension.ts` | 304 | `await commands.executeCommand('debrief.timeline.focus')` |
| -- | Same race as above | -- | If sidebar was closed, events may be lost |

**Missing:** Neither handler calls `engine.play()` -- no auto-play from notification.

### Bug 3: Overlapping audio on step navigation

| Step | File | Lines | What happens |
|------|------|-------|-------------|
| 1 | User clicks step in timeline | | |
| 2 | `webview/timeline.js` | 216 | `vscode.postMessage({ command: 'goToStep', index: index })` |
| 3 | `src/ui/timelineView.ts` | 76 | `this.engine.goToStep(msg.index)` |
| 4 | `src/replay/engine.ts` | 183 | `this.clearAdvanceTimer()` |
| 5 | `src/replay/engine.ts` | 184 | `this.clearTtsCompletionListener()` |
| 6 | **MISSING** | | `this.context.ttsPlayer.stop()` is NOT called |
| 7 | `src/replay/engine.ts` | 209 | `handler.execute(event, context)` |
| 8a | handler (if `isPlaying`) | | `speakAsync()` -> `stop()` -> starts new audio (OK) |
| 8b | handler (if NOT `isPlaying`) | | `speakAsync()` NOT called -> old audio continues (BUG) |
| 8c | handler (`showDiff`/`sectionStart`) | | No `isPlaying` guard -> `speakAsync()` always called -> `stop()` -> OK |

Same path applies for `next()` at line 241 and `previous()` at line 249 (both call `goToStep()`).
