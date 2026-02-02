# Spec: TTS Optimization - Remove Whisper, Add Pre-generation

> Created: 2026-02-01

## Problem

The current TTS implementation makes two API calls per step: TTS generation + Whisper transcription (for word-level timings). This adds ~2-4 seconds of delay per step and is architecturally complex. The Whisper call exists to enable mid-narration highlight changes via `<line:X>` syntax, but this can be solved more simply with atomic steps.

## Goals

- [ ] Eliminate Whisper API calls entirely
- [ ] Pre-generate TTS for all steps when trace loads (zero delay during playback)
- [ ] Enable smooth transitions between related steps using existing section markers
- [ ] Add collapsible groups in timeline UI
- [ ] Show pre-generation progress in timeline sidebar

## Non-Goals

- Changing TTS provider (staying with OpenAI)
- Ahead-of-time audio caching in trace files
- Mid-narration highlight changes (replaced by atomic steps)

## Requirements

### Must Have

- [ ] Remove Whisper transcription code path
- [ ] Remove `<line:X>text</line:X>` parsing and timeline scheduling
- [ ] Pre-generate TTS for all steps on trace load (background, non-blocking)
- [ ] Show progress indicator in timeline sidebar during pre-generation
- [ ] Steps within a section have ~100ms pause between them (smooth flow)
- [ ] Steps outside sections keep current pause behavior (~75ms after TTS)
- [ ] Retry failed TTS generation with exponential backoff (up to 3 attempts)
- [ ] If playback catches up to un-generated step, show brief spinner until ready

### Nice to Have

- [ ] Collapsible sections in timeline sidebar UI
- [ ] Priority queue: when user starts playing, prioritize current + next N steps
- [ ] Cache TTS across sessions (persist temp files with content hash)

## User Flow

1. User loads a trace file (via command or file watcher)
2. Timeline sidebar shows steps; progress indicator appears "Preparing audio (0/N)"
3. Background worker starts generating TTS for each step sequentially
4. Progress updates as each step completes "Preparing audio (5/20)"
5. User can start playback at any time (even before all audio ready)
6. If playback reaches a step without audio, show spinner on that step until ready
7. Steps within `sectionStart`/`sectionEnd` pairs transition with ~100ms pause
8. Steps outside sections transition with standard ~75ms pause

## Technical Constraints

- OpenAI TTS API rate limits (respect backoff on 429 errors)
- TTS generation is ~1-2s per step - traces with 50+ steps take time to prepare
- Must handle trace reload (clear old cache, start fresh generation)
- Must handle trace append (generate TTS for new steps only)

## Implementation Notes

### Files to Modify

| File | Changes |
|------|---------|
| `src/audio/ttsPlayer.ts` | Remove `transcribeForTimings()`, `speakAsyncWithTimings()`, `timingsCache`. Add `pregenerate(texts[])` method |
| `src/replay/engine.ts` | Track section state for transition timing. Trigger pre-generation on `load()` |
| `src/replay/handlers/highlightRange.ts` | Remove timed line ref parsing and `HighlightScheduler` usage |
| `src/ui/timelineView.ts` | Add pre-generation progress indicator. Add collapsible section UI |
| `src/util/highlightTimeline.ts` | Can be deleted (no longer needed) |
| `src/util/highlightScheduler.ts` | Can be deleted (no longer needed) |
| `src/util/lineRefParser.ts` | Remove `parseLineReferences()` XML syntax (keep legacy `[line:X]` for static highlights) |

### New Components

- **TtsPreloader** - Manages background TTS generation queue with retry logic
- Progress events for timeline UI updates
- Priority boosting when playback starts

### Section Transition Logic

```typescript
// In engine.ts waitForTtsAndScheduleAdvance()
const isInSection = this.currentSectionDepth > 0;
const pauseMs = isInSection ? 100 : 75;
this.scheduleAdvanceWithDelay(pauseMs);
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Trace with 100+ steps | Generate in background, user can play immediately with spinner if needed |
| API key missing | Show error on load, disable TTS, allow visual-only playback |
| Network failure mid-generation | Retry 3x with backoff, then mark step as "no audio" |
| User skips ahead during playback | Cancel current TTS wait, prioritize new step's audio |
| Trace reloaded while generating | Cancel in-progress generation, clear cache, restart |
| Empty narration on step | Skip TTS for that step, use minimal pause |

## Success Criteria

- [ ] Zero Whisper API calls in codebase
- [ ] Playback starts with no perceptible delay (audio pre-cached)
- [ ] Steps within sections feel like one continuous narration
- [ ] Timeline shows generation progress clearly
- [ ] No regressions in existing playback functionality

## Open Questions

- Should we add a "regenerate audio" command for when user edits narration text?
- Should pre-generation be configurable (disable for users who don't use TTS)?
