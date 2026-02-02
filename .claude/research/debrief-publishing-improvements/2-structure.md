# Structure Analysis: Debrief Publishing Improvements

## Architecture
Type: VS Code extension with webview sidebar, event-driven replay engine, and handler pattern for trace events

## Key Directories
| Directory | Purpose |
|-----------|---------|
| src/ | TypeScript source code |
| src/replay/ | Playback engine, event handlers, risk detection |
| src/replay/handlers/ | Per-event-type handler classes |
| src/trace/ | Trace file parsing and type definitions |
| src/ui/ | VS Code UI components (timeline, status bar, inline cards) |
| src/audio/ | TTS generation and playback |
| src/util/ | Decorations, line parsing utilities |
| src/agent/ | HTTP server for agent integration |
| webview/ | Sidebar webview HTML/CSS/JS |
| dist/ | Compiled output (generated) |
| examples/ | Sample trace files |

## Conventions
- Files: lowercase-camelCase (e.g., `highlightRange.ts`, `timelineView.ts`)
- Classes: PascalCase (e.g., `ReplayEngine`, `TimelineViewProvider`)
- Handlers: `{EventType}Handler` class implementing `EventHandler` interface
- Types: Defined in `src/trace/types.ts` with Zod schemas
- Tests: None present in codebase

## Task-Relevant Areas
| Path | Why Relevant |
|------|--------------|
| `src/replay/riskDetector.ts` | DELETE - auto-risk detection to remove |
| `src/ui/timelineView.ts` | Remove risk/review code, add comment handling |
| `src/replay/engine.ts` | Remove review state, add comment persistence |
| `src/trace/types.ts` | Add `comment` field, add `risks` field for agent-specified risks, remove review types |
| `webview/timeline.js` | Remove review UI (approve/flag buttons), add comment UI |
| `webview/timeline.css` | Update styles - remove risk/review styles, add comment styles |
| `webview/timeline.html` | Update markup - remove review bar, add comment elements |
| `src/replay/handlers/highlightRange.ts` | Add transition indicator + animation for file switches |
| `src/replay/handlers/openFile.ts` | Add transition indicator |
| `src/util/decorations.ts` | May need animation support for highlight fade-in |
| `package.json` | Remove `exportReview`, `approveCurrentStep`, `flagCurrentStep` commands |

## Where New Code Goes
- UI components: `src/ui/`
- Handlers: `src/replay/handlers/`
- Types: `src/trace/types.ts`
- Decorations/animations: `src/util/decorations.ts`
- Webview logic: `webview/timeline.js`
- Webview styles: `webview/timeline.css`

## Webview Structure

### Communication Pattern
- Extension -> Webview: `this.view.webview.postMessage({ command: '...', ... })`
- Webview -> Extension: `vscode.postMessage({ command: '...', ... })`

### Message Commands (Extension -> Webview)
- `updateState` - Push full state (events, currentIndex, playState, reviewSummary)
- `clearSession` - Clear all state
- `updatePregenProgress` - TTS pre-generation progress

### Message Commands (Webview -> Extension)
- `goToStep` - Navigate to step index
- `next` / `previous` - Step navigation
- `togglePlayPause` - Playback control
- `approveStep` / `flagStep` / `clearReview` - Review actions (TO REMOVE)

### HTML Structure
```
#root
  .progress-bar-track
  .header (title + subtitle)
  .pregen-status (TTS progress)
  .review-bar (TO REMOVE)
  .step-list (section tree + step items)
  .narration-panel
  .controls (prev/play/next)
```

### JS State Variables (in webview)
- `events` - Array of trace events with risks/review attached
- `currentIndex`, `playState`, `visitedSteps`
- `collapsedSections` - Set of collapsed section IDs
- `reviewSummary` - { approved, flagged, unreviewed } (TO REMOVE)
- `riskFilterActive` - Boolean for filtering risky steps (TO REMOVE)
- `commentInputEventId` - Currently editing comment (REPURPOSE)

## Key Interfaces

### TraceEvent (src/trace/types.ts)
```typescript
interface TraceEvent {
  id: string;
  type: TraceEventType;
  title: string;
  narration: string;
  filePath?: string;
  range?: TraceRange;
  metadata?: Record<string, unknown>;
  // TO ADD: comment?: string;
  // TO ADD: risks?: AgentRisk[];
}
```

### Review Types (TO REMOVE)
- `ReviewStatus` = 'unreviewed' | 'approved' | 'flagged'
- `StepReviewState` - { status, comment? }
- `ReviewChangedEvent`, `ReviewSummary`, `ReviewExportEntry`

### Engine Methods (TO MODIFY)
- `approveStep()`, `flagStep()`, `clearReview()` - REMOVE
- `getReviewState()`, `getReviewSummary()`, `exportReview()` - REMOVE
- `reviewStates` Map - REMOVE
- ADD: Comment persistence to trace file

## Files to Delete
- `src/replay/riskDetector.ts` (150 lines)

## Integration Points
- `timelineView.ts` imports `detectRisks` from `riskDetector.ts` (line 5)
- `timelineView.ts` calls `detectRisks(e)` in `updateWebview()` (line 114)
- `engine.ts` has review methods: `approveStep`, `flagStep`, `clearReview`, `getReviewState`, `getReviewSummary`, `exportReview`
- `package.json` has commands: `debrief.exportReview`, `debrief.approveCurrentStep`, `debrief.flagCurrentStep`
