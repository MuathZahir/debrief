/**
 * Test example for CodeLens video generation
 *
 * This script tests the full pipeline:
 * 1. TTS generation with word timing
 * 2. Timeline computation
 * 3. Video rendering with Remotion
 *
 * Usage:
 *   1. Create .env file with OPENAI_API_KEY
 *   2. Run: npx tsx test/example.ts
 */

import "dotenv/config";
import { handleGenerateVideo } from "../src/tool.js";
import { mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // Ensure output directory exists
  const outputDir = join(__dirname, "output");
  await mkdir(outputDir, { recursive: true });

  // Define test scenes
  const scenes = [
    {
      file_path: "src/utils/greet.ts",
      code: `export function greet(name: string): string {
  const greeting = "Hello, " + name + "!";
  console.log(greeting);
  return greeting;
}`,
      language: "typescript",
      narration:
        "This function takes a name parameter and creates a personalized greeting. It logs the greeting to the console and returns it.",
      highlights: [
        { lines: [1, 1] as [number, number], trigger_word: "name" },
        { lines: [2, 2] as [number, number], trigger_word: "greeting" },
        { lines: [3, 3] as [number, number], trigger_word: "logs" },
        { lines: [4, 4] as [number, number], trigger_word: "returns" },
      ],
    },
    {
      file_path: "src/index.ts",
      code: `import { greet } from "./utils/greet";

const message = greet("World");
console.log("Result:", message);`,
      language: "typescript",
      narration:
        "We import the greet function and call it with World as the argument. The result is then logged to the console.",
      highlights: [
        { lines: [1, 1] as [number, number], trigger_word: "import" },
        { lines: [3, 3] as [number, number], trigger_word: "call" },
        { lines: [4, 4] as [number, number], trigger_word: "logged" },
      ],
    },
  ];

  const outputPath = join(outputDir, "test-video.mp4");

  console.log("Starting CodeLens test...");
  console.log(`Output will be saved to: ${outputPath}`);
  console.log("");

  const result = await handleGenerateVideo(
    {
      scenes,
      output_path: outputPath,
      options: {
        voice: "onyx",
        theme: "dark",
        resolution: "1080p",
      },
    },
    join(__dirname, "temp")
  );

  console.log("");
  console.log("Result:", JSON.stringify(result, null, 2));

  if (result.success) {
    console.log("");
    console.log("Success! Video generated at:", result.video_path);
    console.log("Duration:", result.duration?.toFixed(2), "seconds");
  } else {
    console.error("Failed:", result.error?.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
