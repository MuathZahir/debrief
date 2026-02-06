# Spec: Trace Detection, Notification & Playback Fixes

> Created: 2026-02-06

## Problem
Three user-facing bugs degrade the Debrief experience: (1) the file watcher only detects files named exactly `trace.jsonl`, ignoring other .jsonl files the user creates; (2) clicking "Walk Me Through It" on the notification doesn't reliably load the trace into the timeline sidebar; (3) navigating between steps while audio is playing doesn't stop the previous voice, causing overlapping narration.

## Goals
- [ ] File watcher reliably detects any .jsonl file in `.debrief/replay/` and subdirectories
- [ ] Notification action loads the trace AND the timeline sidebar reflects it immediately
- [ ] Navigating steps always stops the previous audio before starting the next
- [ ] Fix related robustness issues found during analysis

## Non-Goals
- Redesigning the timeline sidebar UI
- Adding new notification actions beyond current set
- Changing the TTS engine or voice

## Requirements

### Must Have

- [ ] **Bug 1 — File watcher glob**: Change from `**/.debrief/replay/trace.jsonl` to `**/.debrief/replay/**/*.jsonl` so any `.jsonl` file in the replay directory or subdirectories triggers detection
- [ ] **Bug 1 — Debounce per-file**: Current debounce uses a single timer, so rapid writes to different files could suppress notifications. Track debounce per file URI.
- [ ] **Bug 2 — Richer notification**: Replace `showInformationMessage` with a modal dialog (`modal: true`) so it's impossible to miss. Include step count and file count in the message body.
- [ ] **Bug 2 — Notification auto-loads into timeline**: After `engine.load(session)` and `goToStep(0)`, ensure the timeline webview receives the updated state. If the webview isn't initialized yet (sidebar closed), the `focus` command should trigger initialization, and the `onSessionLoaded` listener should push state once the webview is ready.
- [ ] **Bug 2 — Auto-play from notification**: When user clicks "Walk Me Through It", call `engine.play()` after loading so narration begins automatically. The existing `debrief.loadReplay` command (manual load from sidebar) should NOT auto-play.
- [ ] **Bug 3 — Stop audio on step navigation**: Add `this.context.ttsPlayer.stop()` at the top of `goToStep()` (after clearing timers/listeners, before executing the new handler). This ensures the old audio process is killed regardless of whether the new step has narration.
- [ ] **Bug 3 — Stop audio on `next()`/`previous()` when not playing**: Currently handlers only call `speakAsync()` when `isPlaying` is true. If user was playing, then manually clicks a step (which doesn't set `isPlaying` to false), the old audio continues. The `goToStep()` fix above handles this.

### Nice to Have

- [ ] Show trace filename in the notification message (not just summary) so user knows which file was detected
- [ ] If multiple .jsonl files are written in quick succession, batch them into a single notification listing all detected files
- [ ] Add a `debrief.loadTrace(uri)` command that can be called programmatically (decouples notification action from file picker)

## User Flow

### Trace detection → playback
1. User (or agent) saves a `.jsonl` file to `.debrief/replay/` or a subdirectory
2. File watcher detects the change after 500ms debounce
3. Modal dialog appears: "Debrief: New walkthrough ready — 12 steps across 4 files" with actions: **Walk Me Through It**, **View Summary**, **Dismiss**
4. User clicks **Walk Me Through It**
5. Trace is parsed and loaded into the engine
6. Timeline sidebar opens and shows all steps
7. Playback starts automatically from step 0 with TTS narration
8. User can pause, skip steps, or click any step in the timeline

### Step navigation while playing
1. Audio is playing for step N
2. User clicks step M in the timeline (or presses next/previous)
3. Current audio stops immediately (process killed)
4. Step M's handler executes
5. If playing, step M's TTS starts and auto-advance is scheduled

## Technical Constraints
- VS Code's `showInformationMessage` with `modal: true` is the richest built-in notification — no custom HTML/CSS
- Audio process kill must be synchronous (no lingering audio after `stop()` returns)
- `speakAsync()` already calls `stop()` internally, but `goToStep()` must also stop audio for cases where the new step has no narration

## Root Cause Analysis

### Bug 1 — File watcher misses files
- **Location**: `src/agent/fileWatcher.ts:38-39`
- **Cause**: Glob pattern `**/.debrief/replay/trace.jsonl` only matches that exact filename
- **Fix**: Change to `**/.debrief/replay/**/*.jsonl`

### Bug 2 — Notification doesn't load into timeline
- **Location**: `src/extension.ts:181-187`
- **Cause**: Race condition — `engine.load()` fires `onSessionLoaded`, but if the timeline webview isn't yet resolved (sidebar was closed), the event is lost. The `debrief.timeline.focus` command opens the sidebar, which triggers `resolveWebviewView`, but by then `onSessionLoaded` already fired.
- **Fix**: After focusing the sidebar, ensure `updateWebview()` is called. The existing `engine.isLoaded` check in `resolveWebviewView` (line 97) handles this with a 100ms delay, but this may not be enough if the webview HTML takes longer to load. Increase the delay or use a ready handshake from the webview.

### Bug 3 — Overlapping voices
- **Location**: `src/replay/engine.ts:177-235` (`goToStep`)
- **Cause**: `goToStep()` clears timers and listeners (lines 183-184) but does NOT call `ttsPlayer.stop()`. If the new step's handler doesn't call `speakAsync()` (e.g., `sectionStart` with no narration, or manual click when not playing), the old audio process keeps running.
- **Fix**: Add `this.context.ttsPlayer.stop()` at line 183, before clearing timers.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Agent writes trace incrementally (streaming) | 500ms debounce coalesces writes; notification fires once writing stops |
| Multiple .jsonl files created simultaneously | Each gets its own debounce timer; multiple notifications may appear |
| User dismisses notification, then clicks Load Replay | File picker opens as before — no change to manual flow |
| Step has no narration and user navigates away | `ttsPlayer.stop()` is a no-op if nothing is playing — safe |
| Timeline sidebar is already open when notification fires | `focus` command brings it to front; `onSessionLoaded` listener updates it immediately |
| Timeline sidebar webview not yet initialized | `resolveWebviewView` fires on focus, checks `engine.isLoaded`, sends state with delay |
| User clicks "Walk Me Through It" while a replay is already loaded | Previous session is replaced — `engine.load()` clears old state |
| Rapid next/next/next clicks | Each `goToStep()` call stops previous audio immediately; no overlap |

## Success Criteria
- [ ] Creating any `.jsonl` file in `.debrief/replay/` or subdirectories triggers a notification
- [ ] Clicking "Walk Me Through It" opens the timeline with steps visible (not "No replay loaded")
- [ ] Playback starts automatically after clicking "Walk Me Through It"
- [ ] Clicking next/previous/specific step while audio plays: old audio stops instantly, no overlap
- [ ] Manual "Load Replay" from sidebar does NOT auto-play
- [ ] No regressions: pause still works, auto-advance still works, TTS pre-generation still works

## Open Questions
- None — all questions resolved during interview
