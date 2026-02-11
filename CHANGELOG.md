# Changelog

All notable changes to Debrief will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2025-02-11

### Changed
- **Per-trace snapshots** — Each trace now lives in its own subfolder (e.g., `.debrief/replay/auth-refactor/auth-refactor.jsonl`) with snapshots stored alongside it, so multiple traces no longer overwrite each other's file snapshots
- Snapshot directory renamed from `.assets/snapshots/` to `snapshots/` for a cleaner layout
- Agent HTTP save path now creates a unique subfolder per session instead of writing to a shared `trace.jsonl`
- Skill instructions updated to tell agents to create traces in their own subfolder

### Fixed
- File snapshots from earlier traces being overwritten when a new trace was created in the same directory

## [0.5.0] - 2025-02-09

### Added
- **Snapshot-based replay** — Files are automatically captured when a trace is saved, so highlights stay accurate even if the code changes later
- **Source banner** — Sidebar shows current source mode (Snapshot, Pinned, or Workspace) with action buttons and tooltips
- **Pin to Commit** — Lock a trace to a git commit for sharing (`Debrief: Pin Trace to Commit...`)
- **Diff authored vs workspace** — Compare the original code with your current version side by side
- **Source mode setting** — `debrief.replaySourceMode` to switch between authored and workspace views
- **Source kind status bar** — Shows whether replay uses snapshot, git, or workspace files
- **Tab badges** — Virtual debrief files show a "D" badge so they're easy to identify

### Changed
- Snapshot/git files open in preview tabs (reuse a single tab) instead of accumulating
- Virtual debrief tabs are closed automatically when a new session loads
- `commitSha` metadata header is now optional — snapshots handle highlight stability by default

### Removed
- Line remapper (`LineRemapper`) — replaced entirely by snapshot-based source resolution

## [0.4.0] - 2025-02-03

### Added
- **Load Replay Button** - Click button in sidebar instead of using command palette
- **Step Comments** - Add feedback on any step, saved directly to trace file
- **Smooth Transitions** - Visual indicator when switching between files
- **Highlight Animation** - Lines fade in smoothly when highlighted
- **Auto-open Sidebar** - Sidebar opens automatically when loading replay
- **Agent-specified Risks** - Agents can mark risky steps in trace with `risks` field
- **Trace Authoring Skill** - Install via `npx skills add MuathZahir/debrief`

### Changed
- File watcher detects `.debrief/replay/**/*.jsonl` automatically and shows notification
- Clicking "Walk Me Through It" notification now auto-opens sidebar
- Risk detection is now explicit (agents specify in trace) instead of auto-detected

### Removed
- Automatic risk detection patterns (security, publicApi, migration, etc.)
- Approve/Flag review workflow (replaced with simpler comment system)

## [0.3.0] - 2024-01-30

### Added
- **TTS Narration** - OpenAI TTS integration with configurable voice and speed
- **Timed Line Highlights** - `<line:X>text</line:X>` syntax for synchronized highlights
- **Word-level Timing** - Whisper transcription for precise highlight sync
- **Voice Selection** - Choose from 6 OpenAI voices (alloy, echo, fable, onyx, nova, shimmer)
- **Speed Control** - Adjustable TTS playback speed (0.5x - 2.0x)
- **Status Bar Info** - Step info and narration shown in status bar

### Changed
- Highlights now use subtle left-border style instead of full background
- Replaced Comments API panels with lightweight inline indicators
- TTS plays immediately when navigating (TTS-first pattern)

### Removed
- Video generation (now VS Code-native playback only)
- Heavy Comments API integration

## [0.2.0] - 2024-01-27

### Added
- Timeline sidebar view with step navigation
- Review workflow (approve/flag steps)
- Follow mode toggle
- Section grouping in traces
- HTTP server for agent integration
- Diff view support

### Changed
- Improved highlight styling
- Better keyboard navigation

## [0.1.0] - 2024-01-25

### Added
- Initial release
- Basic trace file loading
- Step-by-step navigation
- Line highlighting
- File auto-opening
