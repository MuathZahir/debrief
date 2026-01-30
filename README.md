# Debrief

**Narrated code walkthroughs in VS Code** — Load a trace file and get a guided tour of your codebase with synchronized TTS narration and line-by-line highlights.

<!-- ![Debrief Demo](docs/demo.gif) -->

## Features

- **TTS Narration** — AI-generated voice explains the code as you step through
- **Synchronized Highlights** — Lines highlight exactly when the narration mentions them
- **Timeline View** — Visual overview of all steps in the sidebar
- **Keyboard Navigation** — `Alt+Left/Right` to move between steps
- **Natural Flow** — Narration sounds like a senior engineer explaining code

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Press `Ctrl+Shift+X` to open Extensions
3. Search for **"Debrief"**
4. Click Install

### From Source

```bash
git clone https://github.com/MuathZahir/debrief.git
cd debrief
npm install
npm run build
```

Press `F5` to launch the Extension Development Host.

## Quick Start

1. Set your OpenAI API key:
   - VS Code Settings → `debrief.openaiApiKey`
   - Or set `OPENAI_API_KEY` environment variable

2. Open your project in VS Code

3. Press `Ctrl+Shift+P` → **"Debrief: Load Replay..."**

4. Select a `.jsonl` trace file

5. Use `Alt+Right` / `Alt+Left` to navigate steps

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Right` | Next step |
| `Alt+Left` | Previous step |
| `Alt+Up` | Speed up playback |
| `Alt+Down` | Slow down playback |
| `Space` | Play/Pause (when timeline focused) |

## Creating Traces

Traces are JSONL files where each line is a step:

```jsonl
{"id":"e1","type":"highlightRange","filePath":"src/auth.ts","range":{"startLine":10,"startCol":0,"endLine":25,"endCol":0},"title":"Auth setup","narration":"Let's look at authentication. <line:12>This line grabs the JWT token from the header</line:12>, and <line:18>here we verify it against our secret</line:18>."}
{"id":"e2","type":"say","title":"Summary","narration":"That's the core auth flow. Simple but secure."}
```

### Event Types

| Type | Purpose |
|------|---------|
| `highlightRange` | Open file and highlight lines (main event type) |
| `say` | Narration only, no file changes |
| `openFile` | Open a file without highlighting |
| `showDiff` | Show a diff between two versions |
| `sectionStart` | Begin a logical section (silent) |
| `sectionEnd` | End a section |

### Line References

Highlight specific lines when spoken using `<line:X>text</line:X>`:

```json
{"narration": "<line:42>This function handles retry logic with exponential backoff</line:42>. It's the key to our reliability."}
```

- Line 42 highlights in amber when "This function" is spoken
- Highlight stays visible through "backoff"
- Text inside tags is spoken naturally

**Important:** Include the full explanation inside the tags so highlights last long enough:

```
// Too short - highlight flashes briefly
"<line:42>This</line:42> handles retries"

// Good - highlight visible during explanation
"<line:42>This handles retries with exponential backoff</line:42>"
```

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
  metadata?: Record<string, unknown>;
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

## Agent Integration

The extension runs a local HTTP server for AI agent integration:

```bash
# Send a highlight event
curl -X POST http://localhost:53931/event \
  -H "Content-Type: application/json" \
  -d '{"type":"show","filePath":"src/index.ts","startLine":10,"endLine":20}'

# Clear highlights
curl -X POST http://localhost:53931/event \
  -H "Content-Type: application/json" \
  -d '{"type":"clear"}'
```

## Examples

The `examples/` folder contains sample traces:

- `mcp-server-walkthrough.jsonl` — MCP server implementation walkthrough
- `trace-natural.jsonl` — Natural narration style example

## Requirements

- VS Code 1.85.0+
- OpenAI API key (for TTS)
- Node.js 18+ (development only)

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add feature'`)
4. Push (`git push origin feature/amazing`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built for use with [Claude Code](https://claude.ai/code) and AI coding assistants.
