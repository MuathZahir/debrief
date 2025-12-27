import { z } from "zod";
import { generateAudio } from "./audio/tts.js";
import { computeTimeline } from "./timeline/compute.js";
import { renderVideo } from "./video/render.js";
import type { Scene, GenerateVideoInput, ToolResult, RenderOptions } from "./types.js";

/**
 * Zod schema for highlight
 */
const HighlightSchema = z.object({
  lines: z.tuple([z.number(), z.number()]),
  trigger_word: z.string().optional(),
});

/**
 * Zod schema for scene
 */
const SceneSchema = z.object({
  file_path: z.string().min(1),
  code: z.string().min(1),
  language: z.string().min(1),
  narration: z.string().min(1),
  highlights: z.array(HighlightSchema).optional(),
});

/**
 * Zod schema for render options
 */
const RenderOptionsSchema = z.object({
  voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
  theme: z.enum(["dark", "light"]).optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
});

/**
 * Zod schema for the tool input
 */
export const GenerateVideoInputSchema = z.object({
  scenes: z.array(SceneSchema).min(1, "At least one scene is required"),
  output_path: z.string().min(1, "Output path is required"),
  options: RenderOptionsSchema.optional(),
});

/**
 * Tool definition for MCP
 */
export const toolDefinition = {
  name: "generate_code_video",
  description:
    "Render a narrated code walkthrough video from provided scenes. Each scene shows a code snippet with optional line highlights, synchronized with narration.",
  inputSchema: {
    type: "object" as const,
    properties: {
      scenes: {
        type: "array" as const,
        description: "Ordered list of scenes to render",
        items: {
          type: "object" as const,
          properties: {
            file_path: {
              type: "string" as const,
              description: "Path shown in the file tab (e.g., 'src/auth/login.ts')",
            },
            code: {
              type: "string" as const,
              description: "The code snippet to display",
            },
            language: {
              type: "string" as const,
              description: "Language for syntax highlighting (e.g., 'typescript', 'python')",
            },
            narration: {
              type: "string" as const,
              description: "Text to be spoken during this scene",
            },
            highlights: {
              type: "array" as const,
              description: "Lines to highlight during narration",
              items: {
                type: "object" as const,
                properties: {
                  lines: {
                    type: "array" as const,
                    items: { type: "number" as const },
                    minItems: 2,
                    maxItems: 2,
                    description: "[start_line, end_line] to highlight",
                  },
                  trigger_word: {
                    type: "string" as const,
                    description: "Word in narration that triggers this highlight",
                  },
                },
                required: ["lines"],
              },
            },
          },
          required: ["file_path", "code", "language", "narration"],
        },
      },
      output_path: {
        type: "string" as const,
        description: "Where to save the generated video",
      },
      options: {
        type: "object" as const,
        properties: {
          voice: {
            type: "string" as const,
            enum: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
            default: "onyx",
          },
          theme: {
            type: "string" as const,
            enum: ["dark", "light"],
            default: "dark",
          },
          resolution: {
            type: "string" as const,
            enum: ["720p", "1080p"],
            default: "1080p",
          },
        },
      },
    },
    required: ["scenes", "output_path"],
  },
};

/**
 * Validate highlight line numbers are within code range
 */
function validateHighlights(scenes: Scene[]): string | null {
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const lineCount = scene.code.split("\n").length;

    if (scene.highlights) {
      for (const highlight of scene.highlights) {
        const [start, end] = highlight.lines;
        if (start < 1 || end > lineCount || start > end) {
          return `Scene ${i + 1}: Highlight lines [${start}, ${end}] are invalid (code has ${lineCount} lines)`;
        }
      }
    }
  }
  return null;
}

/**
 * Handle the generate_code_video tool call
 */
export async function handleGenerateVideo(
  input: unknown,
  tempDir: string = "./temp"
): Promise<ToolResult> {
  // Validate input
  const parseResult = GenerateVideoInputSchema.safeParse(input);
  if (!parseResult.success) {
    return {
      success: false,
      error: {
        code: "INVALID_SCENES",
        message: parseResult.error.issues.map((i) => i.message).join(", "),
      },
    };
  }

  const { scenes, output_path, options } = parseResult.data;

  // Validate highlights
  const highlightError = validateHighlights(scenes);
  if (highlightError) {
    return {
      success: false,
      error: {
        code: "INVALID_SCENES",
        message: highlightError,
      },
    };
  }

  try {
    // Step 1: Generate audio with word timings
    console.log("Generating audio...");
    const voice = options?.voice ?? "onyx";
    const audio = await generateAudio(scenes, voice, tempDir);

    // Step 2: Compute timeline
    console.log("Computing timeline...");
    const timeline = computeTimeline(scenes, audio.segments);

    // Step 3: Render video
    console.log("Rendering video...");
    await renderVideo({
      scenes,
      audio,
      timeline,
      outputPath: output_path,
      options: options as RenderOptions,
    });

    // Calculate duration
    const lastSegment = audio.segments[audio.segments.length - 1];
    const duration = lastSegment?.end ?? 0;

    return {
      success: true,
      video_path: output_path,
      duration,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    // Determine error type
    if (message.includes("TTS") || message.includes("openai") || message.includes("speech")) {
      return {
        success: false,
        error: {
          code: "TTS_FAILED",
          message,
        },
      };
    }

    return {
      success: false,
      error: {
        code: "RENDER_FAILED",
        message,
      },
    };
  }
}
