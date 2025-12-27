import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import type { Scene, AudioResult, TimelineFrame, RenderOptions } from "../types";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Find the composition file - handles both development (src) and production (dist) scenarios
 */
function findCompositionPath(): string {
  // Try the current directory first (when running from src with tsx)
  const localPath = join(__dirname, "composition.tsx");
  if (existsSync(localPath)) {
    return localPath;
  }

  // If running from dist, look for src version
  const srcPath = resolve(__dirname, "../../src/video/composition.tsx");
  if (existsSync(srcPath)) {
    return srcPath;
  }

  // Fallback: try to find project root and locate src
  const projectRoot = resolve(__dirname, "../..");
  const projectSrcPath = join(projectRoot, "src/video/composition.tsx");
  if (existsSync(projectSrcPath)) {
    return projectSrcPath;
  }

  throw new Error(`Cannot find composition.tsx. Searched: ${localPath}, ${srcPath}, ${projectSrcPath}`);
}

interface RenderInput {
  scenes: Scene[];
  audio: AudioResult;
  timeline: TimelineFrame[];
  outputPath: string;
  options?: RenderOptions;
}

/**
 * Resolution configurations
 */
const RESOLUTION_CONFIGS: Record<string, { width: number; height: number; resolutionKey: string }> = {
  '720p': { width: 1280, height: 720, resolutionKey: '720p' },
  '1080p': { width: 1920, height: 1080, resolutionKey: '1080p' },
  '1440p': { width: 2560, height: 1440, resolutionKey: '1440p' },
  '4k': { width: 3840, height: 2160, resolutionKey: '4k' },
};

/**
 * Render the video using Remotion with high-quality settings
 */
export async function renderVideo(input: RenderInput): Promise<void> {
  const { scenes, audio, timeline, outputPath, options = {} } = input;

  const theme = options.theme ?? "dark";
  const resolution = options.resolution ?? "1080p";
  const fps = 30;

  // Get resolution configuration
  const resConfig = RESOLUTION_CONFIGS[resolution] ?? RESOLUTION_CONFIGS['1080p'];
  const { width, height, resolutionKey } = resConfig;

  // Calculate total duration from the last segment
  const lastSegment = audio.segments[audio.segments.length - 1];
  const totalDuration = lastSegment?.end ?? 5;
  const durationInFrames = Math.ceil(totalDuration * fps);

  console.log(`Rendering ${width}x${height} video at ${fps}fps, ${durationInFrames} frames`);

  // Bundle the Remotion composition
  const compositionPath = findCompositionPath();
  console.log(`Using composition: ${compositionPath}`);
  const bundled = await bundle({
    entryPoint: compositionPath,
    onProgress: (progress) => {
      if (progress % 25 === 0) {
        console.log(`Bundling: ${progress}%`);
      }
    },
  });

  // Prepare input props with resolution info
  const inputProps = {
    scenes,
    audioBase64: audio.buffer.toString("base64"),
    timeline,
    theme,
    fps,
    resolution: resolutionKey,
  };

  // Select the composition
  const composition = await selectComposition({
    serveUrl: bundled,
    id: "CodeWalkthrough",
    inputProps,
  });

  // Override composition settings
  const finalComposition = {
    ...composition,
    width,
    height,
    fps,
    durationInFrames,
  };

  // Render the video with high-quality settings
  await renderMedia({
    composition: finalComposition,
    serveUrl: bundled,
    outputLocation: outputPath,
    codec: "h264",
    // High quality encoding settings
    crf: 18, // Lower = better quality (18-23 recommended for code videos)
    pixelFormat: "yuv420p", // Best compatibility
    inputProps,
    onProgress: ({ progress }) => {
      const percent = Math.round(progress * 100);
      if (percent % 10 === 0) {
        console.log(`Rendering: ${percent}%`);
      }
    },
    // Chromium flags for better font rendering
    chromiumOptions: {
      disableWebSecurity: true,
      enableMultiProcessOnLinux: true,
    },
  });

  console.log(`Video rendered to: ${outputPath}`);
  console.log(`Resolution: ${width}x${height}, Quality: CRF 18`);
}
