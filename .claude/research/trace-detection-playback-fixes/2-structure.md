# Structure Analysis: trace-detection-playback-fixes

## Architecture
Type: layer-based (src/ split by concern: agent, audio, replay, trace, ui, util)

## Key Directories
| Directory | Purpose |
|-----------|---------|
| src/agent/ | File watcher + HTTP server for agent integration |
| src/audio/ | TTS generation (OpenAI API) and playback (system audio) |
| src/replay/ | Engine state machine + event handlers per type |
| src/replay/handlers/ | One handler class per TraceEvent type |
| src/trace/ | Types (Zod schemas) + JSONL parser |
| src/ui/ | TimelineViewProvider (sidebar), StatusBar, InlineCard, GitContentProvider |
| src/util/ | Decorations, line-ref parsing, highlight scheduling |
| webview/ | HTML/CSS/JS for timeline sidebar webview |

## Conventions
- Files: camelCase (e.g., `fileWatcher.ts`, `ttsPlayer.ts`)
- Classes: PascalCase, suffixed with role (`TraceFileWatcher`, `ReplayEngine`, `TtsPlayer`, `TimelineViewProvider`)
- Handlers: PascalCase + `Handler` suffix (`HighlightRangeHandler`, `SayHandler`), registered in `handlers/index.ts` record
- Events: VS Code `EventEmitter` pattern — private `_onX` emitter, public `onX` event
- Tests: none found in repo

## Task-Relevant Areas

### Bug 1 -- File watcher glob
| Path | Why Relevant | Lines of Interest |
|------|--------------|-------------------|
| `src/agent/fileWatcher.ts` | **Primary fix target.** Glob pattern is hardcoded to `trace.jsonl` | L38-39: `'**/.debrief/replay/trace.jsonl'` -- change to `'**/.debrief/replay/**/*.jsonl'` |
| `src/agent/fileWatcher.ts` | Single debounce timer shared across all files | L19: `private debounceTimer` -- single timer; L57-72: `handleChange()` clears/resets one timer for any URI. Need `Map<string, Timer>` keyed by URI. |

### Bug 2 -- Notification does not load into timeline
| Path | Why Relevant | Lines of Interest |
|------|--------------|-------------------|
| `src/extension.ts` | Notification handler for `traceWatcher.onTraceDetected` | L156-206: entire handler. L174-179: `showInformationMessage` (not modal). L181-187: "Walk Me Through It" action -- calls `engine.load()`, `goToStep(0)`, then `debrief.timeline.focus`. |
| `src/extension.ts` | Race condition: `engine.load()` fires `onSessionLoaded` before sidebar webview exists | L184: `engine.load(session)` fires `_onSessionLoaded` immediately. L187: `debrief.timeline.focus` opens sidebar, triggering `resolveWebviewView`. But the webview missed the event. |
| `src/ui/timelineView.ts` | TimelineViewProvider: resolves webview, pushes state | L27-31: Listeners for engine events (onStepChanged, onSessionLoaded, etc.) call `updateWebview()`. L56-101: `resolveWebviewView()` -- sets `this.view`, checks `engine.isLoaded` at L97-100 with 100ms delay. |
| `src/ui/timelineView.ts` | `updateWebview()` short-circuits if `this.view` is null | L106-108: early return if no view. Events fired before `resolveWebviewView` are silently dropped. |
| `src/extension.ts` | Need to add `engine.play()` after load for auto-play from notification | L181-187: after `goToStep(0)` and focus, add `engine.play()`. The manual `debrief.loadReplay` at L313-376 must NOT auto-play (it already uses `skipTts: true` at L371). |

### Bug 3 -- Overlapping audio on step navigation
| Path | Why Relevant | Lines of Interest |
|------|--------------|-------------------|
| `src/replay/engine.ts` | `goToStep()` does NOT call `ttsPlayer.stop()` | L177-235: `goToStep()`. L182-184: clears advance timer and TTS listener but does NOT stop audio. Fix: add `this.context.ttsPlayer.stop()` at ~L183. |
| `src/audio/ttsPlayer.ts` | `stop()` method kills child process, fires completion event | L217-232: `stop()`. Kills `currentProcess`, sets `isPlaying=false`, fires `onPlaybackComplete` with `cancelled: true`. Safe to call when nothing is playing (no-op). |
| `src/replay/handlers/highlightRange.ts` | Calls `speakAsync` only when `engine.isPlaying` | L21-23: guard `context.engine.isPlaying`. If user manually navigates while audio is playing (isPlaying stays true on engine), old audio continues. The `goToStep()` fix covers this. |
| `src/replay/handlers/say.ts` | Same isPlaying guard pattern | L25: `context.engine.isPlaying` guard. Same issue as highlightRange. |
| `src/replay/handlers/sectionStart.ts` | Calls `speakAsync` without `isPlaying` guard when narration != title | L21-23: no `isPlaying` check -- speaks regardless. Could cause overlap if user clicks a sectionStart manually while audio plays. The `goToStep()` fix covers this too. |

### Supporting context
| Path | Why Relevant | Lines of Interest |
|------|--------------|-------------------|
| `src/replay/engine.ts` | `play()` method starts playback | L265-298: sets `_playState='playing'`, calls `goToStep(0)` or re-executes current handler. |
| `src/replay/engine.ts` | `pause()` already calls `ttsPlayer.stop()` | L300-308: stops TTS on pause. Confirms `stop()` is safe and expected. |
| `src/replay/engine.ts` | `load()` fires `_onSessionLoaded` | L119-131: resets state, fires event, starts TTS preloading. |
| `src/trace/types.ts` | `ReplaySession` interface | L98-103: `events`, `metadata?`, `summary?`, `tracePath?`. |
| `src/replay/handlers/index.ts` | Handler registry + `HandlerContext` interface | L12-23: context has `ttsPlayer`, `engine`, `_skipTts`. L40-47: handler map. |
| `src/extension.ts` | `buildNotificationSummary()` helper | L474-494: builds "Agent completed -- changed N files (M diffs)." string. Useful for enriching modal notification. |
| `src/extension.ts` | HTTP server `onSessionEnded` also shows notification | L250-307: similar pattern -- shows notification, "Walk Me Through It" calls `goToStep(0)` + focus. Same race condition applies; same fix needed. |

## Where Changes Go

### Bug 1 -- File watcher glob + per-file debounce
- **File**: `src/agent/fileWatcher.ts`
- **L38-39**: Change glob from `'**/.debrief/replay/trace.jsonl'` to `'**/.debrief/replay/**/*.jsonl'`
- **L19**: Replace `private debounceTimer` with `private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()`
- **L46-50** (`stop()`): Iterate and clear all timers in map
- **L55-72** (`handleChange()`): Key debounce by `uri.toString()`

### Bug 2 -- Notification + timeline load + auto-play
- **File**: `src/extension.ts` L174-187
  - Change `showInformationMessage` to include `{ modal: true }` option
  - Enrich message with step count and file count
  - After `goToStep(0)` and `debrief.timeline.focus`, add `await engine.play()`
- **File**: `src/extension.ts` L250-307 (HTTP session ended)
  - Apply same modal + auto-play pattern
- **File**: `src/ui/timelineView.ts` L97-100
  - Increase delay or implement a ready handshake: webview posts `'ready'` message, provider responds with state push. This eliminates the race entirely.

### Bug 3 -- Stop audio on step navigation
- **File**: `src/replay/engine.ts` L182-184 (inside `goToStep()`)
  - Add `this.context.ttsPlayer.stop();` before or after `this.clearAdvanceTimer()` / `this.clearTtsCompletionListener()`
  - This is the single fix that covers all step navigation paths (next, previous, goToStep, manual click from timeline)

## Interaction Map

```
fileWatcher.ts  --onTraceDetected-->  extension.ts (notification)
                                         |
                                    engine.load(session)
                                    engine.goToStep(0)
                                    focus sidebar  --triggers-->  timelineView.ts resolveWebviewView()
                                    engine.play()                    |
                                         |                     updateWebview() <-- engine.onSessionLoaded
                                         v
                                    engine.goToStep(N)
                                         |
                                    ttsPlayer.stop()  <-- NEW (Bug 3 fix)
                                    clearAdvanceTimer()
                                    clearTtsCompletionListener()
                                    handler.execute()
                                         |
                              speakAsync() (if isPlaying)
```
