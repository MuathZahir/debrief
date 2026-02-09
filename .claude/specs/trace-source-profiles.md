### Trace Source Profiles (Snapshots by Default + Pin to Commit for Docs)

This document specifies a **high-trust replay strategy** for Debrief traces that maximizes user value across:
- **Onboarding traces** (durable documentation)
- **New feature / PR walkthroughs** (shareable explanations)
- **Personal “debrief” traces** to understand AI-generated code (often uncommitted / messy working tree)

The key product choice is: **never guess highlights**. Highlights must be based on **the exact text the author saw** (snapshot or git). If we cannot guarantee correctness, we show the authored version (or a diff) rather than trying to “best-effort” remap line numbers.

---

### Goals

- **Correct-by-default highlights**: highlights must match the narration and the author’s intended code region.
- **Zero-friction recording**: users can always record a trace even with a dirty working tree.
- **Durable documentation**: “documentation traces” should be reproducible months later on other machines.
- **No silent failure modes**: if a file/version can’t be resolved, show an actionable message and fallback path.
- **Backwards compatible**: existing traces without new fields still play.

---

### Non-goals (initial implementation)

- Perfectly mapping authored highlights onto an arbitrarily changed working tree (anchors/remapping).
- Full repository snapshotting (we only capture what we need).
- Multi-root workspace perfection (can be added later; design should not block it).

---

### Core idea

**Snapshots by default. Pin to a commit when you want to publish/share.**

This removes line-number drift entirely, while keeping a clean path to durable documentation.

There are two user-facing “states” (not complicated “modes”):

- **Snapshot Trace (default)**
  - Debrief always replays against a **saved copy** of the referenced files.
  - Highlights are always correct, even if the workspace changes later.
  - This is the best default for “I’m trying to understand what the agent just did”.

- **Pinned Trace (published/documentation)**
  - User explicitly “pins” a snapshot trace to a **git commit** (requires a committed/clean state).
  - Replay uses **git content** (`git show`) so the trace becomes shareable/reproducible for others.
  - Snapshots may still exist locally, but git becomes the canonical authored source.

Optional affordances:
- Users can still open “Workspace version” of a file, but Debrief should label it clearly as “may not match highlights”.

---

### Terminology

- **Authored source**: the exact content used when the trace was created (git-pinned or snapshotted).
- **Workspace source**: the user’s current working tree content.
- **Source mode**: whether replay opens files from authored source or the workspace.

---

### Data model changes

These changes apply to `src/trace/types.ts` and should remain backwards compatible.

#### SessionMetadata additions

Add optional fields:

```ts
type TraceProfile = "documentation" | "personal";
type TraceSourceKind = "git" | "snapshot";

interface SessionMetadata {
  // existing fields...
  commitSha?: string;

  // new fields
  profile?: TraceProfile;
  sourceKind?: TraceSourceKind;

  // snapshot bundle location relative to the trace directory
  // e.g. ".assets/snapshots"
  snapshotsDir?: string;
}
```

Rules:
- `commitSha` continues to mean “authored source is retrievable via git”.
- `sourceKind` is a convenience hint, not required for playback; playback should infer by checking available artifacts.
- `snapshotsDir` is only meaningful when snapshots exist.

#### Optional event metadata (future-proofing only)

Do not require anchors/remapping. But allow future additions without schema breakage:

```ts
interface TraceEvent {
  // existing fields...
  metadata?: Record<string, unknown>;
}
```

Already present today.

---

### Trace storage format

Traces today are loaded from JSONL and optionally have `metadata.json` and `summary.md` alongside them.

For **all saved traces**, store a small snapshot bundle next to the trace file:

```
<traceDir>/
  trace.jsonl
  metadata.json
  summary.md (optional)
  .assets/
    snapshots/
      <normalized-path>   (UTF-8 text file)
      ...
```

Where:
- `<normalized-path>` is the original `filePath` normalized into a safe relative path.
  - Example: `src/util/decorations.ts` stored at `.assets/snapshots/src/util/decorations.ts`
- Only store **files referenced by events** (`filePath` present on any event).

Security considerations:
- Add `.debrief/**/.assets/**` to `.gitignore` if not already covered.
- Provide a UX for deletion/cleanup later (not required for first implementation).

---

### Recording logic (snapshots by default)

This logic applies whenever the extension writes trace artifacts to disk (loading a trace file, or saving a live agent session).

#### Always capture snapshots for correctness

On trace save:
- Set `metadata.sourceKind = "snapshot"`
- Set `metadata.snapshotsDir = ".assets/snapshots"`
- Collect unique `filePath` values across events
- Write snapshot files to `.assets/snapshots/<filePath>`

Notes:
- This is intentionally **independent of git cleanliness**. It keeps the “personal debrief” experience reliable without requiring the user to understand git state.
- You may optionally include `metadata.profile = "personal"` as the default.

#### Do not set `commitSha` automatically

`metadata.commitSha` should mean: “this trace is **pinned/published** to a specific commit and should replay from git by default.”

So by default:
- `commitSha` is **unset** (even if the workspace is clean).
- Pinning is an explicit user action (see “Pin to commit” flow).

---

### Replay logic (source resolution)

Create a single resolver used by `OpenFileHandler` and `HighlightRangeHandler`:

#### Inputs

- `event.filePath`
- `session.metadata` (especially `commitSha`, `snapshotsDir`)
- `traceDir` (directory containing the loaded trace file; already tracked via `session.tracePath`)
- User preference: `sourceMode`
  - `authored` (default; uses snapshot or git if pinned)
  - `workspace` (optional; convenience view only)

#### Output

Resolve to a VS Code URI:
- `vscode.Uri.parse("debrief-git:/...")` when using git-authored content
- `vscode.Uri.parse("debrief-snapshot:/...")` when using snapshotted content
- `vscode.Uri.file(...)` when using workspace content

#### Algorithm (default authored)

When `sourceMode = authored`:
1. If `session.metadata.commitSha` exists (pinned trace), try `debrief-git:/<commitSha>/<filePath>`
   - If open fails, fallback to snapshot if available (and warn that git resolution failed)
2. If a snapshot exists for `filePath`, open `debrief-snapshot:/...`
3. Otherwise fallback to workspace file, but:
   - Warn loudly: “Authored snapshot missing; highlighting may be incorrect.”

When `sourceMode = workspace`:
1. Use `vscode.Uri.file(workspaceRoot + filePath)`
2. If opened, proceed with highlighting using trace line numbers **only if** we are comfortable with “this may be wrong”
   - Recommended: show a small banner/inline-card note: “You are viewing workspace version; highlights may not match if file changed.”
3. Provide “Open authored version” as a one-click action in the UI (timeline/inline card)

Important:
- In **snapshot** and **git** authored views, line numbers are stable and highlights are correct.
- In **workspace** view, line numbers may drift; do not attempt `LineRemapper` by default.

---

### New content provider: `debrief-snapshot`

Add a `TextDocumentContentProvider` similar to `GitContentProvider`.

URI format:
- `debrief-snapshot:/<traceId-or-path>/<filepath>`

Simpler recommended format:
- `debrief-snapshot:/<filepath>` with the provider instance bound to the “current session snapshots root”.
  - However, VS Code content providers are global; multiple sessions could exist.
  - Prefer encoding a session key in the URI.

Recommended implementation:
- Provider registered once in `extension.ts`
- `ReplayEngine.load(session)` sets a “current snapshot root” in a central service used by the provider
  - Provider resolves file content from `snapshotRoot + filePath`
  - If missing, throws

Alternative (more robust):
- Encode snapshot root identifier into the URI and store a map of `id → rootPath` in the provider.

Minimum viable:
- Single active session supported at a time (already true conceptually)
- Provider reads from `engine.currentSession.tracePath` derived directory

---

### Pin/Publish flow: “Snapshot → Pinned (Commit)”

Add a command:
- `debrief.pinTraceToCommit` (or keep `debrief.promoteToDocumentationTrace` but label it “Pin to commit” in UI)

Behavior:
1. Detect git availability (repo present)
2. Determine cleanliness (`git status --porcelain`)
3. If clean working tree:
   - Write `metadata.commitSha = HEAD`
   - Write `metadata.profile = "documentation"` (or `"published"`, if you add a third value later)
   - Optionally keep snapshots (recommended to keep; they’re harmless and provide a fallback if git resolution fails on this machine)
4. If dirty working tree:
   - Explain: “To pin, commit your changes so this trace matches a stable git version.”
   - Actions:
     - “Open Source Control”
     - “Cancel”

Key principle:
- **Never block recording**. Always allow a snapshot trace.
- Only enforce “committed state” when the user chooses to pin/publish.

---

### UX changes (make the model obvious)

Users should only need to understand two things:
- **Snapshot** = accurate replay of what the author saw
- **Pinned to commit** = accurate + shareable replay backed by git

#### Settings

Add a workspace/user setting:
- `debrief.replaySourceMode`: `"authored"` | `"workspace"`
  - Default `"authored"`

Optional:
- `debrief.warnOnWorkspaceMode`: boolean (default true)

#### Status bar / timeline affordance

Always display the authored source:
- Status bar: `Debrief: Snapshot` or `Debrief: Pinned (a1b2c3d)`
- Tooltip copy:
  - Snapshot: “Replaying a saved copy so highlights never drift.”
  - Pinned: “Replaying from git commit a1b2c3d (shareable/reproducible).”

Show a lightweight banner once per load (timeline header):
- Snapshot banner body: “This trace uses a snapshot so highlights stay accurate even if files change.”
- Actions: “Pin to commit…” / “Open workspace version” / “Dismiss”

Inline card badge:
- `Snapshot` / `Pinned`

Actions (timeline/inline card):
- “Pin to commit…” (disabled or shows explanation if repo is dirty)
- “Open workspace version” (clearly labeled “may not match highlights”)
- “Show diff (authored ↔ workspace)” (high value)

---

### Diff experience (high-value bridge)

When viewing authored source and the user wants to relate it to the current workspace:
- Provide a “Show diff vs workspace” action.

Implementation strategy:
- Reuse existing `showDiff` mechanism:
  - Extend `resolveDiffRef` to support:
    - `snapshot:<path>` (resolves to `debrief-snapshot:/...`)
    - `git:<sha>:<path>` already supported
    - `workspace:<path>` already supported

Example diff ref strings:
- left:  `git:<commitSha>:src/foo.ts`
- right: `workspace:src/foo.ts`

Or for personal snapshot-based debriefs:
- left:  `snapshot:src/foo.ts`
- right: `workspace:src/foo.ts`

---

### How this changes existing code paths

This section lists the most important areas to edit (not exhaustive).

#### `src/trace/types.ts`
- Add `profile`, `sourceKind`, `snapshotsDir` to `SessionMetadata` and `sessionMetadataSchema`.

#### `src/trace/parser.ts`
- No major change; it already loads inline metadata and `metadata.json`.
- Ensure it preserves new metadata fields.

#### `src/extension.ts`
- Register `debrief-snapshot` provider.
- Track `loadedTracePath` already exists; ensure sessions loaded from disk keep `session.tracePath`.
- When saving live sessions to `.debrief/replay`, decide whether to pin to git or snapshot:
  - If metadata already contains `commitSha` from the agent, respect it.
  - Otherwise compute it and/or create snapshots at end of session.

#### `src/replay/engine.ts`
- Stop treating `commitSha` as “enable line remapping”.
  - Replace with a “source strategy” (authored via git vs snapshot).
  - `LineRemapper` should become optional/legacy; default path should not use it.

#### `src/replay/handlers/openFile.ts` and `highlightRange.ts`
- Replace `path.join(workspaceRoot, event.filePath)` with a call to the resolver:
  - `resolveEventUri(event, context, session)`
- Use the resolved URI in `openTextDocument`.
- Only run `LineRemapper` if user explicitly opted into workspace mode + “try to adapt” (not in scope for initial spec).

#### `src/ui/gitContentProvider.ts`
- Extend `resolveDiffRef` to support `snapshot:` prefix.

---

### Snapshot capture implementation details

When creating snapshots:
- Collect unique `filePath` from events with a `filePath`.
- Normalize separators to `/` for storage.
- For each path:
  - Read content from the **workspace file** at capture time.
  - Write to `<traceDir>/.assets/snapshots/<filePath>`
  - Create directories recursively.

When replaying snapshots:
- Read file content from that snapshot path.
- Provide it via `debrief-snapshot` URI.

Important constraints:
- Only UTF-8 text supported initially.
- If file is missing at capture time, record a warning and skip snapshot.

---

### Backwards compatibility and migration

Existing traces:
- May include inline `{ "commitSha": "..." }` header line (already supported) OR metadata.json with commitSha.
- May not include snapshots.

Replay rules:
- If snapshots exist for a file, prefer snapshot (new default).
- Else if `commitSha` exists, prefer git authored source.
- Else open workspace file (legacy behavior).

No migration required to keep them working.

---

### Acceptance criteria

#### Documentation trace (git-pinned)
- Given a trace with `metadata.commitSha`, replay opens `debrief-git` documents and highlights match even if the working tree has moved lines.
- Works when the workspace has additional edits; highlights do not drift because they’re not using workspace files.

#### Snapshot trace (default)
- Given a trace recorded at any time, replay uses snapshots and highlights remain correct even after the workspace changes again.
- Trace directory contains `.assets/snapshots/...` for referenced files.

#### Workspace mode (optional)
- When user switches to workspace mode, files open from the filesystem and a visible warning indicates highlights may be inaccurate.
- User can switch back to authored mode and see correct highlights.

#### Failure modes
- If git content cannot be retrieved (missing commit), and snapshots exist, fallback to snapshot.
- If neither git nor snapshots exist, fallback to workspace and warn loudly.

---

### Implementation checklist (agent-friendly)

1. **Types & schemas**
   - Update `SessionMetadata` and `sessionMetadataSchema` in `src/trace/types.ts`

2. **Add snapshot provider**
   - Create `src/ui/snapshotContentProvider.ts`
   - Register provider in `src/extension.ts` under scheme `debrief-snapshot`

3. **Add source resolver**
   - Create `src/replay/sourceResolver.ts` (or `src/util/traceSource.ts`)
   - Expose `resolveEventUri({ event, context, session, sourceMode })`

4. **Handler updates**
   - Update `OpenFileHandler` and `HighlightRangeHandler` to use the resolver URI
   - Remove default `LineRemapper` usage from these handlers

5. **Engine updates**
   - Remove “commitSha ⇒ LineRemapper enabled” behavior
   - Instead store “authored source available” and/or snapshot root

6. **Snapshot capture**
   - On trace save (always):
     - Write `.assets/snapshots/...` for referenced files
     - Write `metadata.sourceKind = "snapshot"` + `snapshotsDir`
   - Do not set `commitSha` automatically

7. **Pin to commit**
   - Add command + UI: “Pin to commit…”
   - Require clean working tree
   - On success: write `metadata.commitSha = HEAD` and update UI labels

8. **Settings + UI**
   - Add `debrief.replaySourceMode` setting
   - Add status bar indicator and timeline action to toggle

9. **Diff support**
   - Extend `resolveDiffRef` to support `snapshot:` refs
   - Add “diff authored vs workspace” action (optional but recommended)

10. **QA scenarios**
   - Use `test-remap/` to validate that highlights do not drift when using git/snapshot authored sources.
   - Verify fallback behaviors (git missing, snapshot missing).

