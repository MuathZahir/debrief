# Spec: Debrief Extension Publishing Improvements

> Created: 2026-02-02

## Problem
Debrief needs polish before VS Code marketplace publishing. Current issues: sections nest incorrectly creating deep indentation, approve/flag UX is confusing, auto-risk detection triggers false positives, and step transitions feel jarring when jumping between files.

## Goals
- [ ] Fix section nesting so it's semantically meaningful, not infinitely nested
- [ ] Replace approve/flag with simple per-step comments for agent feedback
- [ ] Remove automatic risk detection; agents mark risks explicitly in trace
- [ ] Add smooth transitions between steps with visual indicators and animations

## Non-Goals
- Mini-map preview (v2)
- Breadcrumb trail UI (v2)
- Changing extension name (keeping "Debrief")

## Requirements

### Must Have
- [ ] Update trace authoring skill to enforce semantic section nesting (max 2-3 levels, only when logically parent-child)
- [ ] Remove sectionEnd events that don't properly close sections; add validation
- [ ] Replace review buttons (approve/flag) with a single comment input per step
- [ ] Save comments back to the .jsonl trace file as metadata
- [ ] Remove `riskDetector.ts` and all auto-risk detection code
- [ ] Add `risks` field to TraceEvent schema for agent-specified risks
- [ ] Add file transition indicator ("Moving to routes.ts...") with 200-300ms pause when switching files
- [ ] Add highlight fade-in/pulse animation when lines are highlighted

### Nice to Have
- [ ] Validation warning in UI if trace has deeply nested sections
- [ ] Comment count badge in timeline header
- [ ] Keyboard shortcut to add comment on current step

## User Flow

### Viewing a Walkthrough
1. User loads trace file
2. Timeline shows steps grouped in semantic sections (max 2-3 levels deep)
3. When navigating between files, brief indicator shows target file name
4. Highlight fades in smoothly on target lines
5. User can add comments on any step → saved to trace file

### Providing Feedback
1. User clicks comment icon or presses shortcut on a step
2. Text input appears inline
3. User types comment and presses Enter
4. Comment saved to trace file, visible in timeline
5. At end, trace file contains all feedback for agent review

## Technical Constraints
- VS Code has no native smooth-scroll API for editors; must use reveal + decoration animation
- Trace files are JSONL; comments append/modify lines in place
- Must maintain backwards compatibility with existing trace files (comments are optional)

## UI Changes

### Timeline Panel
- Remove: Review bar with approved/flagged/unreviewed counts
- Remove: Risk filter button
- Remove: Approve/flag buttons on each step
- Add: Comment icon on each step (speech bubble)
- Add: Comment count in header subtitle

### Step Item
- Remove: Risk badges (shield, warning icons)
- Remove: Green/red review status styling
- Add: Comment indicator if step has comment
- Add: Inline comment input when editing

### Transition Indicator
- Small toast/banner at top of editor: "→ routes.ts:42"
- Appears for 200-300ms before file opens
- Only shows when switching to different file

### Highlight Animation
- Lines fade from 0% to 100% opacity over 150ms
- Or: brief pulse animation (subtle background flash)

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Deeply nested trace (legacy) | Show all sections but log warning; don't break |
| Comment on sectionStart/sectionEnd | Allow it; save to trace |
| Trace file read-only | Show warning; disable comment saving |
| Same file, different line | No file transition indicator; still animate highlight |
| Empty comment | Don't save; treat as no comment |

## Success Criteria
- [ ] No section exceeds 3 levels of nesting in newly generated traces
- [ ] User can add/edit comments and they persist in trace file
- [ ] No false-positive risk badges appear
- [ ] File transitions feel smooth (user feedback)
- [ ] Extension passes `vsce package` and can be published

## Open Questions
- Should old traces with approve/flag data be migrated to comments, or ignored?
- Exact animation timing (150ms fade vs 200ms pulse) - needs user testing

## Files to Modify

### Extension Code
- `src/replay/riskDetector.ts` - DELETE
- `src/ui/timelineView.ts` - Remove risk/review code, add comment handling
- `src/replay/engine.ts` - Remove review state, add comment persistence
- `src/trace/types.ts` - Add `comment` field to TraceEvent, remove review types
- `webview/timeline.js` - Remove review UI, add comment UI
- `webview/timeline.css` - Update styles
- `webview/timeline.html` - Update markup
- `src/replay/handlers/highlightRange.ts` - Add transition indicator + animation
- `src/replay/handlers/openFile.ts` - Add transition indicator

### Skill File
- `~/.claude/skills/debrief-trace-authoring.md` - Add section nesting rules, remove auto-risk mention, add explicit risk syntax
