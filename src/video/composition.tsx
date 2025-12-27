import React from "react";
import { Composition, registerRoot } from "remotion";
import { CodeWalkthrough, type CodeWalkthroughProps } from "./CodeWalkthrough";
import type { Scene, TimelineFrame } from "../types";

// Default props for Remotion Studio preview
const defaultProps = {
  scenes: [
    {
      file_path: "src/example.ts",
      code: `export function greet(name: string): string {
  const message = "Hello, " + name + "!";
  console.log(message);
  return message;
}

// Call the function
const result = greet("World");
console.log(result);`,
      language: "typescript",
      narration: "This is an example function that greets a user.",
      highlights: [{ lines: [1, 4] as [number, number] }],
    },
  ] as Scene[],
  audioBase64: "",
  timeline: [
    { time: 0, sceneIndex: 0, activeHighlight: null },
    { time: 1, sceneIndex: 0, activeHighlight: [1, 4] as [number, number] },
  ] as TimelineFrame[],
  theme: "dark" as const,
  fps: 30,
  resolution: "1080p",
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="CodeWalkthrough"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component={CodeWalkthrough as any}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={defaultProps}
      />
    </>
  );
};

registerRoot(RemotionRoot);
