# Config Analysis: Debrief Publishing Improvements

## Spec Summary
- Fix section nesting to max 2-3 levels (semantically meaningful, not infinitely nested)
- Replace approve/flag UX with simple per-step comment system that persists to trace files
- Remove automatic risk detection; agents mark risks explicitly via `risks` field in TraceEvent
- Add smooth file transitions (200-300ms indicator) and highlight fade-in/pulse animations
- Extension must pass `vsce package` for VS Code marketplace publishing

## Project Rules
**Must do:**
- Use TTS-first pattern (audio starts before file navigation)
- Cache TTS results to avoid regeneration
- Maintain backwards compatibility with existing trace files
- Use system audio playback (PowerShell on Windows, afplay on macOS)
- Support `<line:X>text</line:X>` syntax for timed highlights

**Must NOT do:**
- No mini-map preview (v2)
- No breadcrumb trail UI (v2)
- No changing extension name (keeping "Debrief")
- No auto-risk detection (to be removed)

**Style:**
- TypeScript strict mode enabled
- ES2022 target
- CommonJS module format
- VS Code API patterns for webviews and decorations

## Key Dependencies
| Package | Version | Notes |
|---------|---------|-------|
| vscode | ^1.85.0 | Extension host API (devDep) |
| typescript | ^5.3.0 | Build tooling |
| esbuild | ^0.24.0 | Bundler |
| dotenv | ^16.4.0 | Environment config |
| zod | ^3.23.0 | Schema validation |
| @vscode/vsce | (npx) | Packaging tool |

## VS Code Extension Config
**Activation:** `onStartupFinished` - activates after VS Code finishes starting

**Commands:**
- `debrief.loadReplay` - Load Replay...
- `debrief.nextStep` / `debrief.previousStep` - Navigation
- `debrief.togglePlayPause` - Play/pause control
- `debrief.speedUp` / `debrief.speedDown` - Speed controls
- `debrief.toggleFollowMode` - Follow mode toggle
- `debrief.startServer` / `debrief.stopServer` - HTTP server control
- `debrief.exportReview` - Export review (to be modified)
- `debrief.approveCurrentStep` / `debrief.flagCurrentStep` - **TO BE REMOVED**
- `debrief.showNarration` - Show narration

**Views:**
- Activity bar container: `debrief-replay` with `$(play-circle)` icon
- Webview view: `debrief.timeline` (Timeline panel)

**Keybindings:**
- `Alt+Right/Left` - Next/previous step (when `debrief.replayActive`)
- `Space` - Toggle play/pause (when timeline focused)
- `Alt+Up/Down` - Speed up/down

**Settings:**
- `debrief.serverPort` (default: 53931)
- `debrief.autoStartServer` (default: true)
- `debrief.openaiApiKey` (string)
- `debrief.enableTts` (default: true)
- `debrief.ttsVoice` (enum: alloy, echo, fable, onyx, nova, shimmer)
- `debrief.ttsSpeed` (0.5-2.0, default: 1.0)

## Config Notes
**TypeScript:**
- Strict: `true`
- Target: `ES2022`
- Module: `CommonJS`
- Paths: None configured (relative imports)
- Source maps: enabled

**Build:**
- Uses esbuild (not tsc) for bundling
- Single entry point: `src/extension.ts`
- Output: `dist/extension.js`
- External: `vscode` (provided by host)
- Platform: `node`

**Linting:**
- No ESLint config found - relies on TypeScript strict mode

## Build/Package Requirements
| Command | Purpose |
|---------|---------|
| `npm install` | Install dependencies |
| `npm run build` | Compile via esbuild to `dist/` |
| `npm run watch` | Dev mode with file watching |
| `npm run package` | Create `.vsix` via `vsce package --no-dependencies` |

**Publishing checklist:**
- Must have valid `icon.png` (128x128 or 256x256)
- Must have `publisher` field (set to `muath-zaher`)
- Must have `repository` URL
- Must pass `vsce package` without errors
- `engines.vscode` specifies `^1.85.0` minimum
