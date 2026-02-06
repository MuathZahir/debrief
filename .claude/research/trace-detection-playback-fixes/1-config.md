# Config Analysis: trace-detection-playback-fixes

## Spec Summary
- File watcher glob is too narrow (`trace.jsonl` only); must change to `**/*.jsonl` under `.debrief/replay/`
- Notification "Walk Me Through It" has a race condition: timeline webview may not be ready when `onSessionLoaded` fires, causing empty sidebar
- Stepping between steps while audio plays does not stop previous TTS, causing overlapping narration
- Debounce should be tracked per-file URI, not with a single global timer
- Auto-play should trigger only from notification action, NOT from manual "Load Replay" command

## Project Rules
**Must do:**
- Use `npm run build` (esbuild) to compile; entry point is `src/extension.ts`
- Test via F5 (Extension Development Host)
- Set `OPENAI_API_KEY` env var for TTS
- Node.js 18+, VS Code engine `^1.85.0`
- TTS-first pattern: audio starts before file navigation
- Graceful degradation: static highlights if Whisper unavailable
- Audio process kill must be synchronous (no lingering audio after `stop()`)

**Must NOT do:**
- Do not redesign the timeline sidebar UI
- Do not add new notification actions beyond current set
- Do not change the TTS engine or voice
- Manual "Load Replay" command must NOT auto-play

**Style:**
- TypeScript strict mode enabled
- CommonJS module format (esbuild bundles to CJS)
- No eslint config in project (no linter enforced)
- Source maps enabled; minification disabled

## Key Dependencies
| Package | Version | Notes |
|---------|---------|-------|
| vscode (engine) | ^1.85.0 | VS Code API; external in esbuild bundle |
| typescript | ^5.3.0 | devDep; strict mode |
| esbuild | ^0.24.0 | Bundler (replaces tsc for output); `node esbuild.js` |
| zod | ^3.23.0 | Schema validation (likely trace parsing) |
| dotenv | ^16.4.0 | Loads `.env` for OPENAI_API_KEY |
| @types/vscode | ^1.85.0 | VS Code type definitions |
| @types/node | ^20.0.0 | Node type definitions |

## Config Notes
- **TypeScript:** strict: true, target: ES2022, module: CommonJS, rootDir: `./src`, outDir: `./dist`, sourceMap: true, no path aliases
- **Build:** esbuild bundles `src/extension.ts` -> `dist/extension.js`, CJS format, `vscode` is external, target es2022, no minification
- **Linting:** None configured at project level (no eslint config found)
- **Required env vars:** `OPENAI_API_KEY` (also configurable via `debrief.openaiApiKey` setting)

## CI Requirements
- No CI/CD workflows configured for this project (no `.github/workflows/` in project root)
- Only check: `npm run build` must succeed (TypeScript compilation via esbuild)
- Package command: `npx @vscode/vsce package --no-dependencies`
