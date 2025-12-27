/**
 * Highlight definition for a scene
 */
export interface Highlight {
  /** [start_line, end_line] to highlight (1-indexed) */
  lines: [number, number];
  /** Word in narration that triggers this highlight */
  trigger_word?: string;
}

/**
 * A single scene in the video
 */
export interface Scene {
  /** Path shown in the file tab (e.g., 'src/auth/login.ts') */
  file_path: string;
  /** The code snippet to display */
  code: string;
  /** Language for syntax highlighting (e.g., 'typescript', 'python') */
  language: string;
  /** Text to be spoken during this scene */
  narration: string;
  /** Lines to highlight during narration */
  highlights?: Highlight[];
}

/**
 * Options for video generation
 */
export interface RenderOptions {
  /** Voice for TTS */
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  /** Color theme */
  theme?: "dark" | "light";
  /** Video resolution */
  resolution?: "720p" | "1080p" | "1440p" | "4k";
}

/**
 * Word timing from Whisper transcription
 */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/**
 * Timing information for a single scene's audio segment
 */
export interface SegmentTiming {
  sceneIndex: number;
  start: number;
  end: number;
  wordTimings: WordTiming[];
}

/**
 * Result from audio generation
 */
export interface AudioResult {
  buffer: Buffer;
  segments: SegmentTiming[];
}

/**
 * A frame in the timeline representing visual state at a point in time
 */
export interface TimelineFrame {
  time: number;
  sceneIndex: number;
  activeHighlight: [number, number] | null;
}

/**
 * Tool input schema
 */
export interface GenerateVideoInput {
  scenes: Scene[];
  output_path: string;
  options?: RenderOptions;
}

/**
 * Tool result
 */
export interface ToolResult {
  success: boolean;
  video_path?: string;
  duration?: number;
  error?: {
    code: "INVALID_SCENES" | "TTS_FAILED" | "RENDER_FAILED";
    message: string;
  };
}

/**
 * Props for the CodeWalkthrough Remotion composition
 */
export interface CodeWalkthroughProps {
  scenes: Scene[];
  audioBase64: string;
  timeline: TimelineFrame[];
  theme: "dark" | "light";
  fps: number;
  resolution?: string;
}

/**
 * Props for CodeView component
 */
export interface CodeViewProps {
  code: string;
  language: string;
  highlightedLines: [number, number] | null;
  theme: "dark" | "light";
  resolution?: string;
}

/**
 * Props for FileTab component
 */
export interface FileTabProps {
  path: string;
  theme: "dark" | "light";
  resolution?: string;
}

/**
 * Configuration for the CodeLens server
 */
export interface Config {
  openaiApiKey: string;
  tempDir: string;
}
