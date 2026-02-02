# Implementation Strategy: Debrief Publishing Improvements

> Research completed on 2026-02-02
> Spec: .claude/specs/debrief-publishing-improvements.md

## Quick Reference
| Aspect | Detail |
|--------|--------|
| Complexity | Medium |
| Files affected | ~12 |
| Risk level | Low-Medium |

## Project Rules (from CLAUDE.md)
- MUST: Use TTS-first pattern (audio starts before file navigation)
- MUST: Cache TTS results to avoid regeneration
- MUST: Maintain backwards compatibility with existing trace files
- MUST: Use system audio playback (PowerShell on Windows, afplay on macOS)
- MUST: Support `<line:X>text</line:X>` syntax for timed highlights
- MUST NOT: Create mini-map preview (v2)
- MUST NOT: Create breadcrumb trail UI (v2)
- MUST NOT: Change extension name (keeping "Debrief")
- MUST NOT: Implement auto-risk detection (to be removed)

## Implementation Plan

### Work Stream 1: Remove Review/Risk System
**Can run in parallel with Stream 3**

Files:
- DELETE `src/replay/riskDetector.ts`
- MODIFY `src/ui/timelineView.ts` (remove risk imports, review handlers)
- MODIFY `src/replay/engine.ts` (remove review state, event emitter, methods)
- MODIFY `src/trace/types.ts` (remove review types, keep risks field for agent-specified)
- MODIFY `webview/timeline.js` (remove review UI, risk filtering)
- MODIFY `webview/timeline.css` (remove review/risk styles)
- MODIFY `webview/timeline.html` (remove review-bar div)
- MODIFY `package.json` (remove review commands: exportReview, approveCurrentStep, flagCurrentStep)

### Work Stream 2: Add Comment System
**Depends on: Stream 1 (removing review clears the way for comment)**

Files:
- MODIFY `src/trace/types.ts` (add `comment?: string` and `risks?: AgentRisk[]` to TraceEvent)
- MODIFY `webview/timeline.js` (add comment icon button, repurpose comment input)
- MODIFY `webview/timeline.css` (add comment indicator styles)
- MODIFY `src/ui/timelineView.ts` (add saveComment message handler)
- MODIFY `src/replay/engine.ts` (add comment persistence to trace file)

### Work Stream 3: Smooth Transitions
**Independent - can run in parallel with Stream 1**

Files:
- MODIFY `src/replay/handlers/highlightRange.ts` (add file transition indicator, highlight animation)
- MODIFY `src/replay/handlers/openFile.ts` (add file transition indicator)
- MODIFY `src/util/decorations.ts` (add fade-in animation via decoration cycling)

### Work Stream 4: Section Nesting Fix
**Independent - skill file update only**

Files:
- UPDATE `~/.claude/skills/debrief-trace-authoring.md` (enforce max 2-3 level nesting, add explicit risk syntax)

---

## Step-by-Step Details

### Step 1: Delete Risk Detector
**Files:** `src/replay/riskDetector.ts`
**Action:** Delete the entire file (approx 150 lines)

### Step 2: Remove Risk Detector Import and Usage
**Files:** `src/ui/timelineView.ts`
**Action:**
- Remove import: `import { detectRisks } from '../replay/riskDetector';`
- Remove `detectRisks(e)` call in `updateWebview()` (around line 114)
- Remove `risks: detectRisks(e)` from the events map

### Step 3: Remove Review Types
**Files:** `src/trace/types.ts` (lines 110-134)
**Action:** Remove these types:
```typescript
// DELETE these
export type ReviewStatus = 'unreviewed' | 'approved' | 'flagged';
export interface StepReviewState { status: ReviewStatus; comment?: string; }
export interface ReviewChangedEvent { eventId: string; state: StepReviewState; }
export interface ReviewSummary { approved: number; flagged: number; unreviewed: number; }
export interface ReviewExportEntry { eventId: string; status: ReviewStatus; comment?: string; }
```

### Step 4: Add New Types for Comments and Agent Risks
**Files:** `src/trace/types.ts`
**Action:** Add to TraceEvent interface:
```typescript
export interface AgentRisk {
  category: string;  // e.g., "security", "breaking-change", "performance"
  label: string;     // Human-readable description
}

// Add to TraceEvent:
export interface TraceEvent {
  // ... existing fields
  comment?: string;       // User feedback comment
  risks?: AgentRisk[];    // Agent-specified risks (replaces auto-detection)
}
```

### Step 5: Remove Review Methods from Engine
**Files:** `src/replay/engine.ts` (lines 417-471)
**Action:** Remove these methods and properties:
- Property: `reviewStates: Map<string, StepReviewState>`
- Property: `_onReviewChanged: vscode.EventEmitter<ReviewChangedEvent>`
- Getter: `onReviewChanged`
- Method: `approveStep(eventId: string)`
- Method: `flagStep(eventId: string, comment?: string)`
- Method: `clearReview(eventId: string)`
- Method: `getReviewState(eventId: string)`
- Method: `getReviewSummary()`
- Method: `exportReview()`

### Step 6: Add Comment Persistence to Engine
**Files:** `src/replay/engine.ts`
**Action:** Add new method:
```typescript
async saveComment(eventId: string, comment: string): Promise<void> {
  // Find event and update comment
  const event = this.allEvents.find(e => e.id === eventId);
  if (!event) return;

  event.comment = comment || undefined; // Remove if empty

  // Persist to trace file (rewrite JSONL)
  await this.persistTraceFile();
}

private async persistTraceFile(): Promise<void> {
  // Check if file is writable
  // Rewrite JSONL with updated events
  // Handle read-only case with warning
}
```

### Step 7: Update TimelineView Message Handlers
**Files:** `src/ui/timelineView.ts`
**Action:**
- Remove handlers: `approveStep`, `flagStep`, `clearReview`
- Remove: `this.engine.getReviewState(e.id)` from updateWebview
- Remove: `reviewSummary: this.engine.getReviewSummary()`
- Add handler for `saveComment`:
```typescript
case 'saveComment':
  await this.engine.saveComment(msg.eventId, msg.comment);
  this.updateWebview();
  break;
```

### Step 8: Update Webview State
**Files:** `webview/timeline.js`
**Action:**
- Remove state variables: `reviewSummary`, `riskFilterActive`
- Keep: `commentInputEventId` (repurpose for comment editing)
- Remove message commands: `approveStep`, `flagStep`, `clearReview`
- Add message command: `saveComment`

### Step 9: Update Webview Rendering - Remove Review UI
**Files:** `webview/timeline.js`
**Action:**
- Remove: Review bar rendering function
- Remove: Approve/flag buttons from step items
- Remove: Risk badges from step items
- Remove: Risk filter toggle
- Update header subtitle to show comment count instead of review summary

### Step 10: Add Comment UI to Webview
**Files:** `webview/timeline.js`
**Action:**
- Add comment icon button to each step item (speech bubble)
- Repurpose existing comment input (change "Flag" to "Save")
- Show comment indicator when step has comment
- Add comment count to header subtitle

```javascript
// Add to renderStepItem() after title
var commentBtn = document.createElement('button');
commentBtn.className = 'comment-btn' + (event.comment ? ' has-comment' : '');
commentBtn.innerHTML = '&#x1F4AC;';  // speech bubble
commentBtn.title = event.comment ? 'Edit comment' : 'Add comment';
commentBtn.addEventListener('click', function (e) {
  e.stopPropagation();
  commentInputEventId = event.id;
  render();
});
```

### Step 11: Update Webview CSS
**Files:** `webview/timeline.css`
**Action:**
- Remove: `.review-bar`, `.risk-badge`, `.risk-filter`, review status styles
- Add: `.comment-btn`, `.comment-btn.has-comment` styles
- Keep: `.comment-input-row`, `.comment-input`, `.comment-submit` (repurpose)

```css
.comment-btn {
  background: transparent;
  border: none;
  padding: 2px 4px;
  font-size: 0.85em;
  cursor: pointer;
  opacity: 0.3;
  border-radius: 3px;
}
.comment-btn:hover { opacity: 1; background: rgba(255, 255, 255, 0.1); }
.comment-btn.has-comment { opacity: 0.8; color: var(--vscode-charts-blue, #58a6ff); }
```

### Step 12: Update Webview HTML
**Files:** `webview/timeline.html`
**Action:**
- Remove: `<div class="review-bar">...</div>`

### Step 13: Remove Review Commands from package.json
**Files:** `package.json`
**Action:** Remove from `contributes.commands`:
- `debrief.exportReview`
- `debrief.approveCurrentStep`
- `debrief.flagCurrentStep`

### Step 14: Add File Transition Indicator
**Files:** `src/replay/handlers/highlightRange.ts`, `src/replay/handlers/openFile.ts`
**Action:** Add transition indicator when switching files:

```typescript
// Check if switching files
const currentFile = context.engine.currentEvent?.filePath;
if (currentFile && currentFile !== event.filePath) {
  // Show status bar indicator
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.text = `$(arrow-right) ${path.basename(event.filePath)}`;
  statusItem.show();

  // Wait 200-300ms
  await new Promise(r => setTimeout(r, 250));

  statusItem.dispose();
}
```

### Step 15: Add Highlight Animation
**Files:** `src/util/decorations.ts`
**Action:** Add fade-in animation via decoration cycling:

```typescript
private fadeSteps = [0.2, 0.4, 0.6, 0.8, 1.0];
private fadeTypes: vscode.TextEditorDecorationType[] = [];

async applyHighlightWithAnimation(editor: vscode.TextEditor, startLine: number, endLine: number): Promise<void> {
  // Create fade decoration types if not exist
  if (this.fadeTypes.length === 0) {
    this.fadeTypes = this.fadeSteps.map(opacity =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderLeft: `3px solid rgba(56, 139, 253, ${opacity * 0.6})`,
        backgroundColor: `rgba(56, 139, 253, ${opacity * 0.05})`,
      })
    );
  }

  const ranges = this.buildRanges(editor, startLine, endLine);

  // Cycle through fade steps
  for (let i = 0; i < this.fadeTypes.length; i++) {
    if (i > 0) editor.setDecorations(this.fadeTypes[i - 1], []);
    editor.setDecorations(this.fadeTypes[i], ranges);
    await new Promise(r => setTimeout(r, 30)); // 30ms * 5 = 150ms total
  }

  // Apply final stable decoration
  this.clearFadeTypes();
  this.applyHighlight(editor, startLine, endLine);
}

private clearFadeTypes(): void {
  this.fadeTypes.forEach(t => t.dispose());
  this.fadeTypes = [];
}
```

### Step 16: Update Skill File
**Files:** `~/.claude/skills/debrief-trace-authoring.md`
**Action:**
- Add section nesting rules (max 2-3 levels, only when logically parent-child)
- Remove auto-risk detection mention
- Add explicit risk syntax for TraceEvent:
```json
{"type": "highlightRange", "risks": [{"category": "security", "label": "User input not sanitized"}]}
```

---

## Utilities to Reuse
| Utility | Import | Usage |
|---------|--------|-------|
| DecorationManager | `src/util/decorations.ts` | Apply/clear line highlights, add animation |
| parseLegacyLineReferences | `src/util/lineRefParser.ts` | Extract `<line:X>` from narration |
| getHandler | `src/replay/handlers/index.ts` | Lookup handler by event type |
| TtsPlayer | `src/audio/ttsPlayer.ts` | Async TTS playback |
| FollowModeController | `src/replay/followMode.ts` | Track follow mode state |
| InlineCardController | `src/ui/inlineCard.ts` | Show step info cards |

## Edge Cases
| Case | Handling |
|------|----------|
| Existing traces with review data | Ignore on load (backward compatible) |
| Existing traces with auto-detected risks | Ignore; only agent-specified risks shown |
| Deeply nested sections (legacy) | Show all but log warning |
| Read-only trace files | Warn user; disable comment saving |
| Empty comment submitted | Don't save; treat as no comment |
| Same file, different line | No transition indicator; still animate highlight |
| Comment on sectionStart/sectionEnd | Allow; save to trace |

## Testing Plan
| Test | Description |
|------|-------------|
| Load trace without review | Verify no review UI appears, no errors |
| Load trace with old review data | Verify ignored gracefully, no UI |
| Add comment | Verify saved to trace file |
| Edit comment | Verify updated in trace file |
| Clear comment (empty) | Verify removed from trace file |
| Navigate between files | Verify transition indicator shows ~250ms |
| Navigate same file | Verify no transition indicator |
| Highlight animation | Verify fade-in over ~150ms |
| Load deeply nested trace | Verify renders without breaking; log warning |
| Read-only trace file | Verify warning shown, comment disabled |
| vsce package | Verify passes without errors |

## Risks
| Risk | Mitigation |
|------|------------|
| Breaking existing traces | Keep backward compat; comment/risks are optional |
| Comment persistence failure | Handle write errors gracefully; warn user |
| Animation performance | Use minimal decoration types; clean up properly |
| Decoration type leak | Dispose fade types after animation completes |
| Status bar indicator flicker | Use consistent timing; single indicator instance |

## Execution Order

1. **Stream 1 + Stream 3** (parallel)
   - Stream 1: Remove review/risk system (Steps 1-13)
   - Stream 3: Add smooth transitions (Steps 14-15)

2. **Stream 2** (depends on Stream 1)
   - Add comment system (Steps 4, 6, 7, 10-11)

3. **Stream 4** (independent, can be done anytime)
   - Update skill file (Step 16)

4. **Final verification**
   - Run `npm run build`
   - Run `npm run package`
   - Test in Extension Development Host
