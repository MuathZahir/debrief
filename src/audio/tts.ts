import OpenAI from "openai";
import { spawn } from "child_process";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import type { Scene, AudioResult, SegmentTiming, WordTiming } from "../types.js";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

/**
 * Generate audio for all scenes with word-level timing
 */
export async function generateAudio(
  scenes: Scene[],
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "onyx",
  tempDir: string = "./temp"
): Promise<AudioResult> {
  const openai = getOpenAI();

  // Ensure temp directory exists
  await mkdir(tempDir, { recursive: true });

  const segmentBuffers: Buffer[] = [];
  const segments: SegmentTiming[] = [];
  let currentTime = 0;
  const tempFiles: string[] = [];

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      // Generate speech using OpenAI TTS
      const speech = await openai.audio.speech.create({
        model: "tts-1",
        voice: voice,
        input: scene.narration,
        response_format: "mp3",
      });

      const buffer = Buffer.from(await speech.arrayBuffer());
      segmentBuffers.push(buffer);

      // Save to temp file for Whisper transcription
      const tempFilePath = join(tempDir, `segment_${i}_${randomUUID()}.mp3`);
      await writeFile(tempFilePath, buffer);
      tempFiles.push(tempFilePath);

      // Get word timings via Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: await createReadableFile(tempFilePath, buffer),
        model: "whisper-1",
        response_format: "verbose_json",
        timestamp_granularities: ["word"],
      });

      const duration = transcription.duration ?? estimateDuration(scene.narration);
      const words = (transcription as TranscriptionWithWords).words ?? [];

      const wordTimings: WordTiming[] = words.map((w) => ({
        word: w.word,
        start: currentTime + w.start,
        end: currentTime + w.end,
      }));

      segments.push({
        sceneIndex: i,
        start: currentTime,
        end: currentTime + duration,
        wordTimings,
      });

      currentTime += duration;
    }

    // Concatenate audio buffers using FFmpeg
    const finalBuffer = await concatenateAudio(segmentBuffers, tempDir);

    return { buffer: finalBuffer, segments };
  } finally {
    // Clean up temp files
    for (const tempFile of tempFiles) {
      try {
        await unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Create a File-like object for the OpenAI API
 */
async function createReadableFile(
  path: string,
  buffer: Buffer
): Promise<File> {
  // Convert Buffer to Uint8Array for File constructor compatibility
  const uint8Array = new Uint8Array(buffer);
  return new File([uint8Array], path.split("/").pop() ?? "audio.mp3", {
    type: "audio/mp3",
  });
}

/**
 * Estimate audio duration based on text (fallback)
 * Average speaking rate is ~150 words per minute
 */
function estimateDuration(text: string): number {
  const wordCount = text.split(/\s+/).length;
  return (wordCount / 150) * 60;
}

/**
 * Concatenate audio buffers using FFmpeg
 */
async function concatenateAudio(
  buffers: Buffer[],
  tempDir: string
): Promise<Buffer> {
  if (buffers.length === 0) {
    throw new Error("No audio buffers to concatenate");
  }

  if (buffers.length === 1) {
    return buffers[0];
  }

  // Resolve to absolute path to avoid working directory issues
  const absoluteTempDir = resolve(tempDir);
  await mkdir(absoluteTempDir, { recursive: true });

  const sessionId = randomUUID();
  const inputFiles: string[] = [];
  const listFile = join(absoluteTempDir, `concat_${sessionId}.txt`);
  const outputFile = join(absoluteTempDir, `output_${sessionId}.mp3`);

  try {
    // Write each buffer to a temp file with absolute paths
    for (let i = 0; i < buffers.length; i++) {
      const inputPath = join(absoluteTempDir, `input_${sessionId}_${i}.mp3`);
      await writeFile(inputPath, buffers[i]);
      inputFiles.push(inputPath);
    }

    // Create FFmpeg concat list file with absolute paths
    // Use forward slashes for FFmpeg compatibility on Windows
    const listContent = inputFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join("\n");
    await writeFile(listFile, listContent);

    // Run FFmpeg to concatenate
    await runFFmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      outputFile,
    ]);

    // Read the output file
    const { readFile } = await import("fs/promises");
    const result = await readFile(outputFile);

    return result;
  } finally {
    // Clean up temp files
    for (const file of [...inputFiles, listFile, outputFile]) {
      try {
        await unlink(file);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Run FFmpeg with given arguments
 */
function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`FFmpeg error: ${err.message}`));
    });
  });
}

/**
 * Type for Whisper response with word-level timestamps
 */
interface TranscriptionWithWords {
  duration?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
}
