# Progress: trace-detection-playback-fixes

## Status: complete

## Completed
- [x] Research: Config analysis
- [x] Research: Structure analysis
- [x] Research: Pattern mining
- [x] Research: Documentation
- [x] Strategy created
- [x] Bug 3: Added ttsPlayer.stop() in goToStep() (engine.ts:185)
- [x] Bug 1: Broadened glob to **/*.jsonl, per-file debounce map (fileWatcher.ts)
- [x] Bug 2: Rich sidebar notification card with webview ready handshake, auto-play (extension.ts, timelineView.ts, timeline.js, timeline.html, timeline.css)
- [x] Bug 3 (v2): Added navigation epoch guard to prevent stale handler audio overlap (engine.ts)
- [x] Build verified — no compile errors

## Next Steps
None — all implementation complete. Test via F5 in VS Code.

## Files
- Spec: .claude/specs/trace-detection-playback-fixes.md
- Strategy: .claude/research/trace-detection-playback-fixes/strategy.md

## Notes
- Last worked: 2026-02-06
- Key insight: goToStep() clears timers/listeners but doesn't call ttsPlayer.stop()
- Key insight: Sidebar resolveWebviewView fires AFTER engine events, causing race
- Optimization: Use engine.play() alone (not goToStep(0) + play()) since play() calls goToStep(0) internally when currentIndex is -1
