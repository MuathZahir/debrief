import React from 'react';
import { useCurrentFrame, Audio, useVideoConfig } from 'remotion';
import { CodeView } from './CodeView';
import { FileTab } from './FileTab';
import { getTheme } from './themes/editor';
import type { Scene, TimelineFrame } from '../types';

export interface CodeWalkthroughProps {
  scenes: Scene[];
  audioBase64: string;
  timeline: TimelineFrame[];
  theme: 'dark' | 'light';
  fps: number;
  resolution?: string;
}

/**
 * Main composition component for code walkthrough videos
 * Orchestrates scene display, audio playback, and highlight animations
 */
export const CodeWalkthrough: React.FC<CodeWalkthroughProps> = ({
  scenes,
  audioBase64,
  timeline,
  theme,
  fps,
  resolution = '1080p',
}) => {
  const frame = useCurrentFrame();
  const currentTime = frame / fps;
  const editorTheme = getTheme(theme);

  // Find current state from timeline
  const currentState = React.useMemo(() => {
    const applicableFrames = timeline.filter((t) => t.time <= currentTime);
    return applicableFrames.length > 0
      ? applicableFrames[applicableFrames.length - 1]
      : timeline[0];
  }, [timeline, currentTime]);

  // Get current scene
  const currentScene = scenes[currentState?.sceneIndex ?? 0];

  if (!currentScene) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: editorTheme.background,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: editorTheme.foreground,
          fontFamily: 'system-ui, sans-serif',
          fontSize: '24px',
        }}
      >
        No scene available
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: editorTheme.background,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Audio track */}
      {audioBase64 && (
        <Audio src={`data:audio/mp3;base64,${audioBase64}`} />
      )}

      {/* File tab header */}
      <FileTab
        path={currentScene.file_path}
        theme={theme}
        resolution={resolution}
      />

      {/* Code display with highlights */}
      <CodeView
        code={currentScene.code}
        language={currentScene.language}
        highlightedLines={currentState?.activeHighlight ?? null}
        theme={theme}
        resolution={resolution}
      />
    </div>
  );
};
