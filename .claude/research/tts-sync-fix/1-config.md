# TTS Configuration Analysis

## Project: Debrief (VS Code Extension)
TTS narrated code walkthroughs with synchronized line highlights.

## TTS Configuration Settings (package.json)

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `debrief.openaiApiKey` | string | "" | - | OpenAI API key |
| `debrief.enableTts` | boolean | true | - | Enable/disable TTS |
| `debrief.ttsVoice` | enum | "alloy" | alloy/echo/fable/onyx/nova/shimmer | Voice selection |
| `debrief.ttsSpeed` | number | 1.15 | 0.5-2.0 | Playback speed |

## TTS Architecture

### Components
1. **TtsPlayer** (`src/audio/ttsPlayer.ts`) - Core TTS engine
2. **ReplayEngine** (`src/replay/engine.ts`) - Orchestrates playback
3. **HighlightScheduler** (`src/util/highlightScheduler.ts`) - Times highlights
4. **HighlightTimeline** (`src/util/highlightTimeline.ts`) - Builds event timeline
5. **LineRefParser** (`src/util/lineRefParser.ts`) - Parses `<line:X>` syntax

### TTS Flow
1. TtsPlayer calls OpenAI TTS API (`tts-1-hd` model)
2. Audio cached to temp directory (`os.tmpdir()/debrief-tts/`)
3. Whisper API transcribes for word-level timings
4. HighlightTimeline builds events from word timings + line refs
5. HighlightScheduler fires setTimeout-based highlight events
6. System audio player (PowerShell/afplay/paplay) plays audio

### Audio Playback Commands
| Platform | Command | Startup Delay |
|----------|---------|---------------|
| Windows | PowerShell + MediaPlayer | 700ms |
| macOS | afplay | 50ms |
| Linux | paplay (fallback: aplay) | 100ms |

## Key Issues Identified

### 1. Robotic Voice
- Using `tts-1-hd` model (good quality)
- Default voice: `alloy` - described as "neutral, balanced"
- Speed: 1.15x (slightly faster than normal)
- **Potential fix**: Try different voice (echo/nova) or reduce speed to 1.0

### 2. Large Gaps Between Sections
- `waitForTtsAndScheduleAdvance()` waits for TTS completion
- After TTS completes: adds 150ms pause (non-cancelled) or 50ms (cancelled)
- No narration: uses 1500ms fixed delay
- **Potential fix**: Reduce pause durations

### 3. Highlight Sync Issues
- **Windows startup delay**: 700ms estimated for PowerShell MediaPlayer
- Callback fires via `setTimeout(onAudioStart, startupDelayMs)`
- Word timing relies on Whisper transcription matching
- Fuzzy matching with Levenshtein distance for mismatch tolerance
- **Potential fix**: Adjust startupDelayMs values, improve word matching

## Dependencies
- `dotenv: ^16.4.0` - .env file loading
- `zod: ^3.23.0` - Schema validation
- No audio-specific npm packages (uses native system players)

## API Endpoints Used
1. `https://api.openai.com/v1/audio/speech` - TTS generation
2. `https://api.openai.com/v1/audio/transcriptions` - Whisper (word timings)

## Cache System
- Audio: `Map<cacheKey, filePath>` - keyed by text hash
- Timings: `Map<cacheKey, WordTiming[]>` - Whisper results
- Cleared on dispose or explicit `clearCache()`

## Configuration Locations (priority order)
1. VS Code settings (`debrief.*`)
2. Environment variable `OPENAI_API_KEY`
3. Workspace `.env` file
4. `extensions/debrief/.env` file
