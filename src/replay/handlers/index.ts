import type * as vscode from 'vscode';
import type { TraceEvent } from '../../trace/types';
import type { DecorationManager } from '../../util/decorations';
import type { GitContentProvider } from '../../ui/gitContentProvider';
import type { FollowModeController } from '../followMode';
import type { InlineCardController } from '../../ui/inlineCard';
import type { TtsPlayer } from '../../audio/ttsPlayer';
import type { ReplayEngine } from '../engine';
import type { SnapshotContentProvider } from '../../ui/snapshotContentProvider';

// ── Handler context ────────────────────────────────────────────────────────

export interface HandlerContext {
  workspaceRoot: string;
  decorationManager: DecorationManager;
  outputChannel: vscode.OutputChannel;
  gitContentProvider: GitContentProvider;
  snapshotContentProvider: SnapshotContentProvider;
  followMode: FollowModeController;
  inlineCard: InlineCardController;
  ttsPlayer: TtsPlayer;
  engine: ReplayEngine;
  /** Internal flag to skip TTS on navigation (e.g., initial load) */
  _skipTts?: boolean;
}

// ── Handler interface ──────────────────────────────────────────────────────

export interface EventHandler {
  execute(event: TraceEvent, context: HandlerContext): Promise<void>;
}

// ── Registry ───────────────────────────────────────────────────────────────

import { OpenFileHandler } from './openFile';
import { ShowDiffHandler } from './showDiff';
import { HighlightRangeHandler } from './highlightRange';
import { SayHandler } from './say';
import { SectionStartHandler } from './sectionStart';
import { SectionEndHandler } from './sectionEnd';

const handlers: Record<string, EventHandler> = {
  openFile: new OpenFileHandler(),
  showDiff: new ShowDiffHandler(),
  highlightRange: new HighlightRangeHandler(),
  say: new SayHandler(),
  sectionStart: new SectionStartHandler(),
  sectionEnd: new SectionEndHandler(),
};

export function getHandler(eventType: string): EventHandler | undefined {
  return handlers[eventType];
}
