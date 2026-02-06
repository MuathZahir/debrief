# Development Guide

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

## Building from Source

```bash
git clone https://github.com/MuathZahir/debrief.git
cd debrief
npm install
npm run build
```

## Creating Traces

Traces are JSONL files where each line is a step:

```jsonl
{"id":"s1","type":"sectionStart","title":"Authentication","narration":""}
{"id":"e1","type":"highlightRange","filePath":"src/auth.ts","range":{"startLine":10,"startCol":0,"endLine":18,"endCol":0},"title":"Token extraction","narration":"Let's start with how we grab the token from the request."}
{"id":"e2","type":"highlightRange","filePath":"src/auth.ts","range":{"startLine":20,"startCol":0,"endLine":25,"endCol":0},"title":"Token verification","narration":"Once we have it, we verify it against our secret."}
{"id":"s1e","type":"sectionEnd","title":"","narration":""}
{"id":"e3","type":"say","title":"Summary","narration":"That's the core auth flow. Simple but secure."}
```

### Event Types

| Type | Purpose |
|------|---------|
| `highlightRange` | Open file and highlight a code range (primary event) |
| `say` | Narration only, no file navigation |
| `openFile` | Open a file without highlighting |
| `showDiff` | Show a diff between two versions |
| `sectionStart` | Begin a logical section (groups steps in timeline) |
| `sectionEnd` | End a section |

### Full Event Schema

```typescript
interface TraceEvent {
  id: string;                    // Unique ID (e.g., "e1", "e2")
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
  comment?: string;              // User feedback (saved when user adds comment)
  risks?: Array<{                // Agent-specified risks
    category: string;            // e.g., "security", "breaking-change"
    label: string;               // Human-readable description
  }>;
}
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `debrief.enableTts` | `true` | Enable TTS narration |
| `debrief.ttsVoice` | `alloy` | Voice: alloy, echo, fable, onyx, nova, shimmer |
| `debrief.ttsSpeed` | `1.0` | Speed (0.5 - 2.0) |
| `debrief.openaiApiKey` | `""` | OpenAI API key |
| `debrief.serverPort` | `53931` | HTTP server port |
| `debrief.autoStartServer` | `true` | Auto-start HTTP server |

## Examples

The `examples/` folder contains sample traces:

- `onboarding.jsonl` — Architecture walkthrough for new contributors
- `sample-walkthrough.jsonl` — Comprehensive example
- `trace-natural.jsonl` — Natural narration style

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add feature'`)
4. Push (`git push origin feature/amazing`)
5. Open a Pull Request
