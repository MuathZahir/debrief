# TTS System Structure Analysis

## File Map

### Audio Generation & Playback
| File | Purpose |
|------|---------|
| `src/audio/ttsPlayer.ts` | Core TTS: OpenAI API, Whisper transcription, audio playback |

### Highlight Synchronization
| File | Purpose |
|------|---------|
| `src/util/lineRefParser.ts` | Parse `<line:X>text</line:X>` and `[line:X]` syntax |
| `src/util/highlightTimeline.ts` | Build timeline events from word timings + line refs |
| `src/util/highlightScheduler.ts` | Schedule/fire highlight events via setTimeout |
| `src/util/decorations.ts` | Apply VS Code line decorations |

### Replay Handlers (TTS Consumers)
| File | Purpose |
|------|---------|
| `src/replay/handlers/highlightRange.ts` | Main handler: file nav + TTS + timed highlights |
| `src/replay/handlers/say.ts` | Narration-only (no file), strips line refs |
| `src/replay/engine.ts` | Playback state machine, waits for TTS completion |

---

## Data Flow: Narration to Synchronized Highlights

```
[Trace Event with narration]
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ highlightRange.ts / say.ts handler                  │
│ 1. Parse narration with parseLineReferences()      │
│    - Extract <line:X>text</line:X> → LineReference[]│
│    - Generate cleanText (markers removed)          │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│ ttsPlayer.speakAsyncWithTimings()                   │
│ 1. Generate TTS via OpenAI TTS API (tts-1-hd)      │
│ 2. Transcribe audio via Whisper → WordTiming[]     │
│ 3. Cache both audio file and word timings          │
│ 4. Start system audio player (PowerShell/afplay)   │
│ 5. After startupDelayMs, fire onTimingsReady CB    │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│ buildHighlightTimeline() [highlightTimeline.ts]     │
│ 1. Match LineReference words → WordTiming entries   │
│ 2. Build HighlightEvent[] {time, type, line}       │
│ 3. Sort events (end before start at same time)     │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│ HighlightScheduler.schedule()                       │
│ 1. setTimeout for each HighlightEvent              │
│ 2. On fire: add/remove line from activeLines       │
│ 3. Call decorationManager.applyLineReferences()    │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────┐
│ DecorationManager.applyLineReferences()             │
│ 1. Create amber TextEditorDecorationType           │
│ 2. Apply to specified lines in editor              │
└─────────────────────────────────────────────────────┘
```

---

## Key Components Detail

### TtsPlayer (src/audio/ttsPlayer.ts)

**Configuration:**
- Voice: configurable (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`)
- Speed: default 1.15x
- Model: `tts-1-hd`

**Audio Playback:**
- Windows: PowerShell + MediaPlayer (`startupDelayMs = 700ms`)
- macOS: afplay (`startupDelayMs = 50ms`)
- Linux: paplay/aplay (`startupDelayMs = 100ms`)

**Critical Timing Issue:**
```typescript
// Line 509-513: Callback fires after estimated startup delay
if (onAudioStart) {
  setTimeout(() => {
    onAudioStart();  // Triggers highlight scheduling
  }, startupDelayMs);
}
```

**Events:**
- `onPlaybackComplete` - fired when audio ends or is cancelled

### Word-to-Timeline Matching (highlightTimeline.ts)

**Matching Strategy:**
1. Normalize words (lowercase, strip punctuation)
2. Search forward from last match position
3. Match types: exact, partial (contains), fuzzy (Levenshtein ≤1)

**Fallback for missing end word:**
```typescript
const avgWordDuration = 0.35; // 350ms per word estimate
const estimatedEnd = startResult.timing.start + (wordCount * avgWordDuration);
```

### Engine Playback (engine.ts)

**Auto-advance Logic:**
1. After step handler completes, call `waitForTtsAndScheduleAdvance()`
2. Listen for `ttsPlayer.onPlaybackComplete`
3. On completion, wait 150ms (or 50ms if cancelled), then advance
4. Fallback timeout: 60 seconds max wait

**Pause Between Sections:**
- No narration events: 1500ms delay before advance
- After TTS: 150ms pause

---

## Identified Problem Areas

### 1. Robotic Voice
**Location:** `ttsPlayer.ts` line 428-433
```typescript
body: JSON.stringify({
  model: 'tts-1-hd',
  voice: this.voice,      // Default: 'alloy'
  speed: this.speed,      // Default: 1.15
})
```
**Issues:**
- Speed 1.15x may sound unnatural
- Voice choice affects naturalness

### 2. Large Gaps Between Sections
**Location:** `engine.ts` lines 294-332
```typescript
// No narration: 1500ms delay
if (!event.narration) {
  this.scheduleAdvanceWithDelay(1500);
  return;
}
// After TTS: 150ms pause
const pauseAfterTts = cancelled ? 50 : 150;
```
**Issues:**
- Fixed 1500ms for non-narration events
- No configuration for gap duration

### 3. Highlight Sync Issues
**Location:** `ttsPlayer.ts` lines 472-497
```typescript
// Platform-specific startup delay estimates
if (platform === 'win32') {
  startupDelayMs = 700;  // PowerShell startup assumption
} else if (platform === 'darwin') {
  startupDelayMs = 50;
}
```
**Issues:**
- Hardcoded delay estimates may not match actual audio start
- PowerShell MediaPlayer has variable initialization time
- No feedback loop to verify audio actually started

**Location:** `highlightTimeline.ts` - word matching
```typescript
// If word not found, entire line ref is skipped
if (!startResult) {
  continue;  // Silent failure - highlight never scheduled
}
```

---

## Configuration Points

| Setting | Location | Default |
|---------|----------|---------|
| `debrief.enableTts` | VS Code config | true |
| `debrief.ttsVoice` | VS Code config | 'alloy' |
| `debrief.ttsSpeed` | VS Code config | 1.15 |
| `debrief.openaiApiKey` | VS Code config / env | - |

---

## Summary

The TTS sync system has a complex timing chain:
1. TTS generation (network latency)
2. Whisper transcription (network latency)
3. Audio player startup (platform-specific, estimated)
4. setTimeout-based highlight scheduling

Key vulnerabilities:
- **Startup delay estimation** is the weakest link for sync accuracy
- **Word matching failures** cause silent highlight drops
- **Fixed pause timings** (1500ms, 150ms) cause perceived gaps
- **Speed 1.15x** may contribute to robotic feel
