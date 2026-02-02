# TTS System Fix Strategy

## Executive Summary

After analyzing the research and source code, the three reported issues have clear root causes with straightforward fixes. The architecture is fundamentally sound - this is a **bugs and tuning problem**, not a design flaw.

---

## Root Cause Analysis

### Issue 1: Robotic Voice

**Root Cause**: Speed 1.15x makes speech unnaturally fast.

**Evidence** (`src/audio/ttsPlayer.ts` line 47):
```typescript
private speed: number = 1.15;
```

The 15% speedup reduces prosody and natural pauses. OpenAI's TTS-1-HD model produces natural speech at 1.0x, but acceleration removes the subtle variations that make speech sound human.

**Fix**: Change default speed from `1.15` to `1.0`.

---

### Issue 2: Large Gaps Between Sections

**Root Cause**: Excessive fixed delays for non-narration events (1500ms) and post-TTS pauses (150ms).

**Evidence** (`src/replay/engine.ts` lines 294-316):
```typescript
// Line 297: 1500ms for ANY event without narration
if (!event.narration) {
  this.scheduleAdvanceWithDelay(1500);
  return;
}
// Line 315: 150ms pause after every TTS completion
const pauseAfterTts = cancelled ? 50 : 150;
```

A `sectionStart` or `sectionEnd` marker with no narration waits 1500ms - excessive for visual-only events. The 150ms post-TTS delay compounds over many steps.

**Fix**:
1. Reduce non-narration delay from 1500ms to 500ms
2. Reduce post-TTS pause from 150ms to 75ms

---

### Issue 3: Highlights Not Synced with Speech

**Root Cause**: The 700ms Windows startup delay is a hardcoded estimate that doesn't match actual audio start time. When the estimate is wrong, all highlight timings shift.

**Evidence** (`src/audio/ttsPlayer.ts` lines 486, 509-513):
```typescript
startupDelayMs = 700;  // Hardcoded estimate
// ...
setTimeout(() => {
  onAudioStart();  // Triggers highlight scheduling
}, startupDelayMs);
```

If PowerShell actually starts audio at 850ms (not 700ms), every highlight fires 150ms early. This creates the "highlights appear before words are spoken" effect.

**Secondary Issue**: Word matching failures in `highlightTimeline.ts` silently drop highlights - no diagnostic logging to help debug.

**Fix**:
1. Add configurable offset to compensate for timing variance
2. Add diagnostic logging for word match failures
3. Consider conservative offset (highlights slightly late > slightly early)

---

## Prioritized Fix Plan

### Phase 1: Quick Wins (Immediate Impact)

These changes require minimal code and immediately improve user experience.

#### Fix 1.1: Reduce TTS Speed to 1.0x

**File**: `src/audio/ttsPlayer.ts`
**Line**: 47

**Change**:
```typescript
// Before
private speed: number = 1.15;

// After
private speed: number = 1.0;
```

**Also update** `package.json` default:
```json
"debrief.ttsSpeed": {
  "default": 1.0,
  ...
}
```

**Impact**: Voice sounds more natural immediately.

---

#### Fix 1.2: Reduce Non-Narration Delay

**File**: `src/replay/engine.ts`
**Line**: 297

**Change**:
```typescript
// Before
this.scheduleAdvanceWithDelay(1500);

// After
this.scheduleAdvanceWithDelay(500);
```

**Impact**: Eliminates 1+ second gaps between sections.

---

#### Fix 1.3: Reduce Post-TTS Pause

**File**: `src/replay/engine.ts`
**Line**: 315

**Change**:
```typescript
// Before
const pauseAfterTts = cancelled ? 50 : 150;

// After
const pauseAfterTts = cancelled ? 25 : 75;
```

**Impact**: Smoother transitions between narrated steps.

---

### Phase 2: Sync Accuracy Improvements

#### Fix 2.1: Add User-Configurable Highlight Offset

**File**: `package.json` - Add new setting:
```json
"debrief.highlightOffsetMs": {
  "type": "number",
  "default": 0,
  "minimum": -500,
  "maximum": 500,
  "description": "Adjust highlight timing offset in milliseconds. Positive = highlights appear later, negative = earlier."
}
```

**File**: `src/audio/ttsPlayer.ts` - Load and apply the offset:
```typescript
// In loadConfig():
this.highlightOffset = config.get<number>('highlightOffsetMs', 0);

// In playAudioFileWithCallback():
const adjustedDelay = startupDelayMs + this.highlightOffset;
setTimeout(() => {
  onAudioStart();
}, adjustedDelay);
```

**Impact**: Users can tune sync on their specific system.

---

#### Fix 2.2: Conservative Windows Delay

**File**: `src/audio/ttsPlayer.ts`
**Line**: 486

**Change**:
```typescript
// Before
startupDelayMs = 700;

// After
startupDelayMs = 850;  // More conservative - better late than early
```

**Rationale**: Highlights appearing 100ms after the word is spoken feels more natural than highlights appearing before. The human brain expects visuals to follow audio.

---

#### Fix 2.3: Add Word Match Failure Logging

**File**: `src/util/highlightTimeline.ts`
**Around line 56-59**

**Change**:
```typescript
// Before
if (!startResult) {
  continue;
}

// After
if (!startResult) {
  console.warn(`[HighlightTimeline] Failed to match word "${ref.startWord}" for line ${ref.line}`);
  continue;
}
```

**Impact**: Developers can diagnose why specific highlights aren't appearing.

---

### Phase 3: Architecture Improvements (Optional)

These are more involved changes for future consideration.

#### 3.1: Event-Type-Specific Timing

Replace the single non-narration delay with per-event-type delays:

```typescript
const eventDelays: Record<string, number> = {
  sectionStart: 300,
  sectionEnd: 200,
  openFile: 400,
  default: 500,
};

const delay = eventDelays[event.type] ?? eventDelays.default;
this.scheduleAdvanceWithDelay(delay);
```

#### 3.2: Polling-Based Sync (Eliminates Drift)

Replace setTimeout-based scheduling with requestAnimationFrame polling that checks against a clock reference. This eliminates timer drift but adds complexity.

**Recommendation**: Defer unless Phase 2 fixes don't achieve acceptable sync.

---

## Implementation Checklist

### Phase 1 (Do First)
- [ ] Change `speed` default from 1.15 to 1.0 in `ttsPlayer.ts` line 47
- [ ] Update `package.json` ttsSpeed default to 1.0
- [ ] Change non-narration delay from 1500 to 500 in `engine.ts` line 297
- [ ] Change post-TTS pause from 150 to 75 in `engine.ts` line 315

### Phase 2 (Do After Testing Phase 1)
- [ ] Add `highlightOffsetMs` setting to `package.json`
- [ ] Load and apply offset in `ttsPlayer.ts`
- [ ] Increase Windows `startupDelayMs` from 700 to 850
- [ ] Add word match failure logging in `highlightTimeline.ts`

### Testing Protocol
1. Load a trace with mixed narrated/non-narrated events
2. Play through and verify:
   - Voice sounds natural (not rushed)
   - No long pauses between sections
   - Highlights appear in sync with spoken words (or slightly after)
3. Test on Windows specifically for sync accuracy

---

## Summary

| Issue | Root Cause | Fix | LOC Changed |
|-------|------------|-----|-------------|
| Robotic voice | Speed 1.15x | Change to 1.0x | 2 |
| Large gaps | 1500ms/150ms delays | Reduce to 500ms/75ms | 2 |
| Sync issues | Hardcoded 700ms estimate | Increase to 850ms + add offset setting | ~10 |

**Total estimated changes**: ~15 lines of code

The fixes are minimal, targeted, and don't require architectural changes. The existing system design is correct - it just needs tuning.
