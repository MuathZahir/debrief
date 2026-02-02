# TTS Synchronization Research Findings

## 1. OpenAI TTS API Best Practices

### Voice Quality and Selection

**Current Issue**: Using `alloy` voice at 1.15x speed, reported as robotic-sounding.

**Research Findings**:
- **tts-1-hd** (currently used) is optimized for quality over latency - good for narration use cases
- **Speed 1.15x** may contribute to robotic sound; natural speech is typically at **1.0x**
- **Voice characteristics**:
  - `alloy` - Neutral, balanced, could pass as either gender
  - `nova` - Feminine, often reported as more natural/warm
  - `shimmer` - Feminine voice option
  - `echo` - Masculine voice
  - OpenAI recommends **`marin`** or **`cedar`** for best quality (newer voices)

**Recommendations**:
1. Reduce speed to **1.0x** for more natural sound
2. Consider switching to `nova` or `marin` voice
3. Test with `gpt-4o-mini-tts` model for steerability (can prompt for tone/emotion)

### gpt-4o-mini-tts Model (Newer Alternative)

- Supports **steerability** through prompts: control tone, emotion, pacing, accent
- Example: "Speak in a calm, friendly tone" as instruction
- Mean Opinion Score: 4.2/5 (vs 3.8/5 for Google WaveNet)
- Price: $0.015/minute
- **Note**: Speed parameter may be ignored in this model - use prompt instructions instead

**Trade-off**: `tts-1-hd` has more reliable speed control, `gpt-4o-mini-tts` has better natural delivery via prompting.

### Speed Parameter

| Speed | Use Case |
|-------|----------|
| 0.75-0.9 | Slow, deliberate narration |
| 1.0 | Natural conversational pace |
| 1.1-1.25 | Slightly faster, but risks robotic sound |
| 1.5+ | Noticeably fast, suitable for quick playback |

**Source**: [OpenAI Audio API Reference](https://platform.openai.com/docs/api-reference/audio/createSpeech)

---

## 2. Audio-Visual Synchronization Patterns

### The Core Problem

The current implementation uses `setTimeout`-based scheduling with estimated startup delays (700ms Windows, 50ms macOS). This approach has fundamental issues:

1. **JavaScript timers are imprecise**: `setTimeout` uses the main thread and can be delayed by layout, garbage collection, or other JS execution
2. **Fixed delays don't adapt**: Estimated startup times (700ms) are approximations that vary per system
3. **No feedback loop**: No mechanism to detect if audio started earlier/later than expected

### The "Tale of Two Clocks" Pattern

**Key Insight**: There are two separate timing systems:
1. **JavaScript clock** (`setTimeout`, `Date.now()`) - imprecise, main thread
2. **Audio clock** (`audioContext.currentTime`) - hardware-based, high precision

**Best Practice**: Use the **audio clock as the master** and have JavaScript poll it for visual updates.

### Recommended Implementation Pattern

```javascript
// BAD: Direct setTimeout scheduling (current approach)
setTimeout(() => highlightLine(42), wordTiming.start * 1000);

// GOOD: Poll audio time with requestAnimationFrame
function syncHighlights() {
  const currentAudioTime = audioContext.currentTime - audioStartTime;

  // Find which highlights should be active at this time
  const activeHighlights = timeline.filter(h =>
    h.startTime <= currentAudioTime && h.endTime > currentAudioTime
  );

  updateHighlights(activeHighlights);

  if (isPlaying) {
    requestAnimationFrame(syncHighlights);
  }
}
```

### Lookahead Scheduling (For Precise Audio Events)

If scheduling audio events (not visual), use lookahead:

```javascript
const lookahead = 25; // ms - how often to check
const scheduleAheadTime = 0.1; // seconds - how far ahead to schedule

function scheduler() {
  while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) {
    scheduleNote(nextNoteTime);
    advanceNote();
  }
  setTimeout(scheduler, lookahead);
}
```

**Source**: [A Tale of Two Clocks](https://web.dev/articles/audio-scheduling)

### requestAnimationFrame vs setTimeout

| Aspect | setTimeout | requestAnimationFrame |
|--------|------------|----------------------|
| Precision | ~10-15ms typical, can drift | Synced to display refresh (16.67ms @ 60Hz) |
| CPU Usage | Runs in background tabs | Pauses in background (efficient) |
| Visual Sync | Not aligned with repaint | Fires just before repaint |
| Audio Sync | Poor | Good when polling audio clock |

**Key Point**: `requestAnimationFrame` provides the smoothest visual sync because it runs just before the browser paints.

### Web Workers for Better Timer Accuracy

`setTimeout` in a Web Worker is much more accurate than in the main thread:

```javascript
// In a Worker
setInterval(() => {
  self.postMessage({ type: 'tick', time: performance.now() });
}, 10);
```

Workers avoid main thread congestion from DOM operations.

**Source**: [HackWild - Web Worker Timers](https://hackwild.com/article/web-worker-timers/)

---

## 3. Whisper Word Timing Accuracy

### Key Limitations

**Critical Finding**: Whisper is **not explicitly trained for word-level timestamps**. Current outputs are produced by inference-time tricks.

**Known Issues**:
1. Timestamps tend to be integers, especially `0.0` for initial timestamp
2. Words often appear to start **before** they're actually spoken
3. Pauses cause inaccurate timing
4. Accuracy is at utterance-level, not word-level (can be off by several seconds)

### How Whisper Generates Word Timestamps

- Uses Dynamic Time Warping (DTW) on cross-attention weights
- Aligns text tokens with audio frames
- Not trained specifically for this - it's a post-hoc alignment

### Improved Alternatives

| Tool | Approach | Benefits |
|------|----------|----------|
| **WhisperX** | wav2vec2 alignment after Whisper | More accurate word boundaries |
| **whisper-timestamped** | DTW on cross-attention | Better than base Whisper |
| **stable-ts** | Stabilizes timestamps | Ensures chronological order |

### Workaround: VAD Preprocessing

Voice Activity Detection (VAD) preprocessing helps significantly:
- Cut silent parts before processing
- Whisper returns much shorter, more accurate segments
- Helps with hallucination issues too

**Source**: [Improving Timestamp Accuracy - GitHub Discussion](https://github.com/openai/whisper/discussions/435)

---

## 4. Practical Solutions for Current Issues

### Issue 1: Robotic Voice

**Root Cause**: 1.15x speed + alloy voice combination

**Fixes** (in priority order):
1. **Reduce speed to 1.0** - most impactful change
2. **Try `nova` voice** - warmer, more natural
3. **Consider `gpt-4o-mini-tts`** with prompt: "Speak naturally in a clear, friendly tone"

### Issue 2: Large Gaps Between Sections

**Root Cause**: Fixed delays (150ms post-TTS, 1500ms no-narration)

**Fixes**:
1. Reduce post-TTS pause from 150ms to 50-100ms
2. Reduce no-narration delay from 1500ms to 500-800ms
3. Consider **preloading** next section's audio while current is playing
4. Allow audio of next step to start slightly before previous ends (crossfade)

### Issue 3: Highlights Not Synced with Speech

**Root Causes**:
1. Fixed startup delay (700ms Windows) is inaccurate
2. `setTimeout`-based scheduling drifts
3. Whisper word timings have inherent inaccuracy

**Recommended Architecture Change**:

```
Current (setTimeout-based):
  Audio starts -> setTimeout(highlightLine, delay) -> highlights fire independently

Proposed (polling-based):
  Audio starts -> requestAnimationFrame loop polls audio.currentTime ->
  highlights update based on actual audio position
```

**Implementation Steps**:
1. Track actual audio start time (not estimated)
2. Use `requestAnimationFrame` loop during playback
3. Each frame: check `currentTime` against highlight timeline
4. Update highlights based on actual audio position
5. Provides natural drift correction

### For VS Code Extension (No Web Audio API)

Since the extension uses system audio players (PowerShell/afplay), not Web Audio API:

**Alternative Approaches**:
1. **Self-adjusting timers**: Compare elapsed time to expected, adjust future timeouts
2. **Start time detection**: Use audio player callbacks if available (afplay has none)
3. **Conservative delays**: Slightly delay highlights rather than risk them being early

**Windows PowerShell Approach**:
```javascript
// Instead of fixed 700ms, measure actual start
const startTime = Date.now();
// ... spawn process ...
// On first audio frame/event, calculate actual delay
const actualDelay = Date.now() - startTime;
// Adjust all subsequent timings by (actualDelay - expectedDelay)
```

---

## 5. Summary of Recommendations

### Quick Wins
1. Change `ttsSpeed` default from 1.15 to **1.0**
2. Change `ttsVoice` default from `alloy` to **`nova`**
3. Reduce inter-section pause from 150ms to **75ms**

### Medium-Effort Improvements
1. Add self-adjusting timer mechanism
2. Implement audio preloading for smoother transitions
3. Add buffer time (50-100ms) to word timing starts

### Architectural Changes
1. Replace `setTimeout` scheduling with `requestAnimationFrame` polling
2. Track actual vs expected timing for drift correction
3. Consider Web Worker for more accurate background timing

### Research Sources

- [OpenAI TTS Guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API Reference](https://platform.openai.com/docs/api-reference/audio/createSpeech)
- [A Tale of Two Clocks - Web Audio Scheduling](https://web.dev/articles/audio-scheduling)
- [requestAnimationFrame vs setTimeout](https://blog.openreplay.com/requestanimationframe-settimeout-use/)
- [Web Audio Best Practices - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
- [Whisper Timestamp Accuracy Discussion](https://github.com/openai/whisper/discussions/435)
- [WhisperX - Improved Word Timestamps](https://github.com/m-bain/whisperX)
- [Web Worker Timers](https://hackwild.com/article/web-worker-timers/)
- [GPT-4o-mini-TTS Steerability](https://blog.promptlayer.com/gpt-4o-mini-tts-steerable-low-cost-speech-via-simple-apis/)
