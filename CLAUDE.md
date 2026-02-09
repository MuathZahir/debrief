# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Debrief is a VS Code extension that provides narrated code walkthroughs with TTS (text-to-speech). Users load a JSONL trace file, and the extension guides them through the code with synchronized voice narration and animated line highlights.

## Commands

```bash
npm install              # Install dependencies
npm run build            # Compile TypeScript to dist/
npm run watch            # TypeScript watch mode
npm run package          # Create .vsix package for distribution
```

Press `F5` in VS Code to launch the Extension Development Host for testing.

## Prerequisites

- Node.js 18+
- VS Code 1.85.0+
- `OPENAI_API_KEY` environment variable (for TTS narration)

## Architecture

### Extension Entry Point

`src/extension.ts` — Activates on startup, registers commands, initializes the HTTP server for agent integration.

### Core Components

- **Replay Engine** (`src/replay/engine.ts`) — Manages trace playback state, step navigation, and event dispatching
- **Event Handlers** (`src/replay/handlers/`) — Process different trace event types:
  - `highlightRange.ts` — Opens files and highlights line ranges
  - `say.ts` — Narration-only events (no file navigation)
  - `openFile.ts` — Opens files without highlighting
  - `showDiff.ts` — Shows diff between versions
  - `sectionStart.ts` / `sectionEnd.ts` — Section markers for grouping

### TTS System

- **TTS Player** (`src/audio/ttsPlayer.ts`) — Generates speech via OpenAI TTS API, caches audio files, plays via system audio (PowerShell on Windows, afplay on macOS)
- **Line Reference Parser** (`src/util/lineRefParser.ts`) — Parses `<line:X>text</line:X>` syntax for timed highlights
- **Highlight Timeline** (`src/util/highlightTimeline.ts`) — Builds timeline from word timings + line references
- **Highlight Scheduler** (`src/util/highlightScheduler.ts`) — Schedules highlight events during audio playback

### Source Resolution

- **Source Resolver** (`src/replay/sourceResolver.ts`) — Resolves trace file paths to the best available source (git → snapshot → workspace)
- **Snapshot Capture** (`src/trace/snapshotCapture.ts`) — Copies referenced files to `.assets/snapshots/` alongside the trace on save
- **Snapshot Content Provider** (`src/ui/snapshotContentProvider.ts`) — Serves snapshot content via `debrief-snapshot://` URIs
- **Git Content Provider** (`src/ui/gitContentProvider.ts`) — Serves git content via `debrief-git://` URIs, resolves diff refs (`git:`, `snapshot:`, `workspace:`)

### UI Components

- **Timeline View** (`src/ui/timelineView.ts`) — Sidebar webview showing all steps, source banner with actions
- **Decorations** (`src/util/decorations.ts`) — Line highlighting with VS Code decoration API
- **Status Bar** (`src/ui/statusBar.ts`) — Shows current step info and source kind indicator
- **Inline Card** (`src/ui/inlineCard.ts`) — End-of-line step indicator

### Agent Integration

- **HTTP Server** (`src/agent/httpServer.ts`) — Local server (default port 53931) for AI agents to send highlight events
- **File Watcher** (`src/agent/fileWatcher.ts`) — Watches for trace file changes

### Trace Format

Traces are JSONL files where each line is a step:

```typescript
interface TraceEvent {
  id: string;                    // Unique ID
  type: "highlightRange" | "say" | "openFile" | "showDiff" | "sectionStart" | "sectionEnd";
  title: string;                 // Short title for timeline
  narration: string;             // TTS narration text
  filePath?: string;             // Relative or absolute path
  range?: {
    startLine: number;           // 1-indexed
    startCol: number;
    endLine: number;
    endCol: number;
  };
}
```

### Line Reference Syntax

Use `<line:X>text</line:X>` for timed line highlights during narration:

```json
{"narration": "<line:42>This function handles retry logic</line:42>. It's key to reliability."}
```

Line 42 highlights when "This function" is spoken and clears after "logic" ends.

## Key Design Decisions

- **Snapshot-first replay** — Files are frozen on save; replay opens snapshots so highlights are always correct without line remapping
- **Source resolution priority** — Git pinned → snapshot → workspace fallback, with warnings at each degradation
- **TTS-first pattern** — Audio starts before file navigation for natural flow
- **System audio playback** — Uses native players (PowerShell/afplay) instead of webview audio
- **Word-level sync** — Whisper transcription enables precise highlight timing
- **Graceful degradation** — Falls back to static highlights if Whisper unavailable
- **Cached audio** — TTS results cached to avoid regeneration on replay

## File Structure

```
debrief/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── audio/                 # TTS generation and playback
│   ├── replay/                # Playback engine and handlers
│   ├── trace/                 # Trace file parsing
│   ├── ui/                    # VS Code UI components
│   ├── util/                  # Decorations, line parsing, scheduling
│   └── agent/                 # HTTP server for agent integration
├── webview/                   # Timeline sidebar HTML/CSS/JS
├── examples/                  # Sample trace files
├── scripts/                   # Utility scripts
├── dist/                      # Compiled output (generated)
└── package.json              # Extension manifest
```
