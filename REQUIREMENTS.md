# CodeLens - Requirements Document

## Overview

A video rendering tool exposed via MCP. The calling agent provides fully-specified scenes (file, lines, narration, highlights), and the tool produces a narrated video.

**The agent does**: Code understanding, flow tracing, narration writing, scene planning

**The tool does**: TTS generation, video rendering, audio-visual sync

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                            AI Agent                                     │
│                                                                         │
│  1. User asks: "Explain the auth flow"                                 │
│  2. Agent explores codebase, reads files                               │
│  3. Agent constructs scenes with narration + visual cues               │
│  4. Agent calls generate_code_video with scene data                    │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         CodeLens MCP Tool                              │
│                                                                         │
│  Input: Scenes (file, code, narration, highlights)                     │
│                                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                │
│  │   TTS       │───▶│   Sync      │───▶│  Remotion   │                │
│  │  (OpenAI)   │    │   Engine    │    │  Renderer   │                │
│  └─────────────┘    └─────────────┘    └─────────────┘                │
│                                                                         │
│  Output: MP4 video file                                                │
└────────────────────────────────────────────────────────────────────────┘
```

---

## MCP Tool Definition

```typescript
{
  name: "generate_code_video",
  description: "Render a narrated code walkthrough video from provided scenes. Each scene shows a code snippet with optional line highlights, synchronized with narration.",
  inputSchema: {
    type: "object",
    properties: {
      scenes: {
        type: "array",
        description: "Ordered list of scenes to render",
        items: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path shown in the file tab (e.g., 'src/auth/login.ts')"
            },
            code: {
              type: "string", 
              description: "The code snippet to display"
            },
            language: {
              type: "string",
              description: "Language for syntax highlighting (e.g., 'typescript', 'python')"
            },
            narration: {
              type: "string",
              description: "Text to be spoken during this scene"
            },
            highlights: {
              type: "array",
              description: "Lines to highlight during narration",
              items: {
                type: "object",
                properties: {
                  lines: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 2,
                    maxItems: 2,
                    description: "[start_line, end_line] to highlight"
                  },
                  trigger_word: {
                    type: "string",
                    description: "Word in narration that triggers this highlight"
                  }
                },
                required: ["lines"]
              }
            }
          },
          required: ["file_path", "code", "language", "narration"]
        }
      },
      output_path: {
        type: "string",
        description: "Where to save the generated video"
      },
      options: {
        type: "object",
        properties: {
          voice: {
            type: "string",
            enum: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
            default: "onyx"
          },
          theme: {
            type: "string", 
            enum: ["dark", "light"],
            default: "dark"
          },
          resolution: {
            type: "string",
            enum: ["720p", "1080p"],
            default: "1080p"
          }
        }
      }
    },
    required: ["scenes", "output_path"]
  }
}
```

---

## Example Tool Call

The agent explores the codebase, understands the flow, then calls:

```json
{
  "name": "generate_code_video",
  "arguments": {
    "scenes": [
      {
        "file_path": "src/routes/auth.ts",
        "code": "router.post('/login', async (req, res) => {\n  const { email, password } = req.body;\n  const user = await findUserByEmail(email);\n  \n  if (!user || !await verifyPassword(password, user.hash)) {\n    return res.status(401).json({ error: 'Invalid credentials' });\n  }\n  \n  const token = generateJWT(user);\n  res.json({ token });\n});",
        "language": "typescript",
        "narration": "The login flow starts at the POST /login endpoint. It extracts the email and password from the request body, then looks up the user in the database.",
        "highlights": [
          { "lines": [1, 1], "trigger_word": "/login" },
          { "lines": [2, 2], "trigger_word": "extracts" },
          { "lines": [3, 3], "trigger_word": "database" }
        ]
      },
      {
        "file_path": "src/routes/auth.ts",
        "code": "router.post('/login', async (req, res) => {\n  const { email, password } = req.body;\n  const user = await findUserByEmail(email);\n  \n  if (!user || !await verifyPassword(password, user.hash)) {\n    return res.status(401).json({ error: 'Invalid credentials' });\n  }\n  \n  const token = generateJWT(user);\n  res.json({ token });\n});",
        "language": "typescript",
        "narration": "If the user doesn't exist or the password is wrong, we return a 401 unauthorized error. Otherwise, we generate a JWT token and send it back to the client.",
        "highlights": [
          { "lines": [5, 7], "trigger_word": "401" },
          { "lines": [9, 10], "trigger_word": "JWT" }
        ]
      },
      {
        "file_path": "src/utils/jwt.ts",
        "code": "export function generateJWT(user: User): string {\n  return jwt.sign(\n    { userId: user.id, email: user.email },\n    process.env.JWT_SECRET,\n    { expiresIn: '24h' }\n  );\n}",
        "language": "typescript",
        "narration": "The generateJWT function creates a signed token containing the user's ID and email. The token expires after 24 hours.",
        "highlights": [
          { "lines": [3, 3], "trigger_word": "ID and email" },
          { "lines": [5, 5], "trigger_word": "24 hours" }
        ]
      }
    ],
    "output_path": "/output/login-flow.mp4",
    "options": {
      "voice": "onyx",
      "theme": "dark"
    }
  }
}
```

---

## Internal Pipeline

### Step 1: Generate Audio

```typescript
import OpenAI from "openai";

interface AudioResult {
  buffer: Buffer;
  segments: SegmentTiming[];
}

interface SegmentTiming {
  sceneIndex: number;
  start: number;
  end: number;
  wordTimings: { word: string; start: number; end: number }[];
}

async function generateAudio(scenes: Scene[], voice: string): Promise<AudioResult> {
  const openai = new OpenAI();
  
  // Generate audio for each scene separately to get per-scene timings
  const segmentBuffers: Buffer[] = [];
  const segments: SegmentTiming[] = [];
  let currentTime = 0;
  
  for (let i = 0; i < scenes.length; i++) {
    // Generate speech
    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice: voice,
      input: scenes[i].narration,
      response_format: "mp3"
    });
    
    const buffer = Buffer.from(await speech.arrayBuffer());
    segmentBuffers.push(buffer);
    
    // Get word timings via Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: new File([buffer], "segment.mp3", { type: "audio/mp3" }),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word"]
    });
    
    const duration = transcription.duration;
    
    segments.push({
      sceneIndex: i,
      start: currentTime,
      end: currentTime + duration,
      wordTimings: transcription.words.map(w => ({
        word: w.word,
        start: currentTime + w.start,
        end: currentTime + w.end
      }))
    });
    
    currentTime += duration;
  }
  
  // Concatenate audio buffers
  const finalBuffer = await concatenateAudio(segmentBuffers);
  
  return { buffer: finalBuffer, segments };
}
```

### Step 2: Compute Timeline

```typescript
interface TimelineFrame {
  time: number;
  sceneIndex: number;
  activeHighlight: [number, number] | null;
}

function computeTimeline(
  scenes: Scene[], 
  segments: SegmentTiming[]
): TimelineFrame[] {
  const frames: TimelineFrame[] = [];
  
  for (const segment of segments) {
    const scene = scenes[segment.sceneIndex];
    
    // Find when each highlight should trigger
    const highlightTimes = scene.highlights?.map(h => {
      if (h.trigger_word) {
        // Find the word in the segment's word timings
        const wordTiming = segment.wordTimings.find(w => 
          w.word.toLowerCase().includes(h.trigger_word.toLowerCase())
        );
        return {
          lines: h.lines,
          start: wordTiming?.start ?? segment.start,
          end: wordTiming?.end ?? segment.end
        };
      }
      // No trigger word = highlight for entire segment
      return { lines: h.lines, start: segment.start, end: segment.end };
    }) ?? [];
    
    // Create frame entries
    frames.push({
      time: segment.start,
      sceneIndex: segment.sceneIndex,
      activeHighlight: null
    });
    
    for (const hl of highlightTimes) {
      frames.push({
        time: hl.start,
        sceneIndex: segment.sceneIndex,
        activeHighlight: hl.lines as [number, number]
      });
    }
  }
  
  return frames.sort((a, b) => a.time - b.time);
}
```

### Step 3: Render Video

```typescript
import { renderMedia, bundle } from "@remotion/renderer";

async function renderVideo(
  scenes: Scene[],
  audio: AudioResult,
  timeline: TimelineFrame[],
  outputPath: string,
  options: RenderOptions
) {
  const bundled = await bundle(require.resolve("./video/composition"));
  
  const totalDuration = audio.segments[audio.segments.length - 1].end;
  const fps = 30;
  
  await renderMedia({
    composition: "CodeWalkthrough",
    serveUrl: bundled,
    outputLocation: outputPath,
    codec: "h264",
    fps,
    durationInFrames: Math.ceil(totalDuration * fps),
    inputProps: {
      scenes,
      audioBase64: audio.buffer.toString("base64"),
      timeline,
      theme: options.theme,
      fps
    }
  });
}
```

---

## Remotion Components

### composition.tsx

```tsx
import { Composition } from "remotion";
import { CodeWalkthrough } from "./CodeWalkthrough";

export const RemotionRoot = () => {
  return (
    <Composition
      id="CodeWalkthrough"
      component={CodeWalkthrough}
      durationInFrames={300} // Overridden at render time
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
```

### CodeWalkthrough.tsx

```tsx
import { useCurrentFrame, Audio, Img } from "remotion";
import { CodeView } from "./CodeView";
import { FileTab } from "./FileTab";

interface Props {
  scenes: Scene[];
  audioBase64: string;
  timeline: TimelineFrame[];
  theme: "dark" | "light";
  fps: number;
}

export const CodeWalkthrough: React.FC<Props> = ({
  scenes,
  audioBase64,
  timeline,
  theme,
  fps
}) => {
  const frame = useCurrentFrame();
  const currentTime = frame / fps;
  
  // Find current state from timeline
  const currentState = timeline
    .filter(t => t.time <= currentTime)
    .pop() ?? timeline[0];
  
  const currentScene = scenes[currentState.sceneIndex];
  
  const bg = theme === "dark" ? "#1e1e1e" : "#ffffff";
  
  return (
    <div style={{ 
      width: "100%", 
      height: "100%", 
      backgroundColor: bg,
      display: "flex",
      flexDirection: "column"
    }}>
      <Audio src={`data:audio/mp3;base64,${audioBase64}`} />
      
      <FileTab 
        path={currentScene.file_path} 
        theme={theme} 
      />
      
      <CodeView
        code={currentScene.code}
        language={currentScene.language}
        highlightedLines={currentState.activeHighlight}
        theme={theme}
      />
    </div>
  );
};
```

### CodeView.tsx

```tsx
import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

interface Props {
  code: string;
  language: string;
  highlightedLines: [number, number] | null;
  theme: "dark" | "light";
}

export const CodeView: React.FC<Props> = ({ 
  code, 
  language, 
  highlightedLines,
  theme 
}) => {
  const [html, setHtml] = useState("");
  
  useEffect(() => {
    const shikiTheme = theme === "dark" ? "github-dark" : "github-light";
    codeToHtml(code, { 
      lang: language, 
      theme: shikiTheme 
    }).then(setHtml);
  }, [code, language, theme]);
  
  const lines = code.split("\n");
  
  return (
    <div style={{ 
      flex: 1, 
      padding: "24px",
      fontSize: "18px",
      fontFamily: "JetBrains Mono, monospace",
      lineHeight: 1.6,
      position: "relative",
      overflow: "hidden"
    }}>
      {/* Highlight overlay */}
      {highlightedLines && (
        <div style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${(highlightedLines[0] - 1) * 1.6 * 18 + 24}px`,
          height: `${(highlightedLines[1] - highlightedLines[0] + 1) * 1.6 * 18}px`,
          backgroundColor: theme === "dark" 
            ? "rgba(255, 255, 0, 0.15)" 
            : "rgba(255, 255, 0, 0.3)",
          borderLeft: "3px solid #f0c000",
          transition: "all 0.2s ease-out"
        }} />
      )}
      
      {/* Code with line numbers */}
      <div style={{ display: "flex" }}>
        <div style={{ 
          color: theme === "dark" ? "#666" : "#999",
          textAlign: "right",
          paddingRight: "16px",
          userSelect: "none"
        }}>
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
};
```

### FileTab.tsx

```tsx
interface Props {
  path: string;
  theme: "dark" | "light";
}

export const FileTab: React.FC<Props> = ({ path, theme }) => {
  const filename = path.split("/").pop();
  
  return (
    <div style={{
      backgroundColor: theme === "dark" ? "#252526" : "#f3f3f3",
      padding: "8px 16px",
      borderBottom: theme === "dark" 
        ? "1px solid #3c3c3c" 
        : "1px solid #e0e0e0",
      display: "flex",
      alignItems: "center",
      gap: "8px"
    }}>
      <span style={{ 
        color: theme === "dark" ? "#fff" : "#333",
        fontFamily: "system-ui"
      }}>
        {filename}
      </span>
      <span style={{ 
        color: theme === "dark" ? "#888" : "#666",
        fontSize: "12px",
        fontFamily: "system-ui"
      }}>
        {path}
      </span>
    </div>
  );
};
```

---

## File Structure

```
codelens/
├── package.json
├── tsconfig.json
├── remotion.config.ts
│
├── src/
│   ├── index.ts              # MCP server entry
│   ├── tool.ts               # Tool definition & handler
│   │
│   ├── audio/
│   │   └── tts.ts            # OpenAI TTS + Whisper
│   │
│   ├── timeline/
│   │   └── compute.ts        # Audio-visual sync logic
│   │
│   └── video/
│       ├── render.ts         # Remotion render wrapper
│       ├── composition.tsx   # Root composition
│       ├── CodeWalkthrough.tsx
│       ├── CodeView.tsx
│       └── FileTab.tsx
│
└── types.ts                  # Shared types
```

---

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@remotion/cli": "^4.0.0",
    "@remotion/renderer": "^4.0.0",
    "remotion": "^4.0.0",
    "react": "^18.0.0",
    "shiki": "^1.0.0",
    "openai": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/react": "^18.0.0"
  }
}
```

---

## Configuration

```typescript
interface Config {
  openai_api_key: string;   // For TTS only
  temp_dir: string;         // For intermediate files
}
```

No Anthropic API key needed — all intelligence is in the calling agent.

---

## Implementation Order

### Week 1
1. MCP server setup with tool definition
2. TTS generation with word timings
3. Basic Remotion composition (static)

### Week 2
1. Timeline computation (sync highlights to words)
2. Highlight animations
3. Scene transitions
4. Testing & polish

---

## Benefits of This Design

| Benefit | Why |
|---------|-----|
| **Simpler tool** | No LLM inside, just TTS + rendering |
| **Agent has full control** | Can iterate on scenes before generating |
| **Better context** | Agent already understands the codebase |
| **Easier testing** | Deterministic: same input = same output |
| **Cheaper** | No Claude API calls in the tool |
| **More flexible** | Agent can explain anything, any way |

---

## Error Handling

```typescript
interface ToolResult {
  success: boolean;
  video_path?: string;
  duration?: number;
  error?: {
    code: "INVALID_SCENES" | "TTS_FAILED" | "RENDER_FAILED";
    message: string;
  };
}
```

Validation:
- At least one scene required
- Each scene must have file_path, code, language, narration
- Highlight line numbers must be within code range
- Output path must be writable

---

*End of Document*