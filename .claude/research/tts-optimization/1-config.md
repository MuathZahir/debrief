# Config Analysis: tts-optimization

## Spec Summary
- Remove Whisper API calls entirely (currently used for word-level timings)
- Pre-generate TTS for all steps when trace loads (zero delay during playback)
- Show pre-generation progress in timeline sidebar
- Steps within sections: ~100ms pause; outside sections: ~75ms pause
- Delete `highlightTimeline.ts`, `highlightScheduler.ts`; simplify `lineRefParser.ts`

## Project Rules
**Must do:**
- Use OpenAI TTS API (stay with current provider)
- TTS-first pattern: audio starts before file navigation
- Graceful degradation: visual-only playback if TTS unavailable
- Cache TTS results to avoid regeneration
- Retry failed TTS with exponential backoff (up to 3 attempts)

**Must NOT do:**
- Do NOT change TTS provider
- Do NOT store audio in trace files (ahead-of-time caching)
- Do NOT support mid-narration highlight changes (replaced by atomic steps)

**Style:**
- VS Code extension patterns
- System audio playback (PowerShell on Windows, afplay on macOS)
- JSONL trace format with typed events

## Key Dependencies
| Package | Version | Notes |
|---------|---------|-------|
| vscode | ^1.85.0 | VS Code extension API |
| typescript | ^5.3.0 | Build |
| dotenv | ^16.4.0 | Env var loading |
| zod | ^3.23.0 | Schema validation |

## Config Notes
- **TypeScript:** strict=true, target=ES2022, module=CommonJS, no paths aliases
- **ESLint:** No config found
- **Required env vars:** `OPENAI_API_KEY` (or `debrief.openaiApiKey` setting)
- **Build:** esbuild (custom `esbuild.js`)

## Files to Modify (from spec)
| File | Action |
|------|--------|
| `src/audio/ttsPlayer.ts` | Remove Whisper, add `pregenerate(texts[])` |
| `src/replay/engine.ts` | Track section state, trigger pre-generation |
| `src/replay/handlers/highlightRange.ts` | Remove timed line ref parsing |
| `src/ui/timelineView.ts` | Add progress indicator, collapsible sections |
| `src/util/highlightTimeline.ts` | DELETE |
| `src/util/highlightScheduler.ts` | DELETE |
| `src/util/lineRefParser.ts` | Remove `<line:X>` XML syntax |
