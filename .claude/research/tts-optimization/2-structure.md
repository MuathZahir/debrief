# Structure Analysis: TTS Optimization

## Architecture
Type: Layer-based with feature subdirectories

```
src/
  audio/        # TTS and audio playback
  replay/       # Playback engine and handlers
  trace/        # Trace file types and parsing
  ui/           # VS Code UI components
  util/         # Shared utilities
  agent/        # HTTP server and file watcher
```

## Key Directories
| Directory | Purpose |
|-----------|---------|
| `src/audio/` | TTS generation (`ttsPlayer.ts`) and webview audio (`audioWebview.ts`) |
| `src/replay/` | Engine state machine and event handlers |
| `src/replay/handlers/` | Per-event-type handlers (highlightRange, say, etc.) |
| `src/util/` | Decorations, line parsing, highlight scheduling |
| `src/ui/` | Timeline sidebar, status bar, inline cards |
| `webview/` | HTML/CSS/JS for sidebar and audio player |

## Conventions
- Files: `kebab-case.ts` (e.g., `ttsPlayer.ts`, `lineRefParser.ts`)
- Classes: `PascalCase` (e.g., `TtsPlayer`, `ReplayEngine`)
- Interfaces: `PascalCase` (e.g., `WordTiming`, `TtsResult`)
- Tests: None in project (only in node_modules/zod)
- Events: VS Code `EventEmitter` pattern (`_onX` private, `onX` public)

## Task-Relevant Files
| Path | Why Relevant |
|------|--------------|
| `src/audio/ttsPlayer.ts` | Main TTS logic, has `transcribeForTimings()`, `timingsCache` - needs removal |
| `src/audio/audioWebview.ts` | Audio playback via webview - keep as-is |
| `src/replay/engine.ts` | Triggers TTS, manages playback state, section tracking needed |
| `src/replay/handlers/highlightRange.ts` | Uses `speakAsyncWithTimings()`, `HighlightScheduler` - needs simplification |
| `src/replay/handlers/say.ts` | Uses `speakAsync()` - minimal changes |
| `src/util/highlightTimeline.ts` | Builds timeline from Whisper timings - DELETE |
| `src/util/highlightScheduler.ts` | Schedules highlight events - DELETE |
| `src/util/lineRefParser.ts` | `parseLineReferences()` for `<line:X>` syntax - remove XML parsing |
| `src/ui/timelineView.ts` | Sidebar webview - add progress indicator |
| `src/extension.ts` | Wires everything together, engine initialization |
| `webview/timeline.html` | Timeline HTML - add progress UI |
| `webview/timeline.js` | Timeline JS - handle progress messages |

## Files to DELETE
- `src/util/highlightTimeline.ts` (199 lines) - Whisper word timing → highlight events
- `src/util/highlightScheduler.ts` (101 lines) - Timer-based highlight scheduling

## Key Interfaces (src/audio/ttsPlayer.ts)
```typescript
interface WordTiming { word: string; start: number; end: number; }  // DELETE
interface TtsResult { requestId: number; wordTimings: WordTiming[]; duration: number; }  // Simplify
```

## Key Methods to Remove
| Method | File | Reason |
|--------|------|--------|
| `transcribeForTimings()` | ttsPlayer.ts | Whisper API call |
| `speakAsyncWithTimings()` | ttsPlayer.ts | Whisper-dependent TTS |
| `speakWithTimings()` | ttsPlayer.ts | Internal Whisper flow |
| `timingsCache` | ttsPlayer.ts | Cached Whisper results |
| `buildHighlightTimeline()` | highlightTimeline.ts | Whole file deleted |
| `schedule()` | highlightScheduler.ts | Whole file deleted |
| `parseLineReferences()` | lineRefParser.ts | XML `<line:X>` syntax |

## Where New Code Goes
| Component | Suggested Path | Notes |
|-----------|---------------|-------|
| TtsPreloader | `src/audio/ttsPreloader.ts` | New file in audio/ |
| Progress events | `src/trace/types.ts` | Add `PregenProgressEvent` interface |
| Timeline progress UI | `webview/timeline.js` | Add progress bar element |
| Section tracking | `src/replay/engine.ts` | Add `currentSectionDepth` property |

## Current TTS Flow (to simplify)
```
1. highlightRange handler calls speakAsyncWithTimings()
2. ttsPlayer generates TTS via OpenAI
3. ttsPlayer calls Whisper for word timings    <-- REMOVE
4. Callback fires with timings
5. buildHighlightTimeline() creates events     <-- REMOVE
6. HighlightScheduler sets timers              <-- REMOVE
7. Audio plays with synchronized highlights    <-- Simplify to static
```

## New TTS Flow (target)
```
1. engine.load() triggers TtsPreloader.pregenerate()
2. TtsPreloader queues all narrations
3. Background generation with progress events
4. Timeline UI shows "Preparing audio (5/20)"
5. On play, audio file already cached
6. Static highlight for step duration (no word sync)
```

## Section Handling in Engine
Current `engine.ts` has no section depth tracking. Need to add:
```typescript
private currentSectionDepth = 0;
// In waitForTtsAndScheduleAdvance():
const pauseMs = this.currentSectionDepth > 0 ? 100 : 75;
```

## Dependencies
- `zod` - Schema validation (keep)
- `dotenv` - API key loading (keep)
- No test framework configured
