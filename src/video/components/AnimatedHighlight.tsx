import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { EditorTheme, ScaleConfig } from '../themes/editor';

interface AnimatedHighlightProps {
  /** Current highlighted lines [start, end] or null */
  currentLines: [number, number] | null;
  /** Previous highlighted lines for smooth transition */
  previousLines: [number, number] | null;
  /** Frame when the current highlight started */
  highlightStartFrame: number;
  /** Theme configuration */
  theme: EditorTheme;
  /** Scale configuration for current resolution */
  scale: ScaleConfig;
  /** Total number of lines in the code */
  totalLines: number;
}

/**
 * Animated highlight overlay that smoothly transitions between line ranges
 * using Remotion's frame-based animation primitives
 */
export const AnimatedHighlight: React.FC<AnimatedHighlightProps> = ({
  currentLines,
  previousLines,
  highlightStartFrame,
  theme,
  scale,
  totalLines,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // No highlight to show
  if (!currentLines && !previousLines) {
    return null;
  }

  // Calculate animation progress
  const framesSinceStart = frame - highlightStartFrame;
  const transitionDuration = 12; // 12 frames = 0.4s at 30fps

  // Use spring for smooth, physics-based animation
  const springProgress = spring({
    frame: framesSinceStart,
    fps,
    config: {
      damping: 20,
      stiffness: 120,
      mass: 0.8,
    },
  });

  // Fade in/out animation
  const opacity = currentLines
    ? interpolate(
        framesSinceStart,
        [0, 8],
        [0, 1],
        { extrapolateRight: 'clamp' }
      )
    : interpolate(
        framesSinceStart,
        [0, 8],
        [1, 0],
        { extrapolateRight: 'clamp' }
      );

  // Calculate positions
  const fromLines = previousLines ?? currentLines ?? [1, 1];
  const toLines = currentLines ?? previousLines ?? [1, 1];

  // Interpolate line positions using spring
  const startLine = interpolate(
    springProgress,
    [0, 1],
    [fromLines[0], toLines[0]]
  );
  const endLine = interpolate(
    springProgress,
    [0, 1],
    [fromLines[1], toLines[1]]
  );

  // Calculate pixel positions
  const top = (startLine - 1) * scale.lineHeight;
  const height = (endLine - startLine + 1) * scale.lineHeight;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: `${top}px`,
        height: `${height}px`,
        backgroundColor: theme.highlightBackground,
        borderLeft: `4px solid ${theme.highlightBorder}`,
        opacity,
        pointerEvents: 'none',
        zIndex: 5,
        // Subtle glow effect
        boxShadow: `inset 0 0 20px ${theme.highlightBackground}`,
      }}
    />
  );
};

/**
 * Hook to track highlight state changes for animation
 */
export function useHighlightAnimation(
  currentHighlight: [number, number] | null,
  frame: number
): {
  currentLines: [number, number] | null;
  previousLines: [number, number] | null;
  highlightStartFrame: number;
} {
  const [state, setState] = React.useState<{
    currentLines: [number, number] | null;
    previousLines: [number, number] | null;
    highlightStartFrame: number;
  }>({
    currentLines: currentHighlight,
    previousLines: null,
    highlightStartFrame: 0,
  });

  React.useEffect(() => {
    // Check if highlight changed
    const highlightChanged =
      !arraysEqual(state.currentLines, currentHighlight);

    if (highlightChanged) {
      setState({
        currentLines: currentHighlight,
        previousLines: state.currentLines,
        highlightStartFrame: frame,
      });
    }
  }, [currentHighlight, frame]);

  return state;
}

function arraysEqual(
  a: [number, number] | null,
  b: [number, number] | null
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a[0] === b[0] && a[1] === b[1];
}
