# Pattern Analysis: Debrief Publishing Improvements

## Reference Implementations

### 1. Webview Message Passing

**Extension -> Webview**

**File:** `src/ui/timelineView.ts`
**Key pattern:**
```typescript
// Push state updates to webview
private updateWebview(): void {
  if (!this.view) {
    return;
  }

  this.view.webview.postMessage({
    command: 'updateState',
    events: this.engine.allEvents.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      narration: e.narration,
      filePath: e.filePath,
      risks: detectRisks(e),        // TO REMOVE
      review: this.engine.getReviewState(e.id),  // TO REMOVE
    })),
    currentIndex: this.engine.currentIndex,
    playState: this.engine.playState,
    reviewSummary: this.engine.getReviewSummary(),  // TO REMOVE
  });
}

// Clear webview state
private clearWebview(): void {
  this.view.webview.postMessage({ command: 'clearSession' });
}

// Progress events
this.view.webview.postMessage({
  command: 'updatePregenProgress',
  current: progress.current,
  total: progress.total,
  status: progress.status,
});
```

**Webview -> Extension**

**File:** `webview/timeline.js`
**Key pattern:**
```javascript
// Get VS Code API at the top of the IIFE
const vscode = acquireVsCodeApi();

// Send commands to extension
vscode.postMessage({ command: 'goToStep', index: index });
vscode.postMessage({ command: 'previous' });
vscode.postMessage({ command: 'next' });
vscode.postMessage({ command: 'togglePlayPause' });
vscode.postMessage({ command: 'approveStep', eventId: event.id });  // TO REMOVE
vscode.postMessage({ command: 'flagStep', eventId: event.id, comment: input.value });  // TO REMOVE
vscode.postMessage({ command: 'clearReview', eventId: event.id });  // TO REMOVE
```

**File:** `src/ui/timelineView.ts`
**Handler pattern:**
```typescript
// Handle messages from the webview
webviewView.webview.onDidReceiveMessage((msg) => {
  switch (msg.command) {
    case 'goToStep':
      this.engine.goToStep(msg.index);
      break;
    case 'next':
      this.engine.next();
      break;
    case 'previous':
      this.engine.previous();
      break;
    case 'togglePlayPause':
      this.engine.togglePlayPause();
      break;
    case 'approveStep':      // TO REMOVE
      this.engine.approveStep(msg.eventId);
      break;
    case 'flagStep':         // TO REMOVE
      this.engine.flagStep(msg.eventId, msg.comment);
      break;
    case 'clearReview':      // TO REMOVE
      this.engine.clearReview(msg.eventId);
      break;
  }
});
```

**Webview message listener pattern:**
```javascript
window.addEventListener('message', function (event) {
  var msg = event.data;

  switch (msg.command) {
    case 'updateState':
      events = msg.events || [];
      currentIndex = msg.currentIndex;
      playState = msg.playState || 'stopped';
      reviewSummary = msg.reviewSummary || { approved: 0, flagged: 0, unreviewed: 0 };
      if (currentIndex >= 0) {
        visitedSteps.add(currentIndex);
      }
      render();
      break;

    case 'clearSession':
      // Reset all state variables
      events = [];
      currentIndex = -1;
      visitedSteps = new Set();
      // ...
      render();
      break;

    case 'updatePregenProgress':
      pregenProgress = { current: msg.current, total: msg.total, status: msg.status };
      updatePregenProgress();
      break;
  }
});
```

### 2. Review State Management (TO REMOVE)

**Files:**
- `src/replay/engine.ts` - Review state storage and methods
- `src/trace/types.ts` - Review type definitions
- `src/ui/timelineView.ts` - Forwards review events to webview
- `webview/timeline.js` - Review UI rendering

**Current flow:**
1. Engine stores `reviewStates: Map<string, StepReviewState>`
2. Engine methods: `approveStep()`, `flagStep()`, `clearReview()`, `getReviewState()`, `getReviewSummary()`, `exportReview()`
3. Engine fires `_onReviewChanged` event
4. TimelineView listens to `onReviewChanged`, calls `updateWebview()`
5. Webview renders approve/flag buttons, review bar summary

**Engine methods to remove:**
```typescript
// src/replay/engine.ts - lines 417-471
approveStep(eventId: string): void {
  const state: StepReviewState = { status: 'approved' };
  this.reviewStates.set(eventId, state);
  this._onReviewChanged.fire({ eventId, state });
}

flagStep(eventId: string, comment?: string): void {
  const state: StepReviewState = { status: 'flagged', comment };
  this.reviewStates.set(eventId, state);
  this._onReviewChanged.fire({ eventId, state });
}

clearReview(eventId: string): void { ... }
getReviewState(eventId: string): StepReviewState { ... }
getReviewSummary(): ReviewSummary { ... }
exportReview(): ReviewExportEntry[] { ... }
```

**Types to remove (src/trace/types.ts lines 110-134):**
```typescript
export type ReviewStatus = 'unreviewed' | 'approved' | 'flagged';
export interface StepReviewState { status: ReviewStatus; comment?: string; }
export interface ReviewChangedEvent { eventId: string; state: StepReviewState; }
export interface ReviewSummary { approved: number; flagged: number; unreviewed: number; }
export interface ReviewExportEntry { eventId: string; status: ReviewStatus; comment?: string; }
```

**What to keep/repurpose:**
- Keep the comment input UI pattern - will be used for per-step comments
- Keep the `commentInputEventId` state variable for tracking which step is being edited
- Remove the "Flag" submit button label, replace with "Save" or just Enter

### 3. Decoration/Highlight System

**File:** `src/util/decorations.ts`
**Key pattern:**
```typescript
export class DecorationManager {
  private activeType: vscode.TextEditorDecorationType | null = null;
  private referenceType: vscode.TextEditorDecorationType | null = null;
  private activeEditor: vscode.TextEditor | null = null;

  // Main highlight (blue, for ranges)
  applyHighlight(editor: vscode.TextEditor, startLine: number, endLine: number): void {
    this.clearAll();

    this.activeType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderLeft: '3px solid rgba(56, 139, 253, 0.6)',
      backgroundColor: 'rgba(56, 139, 253, 0.05)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      overviewRulerColor: 'rgba(56, 139, 253, 0.9)',
    });

    const ranges: vscode.Range[] = [];
    // Build ranges from startLine to endLine (1-indexed input)
    for (let line = startLine; line <= endLine; line++) {
      const lineIndex = line - 1; // Convert to 0-indexed
      // ... build range
    }

    if (ranges.length > 0) {
      editor.setDecorations(this.activeType, ranges);
      this.activeEditor = editor;
    }
  }

  // Reference highlights (amber, for line references)
  applyLineReferences(editor: vscode.TextEditor, lineNumbers: number[]): void {
    this.clearReferences();

    this.referenceType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderLeft: '3px solid rgba(217, 119, 6, 0.9)',
      backgroundColor: 'rgba(217, 119, 6, 0.15)',
      // ...
    });

    // ... apply decorations
  }

  clearReferences(): void { ... }
  clearAll(): void { ... }
}
```

**Animation opportunity:**
VS Code decorations don't support CSS animations directly, but we could:
1. Apply decoration with initial opacity/color
2. Replace with updated decoration after short delay (100-150ms)
3. Or: Use CSS keyframes in webview for transition indicator

### 4. Handler Execution Pattern

**File:** `src/replay/handlers/index.ts`
**Pattern:**
```typescript
// Handler interface
export interface EventHandler {
  execute(event: TraceEvent, context: HandlerContext): Promise<void>;
}

// Handler context - passed to all handlers
export interface HandlerContext {
  workspaceRoot: string;
  decorationManager: DecorationManager;
  outputChannel: vscode.OutputChannel;
  gitContentProvider: GitContentProvider;
  followMode: FollowModeController;
  inlineCard: InlineCardController;
  ttsPlayer: TtsPlayer;
  engine: ReplayEngine;
  _skipTts?: boolean;  // Internal flag
}

// Registry pattern - map event types to handlers
const handlers: Record<string, EventHandler> = {
  openFile: new OpenFileHandler(),
  showDiff: new ShowDiffHandler(),
  highlightRange: new HighlightRangeHandler(),
  say: new SayHandler(),
  sectionStart: new SectionStartHandler(),
  sectionEnd: new SectionEndHandler(),
};

export function getHandler(eventType: string): EventHandler | undefined {
  return handlers[eventType];
}
```

**File:** `src/replay/handlers/highlightRange.ts`
**Handler execution flow:**
```typescript
async execute(event: TraceEvent, context: HandlerContext): Promise<void> {
  // 1. Parse narration for line references
  let cleanNarration = event.narration || '';
  if (event.narration) {
    const parsed = parseLegacyLineReferences(event.narration);
    cleanNarration = parsed.cleanText;
  }

  // 2. Start TTS (async, doesn't block)
  if (cleanNarration && !context._skipTts && context.engine.isPlaying) {
    context.ttsPlayer.speakAsync(cleanNarration, event.id);
  }

  // 3. Check follow mode
  if (!context.followMode.isEnabled) {
    await context.inlineCard.showNotification(event, stepIndex, totalSteps);
    return;
  }

  // 4. Open file
  const uri = vscode.Uri.file(fullPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: false,
  });

  // 5. Apply decorations
  context.decorationManager.applyHighlight(editor, startLine, endLine);

  // 6. Scroll into view
  editor.revealRange(highlightRange, vscode.TextEditorRevealType.InCenter);

  // 7. Show inline card
  await context.inlineCard.showCard(event, stepIndex, totalSteps, editor, startLine, reviewState);
}
```

**Transition indicator insertion point:**
Between steps 3 and 4, we can add file transition indicator:
```typescript
// Check if switching files
const currentFile = context.engine.currentEvent?.filePath;
if (currentFile && currentFile !== event.filePath) {
  await showTransitionIndicator(event.filePath);  // 200-300ms delay
}
```

## Reusable Utilities

| Utility | File | Usage |
|---------|------|-------|
| DecorationManager | `src/util/decorations.ts` | Apply/clear line highlights |
| parseLegacyLineReferences | `src/util/lineRefParser.ts` | Extract `[line:X]` from text |
| getHandler | `src/replay/handlers/index.ts` | Lookup handler by event type |
| TtsPlayer | `src/audio/ttsPlayer.ts` | Async TTS playback |
| FollowModeController | `src/replay/followMode.ts` | Track follow mode state |
| InlineCardController | `src/ui/inlineCard.ts` | Show step info cards |

## Type Patterns

| Type | File | Pattern |
|------|------|---------|
| TraceEvent | `src/trace/types.ts` | Event structure with id, type, title, narration, filePath, range, metadata |
| TraceEventType | `src/trace/types.ts` | Enum: openFile, showDiff, highlightRange, say, sectionStart, sectionEnd |
| TraceRange | `src/trace/types.ts` | Range with startLine, startCol, endLine, endCol (1-indexed) |
| PlayState | `src/trace/types.ts` | Enum: stopped, playing, paused |
| HandlerContext | `src/replay/handlers/index.ts` | Context object passed to all handlers |
| EventHandler | `src/replay/handlers/index.ts` | Interface with execute(event, context) method |

**Type changes needed:**

Add to TraceEvent:
```typescript
export interface TraceEvent {
  // ... existing fields
  comment?: string;        // NEW: User comment for feedback
  risks?: AgentRisk[];     // NEW: Agent-specified risks (replaces auto-detection)
}

export interface AgentRisk {
  category: string;        // e.g., "security", "breaking-change", "performance"
  label: string;           // Human-readable description
}
```

## Webview Input Patterns

**Current comment input (for flagging):**

**File:** `webview/timeline.js`
```javascript
function renderCommentInput(event, indentLevel) {
  var row = document.createElement('div');
  row.className = 'comment-input-row' + (indentLevel > 0 ? ' indented' : '');

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'comment-input';
  input.placeholder = 'Add comment (optional)...';
  input.value = existingComment;

  var submitBtn = document.createElement('button');
  submitBtn.className = 'comment-submit';
  submitBtn.textContent = 'Flag';  // CHANGE to 'Save'
  submitBtn.addEventListener('click', function () {
    vscode.postMessage({
      command: 'flagStep',  // CHANGE to 'saveComment'
      eventId: event.id,
      comment: input.value || undefined,
    });
    commentInputEventId = null;
    render();
  });

  // Submit on Enter, cancel on Escape
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      submitBtn.click();
    } else if (e.key === 'Escape') {
      commentInputEventId = null;
      render();
    }
  });

  // Auto-focus after render
  setTimeout(function () { input.focus(); }, 0);

  return row;
}
```

**CSS patterns for comments:**

**File:** `webview/timeline.css`
```css
.comment-input-row {
  display: flex;
  padding: 4px 16px 8px;
  gap: 4px;
}

.comment-input-row.indented {
  padding-left: 32px;
}

.comment-input {
  flex: 1;
  background: var(--vscode-input-background, rgba(255,255,255,0.1));
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15));
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 0.85em;
  font-family: inherit;
}

.comment-input:focus {
  outline: none;
  border-color: var(--vscode-focusBorder, #388bfd);
}

.comment-submit {
  background: var(--vscode-button-background, #388bfd);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 0.8em;
  cursor: pointer;
}
```

**New comment icon button pattern (to add):**
```javascript
// Add to renderStepItem() after title
var commentBtn = document.createElement('button');
commentBtn.className = 'comment-btn' + (event.comment ? ' has-comment' : '');
commentBtn.textContent = '\uD83D\uDCAC';  // speech bubble emoji
commentBtn.title = event.comment ? 'Edit comment' : 'Add comment';
commentBtn.addEventListener('click', function (e) {
  e.stopPropagation();
  commentInputEventId = event.id;
  render();
});
```

**New CSS for comment indicator:**
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

.comment-btn:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
}

.comment-btn.has-comment {
  opacity: 0.8;
  color: var(--vscode-charts-blue, #58a6ff);
}
```

## HTML Structure (current)

**File:** `webview/timeline.html`
```html
<div id="root">
  <div class="progress-bar-track">...</div>
  <div class="header">...</div>
  <div class="pregen-status">...</div>
  <div class="review-bar">...</div>         <!-- TO REMOVE -->
  <div class="step-list">...</div>
  <div class="narration-panel">...</div>
  <div class="controls">...</div>
</div>
```

**After changes:**
```html
<div id="root">
  <div class="progress-bar-track">...</div>
  <div class="header">
    <div class="header-title">Replay Session</div>
    <div class="header-subtitle">12 steps - 3 comments</div>  <!-- Add comment count -->
  </div>
  <div class="pregen-status">...</div>
  <!-- review-bar REMOVED -->
  <div class="step-list">...</div>
  <div class="narration-panel">...</div>
  <div class="controls">...</div>
</div>
```
