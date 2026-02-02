# TTS System Bug Analysis - Deep Pattern Mining

## Executive Summary

After analyzing the actual implementation, I identified **three root causes** for the reported issues:
1. **Robotic Voice**: Speed 1.15x + voice choice + timing inconsistency with Whisper
2. **Large Gaps Between Sections**: Fixed 1500ms delay for non-narration events, 150ms pause after TTS
3. **Highlights Not Synced**: Hardcoded platform startup delays, race condition in callback timing

---

## Bug #1: Robotic Voice

### Root Cause
The TTS audio is generated at 1.15x speed, but Whisper transcription returns timings based on the **actual audio playback duration**, which has already been sped up. This creates a mismatch.

### Evidence

**File: `src/audio/ttsPlayer.ts` lines 46-47, 427-432**
```typescript
// Line 47: Default speed
private speed: number = 1.15;

// Lines 427-432: TTS generation with speed
body: JSON.stringify({
  model: 'tts-1-hd',
  voice: this.voice,
  input: text,
  response_format: 'mp3',
  speed: this.speed,  // <-- 1.15x makes it faster and less natural
}),
```

**Impact:**
- 1.15x speed is 15% faster than natural speech
- While OpenAI's TTS-1-HD is high quality, speeding it up reduces prosody naturalness
- The speed increase cascades to Whisper timings (timings are correct for the sped-up audio)

### Secondary Issue: Voice Selection
**File: `src/audio/ttsPlayer.ts` line 46**
```typescript
private voice: TtsVoice = 'alloy';
```
- `alloy` is described as "neutral, balanced" - not the most natural for code narration
- Voices like `nova` (warm, expressive) or `shimmer` (softer) might sound less robotic

---

## Bug #2: Large Gaps Between Sections

### Root Cause
Fixed, non-configurable pause timings that don't adapt to content type.

### Evidence

**File: `src/replay/engine.ts` lines 294-316**
```typescript
private waitForTtsAndScheduleAdvance(event: TraceEvent): void {
  // BUG: 1500ms fixed delay for ANY event without narration
  if (!event.narration) {
    this.scheduleAdvanceWithDelay(1500);  // <-- TOO LONG!
    return;
  }

  // ... TTS completion listener ...

  ({ requestId, cancelled }) => {
    if (requestId === this._waitingForTtsRequestId && this._playState === 'playing') {
      this.clearTtsCompletionListener();

      // BUG: Fixed 150ms pause after every TTS completion
      const pauseAfterTts = cancelled ? 50 : 150;  // <-- Adds up over many steps
      this.scheduleAdvanceWithDelay(pauseAfterTts);
    }
  }
```

**Problems Identified:**

1. **1500ms for non-narration events** (line 297):
   - `sectionStart`, `sectionEnd`, `openFile` events with no narration get 1500ms pause
   - This is excessive for visual-only events like opening a file or marking section boundaries

2. **150ms after every TTS completion** (line 315):
   - Adds 150ms gap after each narrated step
   - With 10 narrated steps, that's 1.5 seconds of extra silence

3. **No event-type-specific timing**:
   - All events treated equally regardless of type
   - A `sectionEnd` marker should have minimal delay, not 1500ms

### Timeline Example (10 steps with mixed content):
```
Step 1 (highlightRange, narration):  TTS completes + 150ms
Step 2 (sectionEnd, no narration):   1500ms  <-- EXCESSIVE
Step 3 (sectionStart, no narration): 1500ms  <-- EXCESSIVE
Step 4 (highlightRange, narration):  TTS completes + 150ms
...
```
Total "dead air" for 2 section markers alone: 3 seconds

---

## Bug #3: Highlights Not Synced with Speech

### Root Cause A: Hardcoded Platform Startup Delays

**File: `src/audio/ttsPlayer.ts` lines 472-497**
```typescript
if (platform === 'win32') {
  // Windows: PowerShell + MediaPlayer has significant startup latency
  command = 'powershell';
  args = [
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Add-Type -AssemblyName presentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([Uri]'${filePath.replace(/'/g, "''")}'); $player.Play(); Start-Sleep -Milliseconds 500; ...`
  ];
  // BUG: Estimated value, not measured
  startupDelayMs = 700;  // <-- UNRELIABLE ESTIMATE
} else if (platform === 'darwin') {
  command = 'afplay';
  args = [filePath];
  startupDelayMs = 50;
} else {
  command = 'paplay';
  args = [filePath];
  startupDelayMs = 100;
}
```

**Problems:**

1. **700ms Windows delay is an estimate, not measured**:
   - PowerShell startup time varies by system load
   - First invocation is slower (cold start)
   - Assembly loading (`Add-Type`) adds variable latency
   - Actual startup can range 400-1200ms

2. **No verification that audio actually started**:
   - `setTimeout(onAudioStart, startupDelayMs)` fires at estimated time
   - No feedback loop to confirm audio is playing
   - If audio starts late, highlights appear early
   - If audio starts early, highlights appear late

### Root Cause B: Race Condition in Callback Timing

**File: `src/audio/ttsPlayer.ts` lines 205-215**
```typescript
// Play the audio - fire callback AFTER playback actually starts
// This is critical: setTimeout timers in the scheduler must be synchronized
try {
  await this.playAudioFileWithCallback(audioFilePath, () => {
    // Fire callback when audio actually starts playing
    if (requestId === this.currentRequestId) {
      onTimingsReady({ requestId, wordTimings, duration });  // <-- Called after setTimeout delay
    }
  });
```

**File: `src/audio/ttsPlayer.ts` lines 507-514**
```typescript
// Fire the callback after the estimated startup delay
if (onAudioStart) {
  setTimeout(() => {
    this.outputChannel.appendLine(`[TtsPlayer] Audio started (after ${startupDelayMs}ms delay)`);
    onAudioStart();  // <-- This triggers highlight scheduling
  }, startupDelayMs);
}
```

**The Race Condition:**
1. `playAudioFileWithCallback()` spawns the audio process
2. A `setTimeout(onAudioStart, 700)` is set for the callback
3. The highlight scheduler then uses `setTimeout(highlightEvent, timeFromWordTiming * 1000)`
4. But `timeFromWordTiming` is relative to audio start, and our estimate of audio start is off

**Concrete Example:**
- Word "function" has Whisper timing: `{start: 1.5, end: 1.9}` (1.5 seconds into audio)
- Highlight should fire at 1.5 seconds after audio starts
- If we fire `onTimingsReady` at 700ms but audio actually started at 850ms:
  - Scheduler sets `setTimeout(highlight, 1500)` at T=700ms
  - Highlight fires at T=2200ms
  - But audio says "function" at T=850ms + 1500ms = T=2350ms
  - **Result: Highlight appears 150ms BEFORE the word is spoken**

### Root Cause C: Silent Failures in Word Matching

**File: `src/util/highlightTimeline.ts` lines 50-59**
```typescript
for (const ref of lineRefs) {
  const startResult = findWordTimingRobust(
    whisperWords,
    ref.startWord,
    searchStartIndex
  );

  if (!startResult) {
    // BUG: Silent failure - no logging, no fallback
    continue;  // <-- HIGHLIGHT JUST DOESN'T HAPPEN
  }
```

**Problems:**
1. If Whisper transcribes differently than expected, the word match fails silently
2. No diagnostic output to help debug which words failed
3. User sees missing highlights with no explanation

**Example Failure:**
- Narration: `<line:42>This function retries</line:42> on failure`
- TTS speaks: "This function retries on failure"
- Whisper transcribes: "This function re-tries on failure" (hyphenated)
- Word match for "retries" fails against "re-tries"
- Line 42 never gets highlighted - silently dropped

---

## Timing Flow Diagram

```
T=0ms     spawn(powershell, [...])
          |
T=0ms     setTimeout(onAudioStart, 700)
          |
T=700ms   onAudioStart() fires
          |-- buildHighlightTimeline()
          |-- scheduler.schedule(events)
          |     `-- setTimeout(line42.start, 1200)  // 1.2s from Whisper
          |     `-- setTimeout(line42.end, 1800)    // 1.8s from Whisper
          |
T=850ms   [ACTUAL] PowerShell MediaPlayer starts playing audio
          |
T=1900ms  setTimeout fires for line42.start  (scheduled at 700+1200)
          |-- BUT audio is only at T=1900-850 = 1050ms position
          |-- Whisper says word at 1200ms, so highlight is 150ms early
          |
T=2050ms  [ACTUAL] Audio reaches word at position 1200ms (850+1200)
          |-- Highlight was already showing for 150ms!
```

---

## Summary of Bugs

| Issue | File | Line(s) | Problem | Fix Approach |
|-------|------|---------|---------|--------------|
| Robotic voice | ttsPlayer.ts | 47, 432 | Speed 1.15x too fast | Reduce to 1.0 or 1.05 |
| Robotic voice | ttsPlayer.ts | 46 | Voice 'alloy' is neutral | Consider 'nova' or 'onyx' |
| Large gaps | engine.ts | 297 | 1500ms for non-narration | Reduce to 300-500ms |
| Large gaps | engine.ts | 315 | 150ms pause after TTS | Reduce to 50-100ms |
| Sync offset | ttsPlayer.ts | 486 | 700ms estimate inaccurate | Measure actual start time |
| Sync offset | ttsPlayer.ts | 509-513 | setTimeout, not event-based | Use process stdout/ready signal |
| Silent failure | highlightTimeline.ts | 56-59 | No logging on match failure | Add diagnostic logging |

---

## Priority Fix Recommendations

### High Priority (User-Facing Quality)
1. **Reduce TTS speed to 1.0** - Immediate improvement in naturalness
2. **Reduce non-narration delay to 300ms** - Eliminates most "dead air"
3. **Add word match failure logging** - Enables debugging sync issues

### Medium Priority (Sync Accuracy)
4. **Add platform-specific audio start detection** - Windows: parse MediaPlayer ready output
5. **Implement offset calibration** - Let user tweak delay via settings

### Lower Priority (Polish)
6. **Make voice configurable with better default** - 'nova' recommended
7. **Make pause durations configurable** - Power users can tune
8. **Add per-event-type timing** - sectionEnd: 100ms, openFile: 200ms, etc.
