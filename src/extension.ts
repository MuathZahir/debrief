import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseTraceFile } from './trace/parser';
import { ReplayEngine } from './replay/engine';
import { FollowModeController } from './replay/followMode';
import { DecorationManager } from './util/decorations';
import { GitContentProvider } from './ui/gitContentProvider';
import { TimelineViewProvider } from './ui/timelineView';
import { StatusBarController } from './ui/statusBar';
import { TraceFileWatcher } from './agent/fileWatcher';
import { AgentHttpServer } from './agent/httpServer';
import { InlineCardController } from './ui/inlineCard';
import { TtsPlayer } from './audio/ttsPlayer';
import type { HandlerContext } from './replay/handlers/index';
import type { ReplaySession } from './trace/types';

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Debrief Replay');
  outputChannel.appendLine('Debrief activated');

  // ── Resolve workspace root ─────────────────────────────────────────────
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // ── Git content provider (for diff references) ─────────────────────────
  const gitContentProvider = new GitContentProvider(workspaceRoot);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'debrief-git',
      gitContentProvider
    )
  );

  // ── Decoration manager ─────────────────────────────────────────────────
  const decorationManager = new DecorationManager();
  context.subscriptions.push({ dispose: () => decorationManager.dispose() });

  // ── Follow mode controller ─────────────────────────────────────────────
  const followMode = new FollowModeController();
  context.subscriptions.push({ dispose: () => followMode.dispose() });

  // ── Inline card controller ────────────────────────────────────────────
  const inlineCard = new InlineCardController();
  context.subscriptions.push({ dispose: () => inlineCard.dispose() });

  // ── TTS player ────────────────────────────────────────────────────────
  const ttsPlayer = new TtsPlayer(context, outputChannel);
  // TtsPlayer self-registers in context.subscriptions

  // ── Handler context ────────────────────────────────────────────────────
  // Note: engine is added after creation due to circular dependency
  const handlerContext: HandlerContext = {
    workspaceRoot,
    decorationManager,
    outputChannel,
    gitContentProvider,
    followMode,
    inlineCard,
    ttsPlayer,
    engine: null as unknown as ReplayEngine, // Set after engine creation
  };

  // ── Replay engine ──────────────────────────────────────────────────────
  const engine = new ReplayEngine(handlerContext);
  handlerContext.engine = engine; // Complete the circular reference
  context.subscriptions.push({ dispose: () => engine.dispose() });

  // Wire inline card to engine lifecycle
  engine.onSessionCleared(() => {
    inlineCard.hide();
    ttsPlayer.stop();
  });

  // Track the currently loaded trace file path for review export
  let loadedTracePath: string | null = null;

  // ── Context key for keybindings ────────────────────────────────────────
  function setReplayActive(active: boolean) {
    vscode.commands.executeCommand(
      'setContext',
      'debrief.replayActive',
      active
    );
  }

  engine.onSessionLoaded(() => setReplayActive(true));
  engine.onSessionCleared(() => {
    setReplayActive(false);
    loadedTracePath = null;
  });

  // ── Status bar controller ───────────────────────────────────────────────
  const statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  // Wire follow mode → status bar
  followMode.onFollowModeChanged(({ enabled }) =>
    statusBar.updateFollowMode(enabled)
  );
  engine.onSessionLoaded(() =>
    statusBar.updateFollowMode(followMode.isEnabled)
  );
  engine.onSessionCleared(() => statusBar.hideFollowItem());

  // Wire replay state → status bar
  engine.onStepChanged(({ index, total }) =>
    statusBar.showReplayStatus({
      step: index + 1,
      total,
      speed: engine.speed,
    })
  );
  engine.onPlayStateChanged(({ speed }) => {
    if (engine.isLoaded) {
      statusBar.showReplayStatus({
        step: engine.currentIndex + 1,
        total: engine.stepCount,
        speed,
      });
    }
  });
  engine.onSessionLoaded(() =>
    statusBar.showReplayStatus({
      step: 1,
      total: engine.stepCount,
      speed: engine.speed,
    })
  );
  engine.onSessionCleared(() => statusBar.showIdle());

  // Re-execute current step when follow mode is re-enabled
  followMode.onFollowModeChanged(({ enabled }) => {
    if (enabled && engine.isLoaded && engine.currentIndex >= 0) {
      engine.goToStep(engine.currentIndex);
    }
  });

  // ── Timeline sidebar ───────────────────────────────────────────────────
  const timelineProvider = new TimelineViewProvider(
    context.extensionUri,
    engine,
    followMode
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TimelineViewProvider.viewType,
      timelineProvider
    )
  );

  // ── File watcher for agent traces ──────────────────────────────────────
  const traceWatcher = new TraceFileWatcher();
  traceWatcher.start();
  context.subscriptions.push(traceWatcher);

  traceWatcher.onTraceDetected(async ({ traceUri }) => {
    outputChannel.appendLine(`Trace detected: ${traceUri.fsPath}`);

    const { session, warnings } = await parseTraceFile(traceUri.fsPath);
    for (const warning of warnings) {
      outputChannel.appendLine(`[warn] ${warning}`);
    }

    if (session.events.length === 0) {
      outputChannel.appendLine(
        'Detected trace has no valid events — ignoring'
      );
      return;
    }

    const summaryText = buildNotificationSummary(session);
    const traceDir = path.dirname(traceUri.fsPath);

    const action = await vscode.window.showInformationMessage(
      `Debrief: ${summaryText}`,
      'Walk Me Through It',
      'View Summary',
      'Dismiss'
    );

    if (action === 'Walk Me Through It') {
      loadedTracePath = traceUri.fsPath;
      engine.load(session);
      await engine.goToStep(0);
    } else if (action === 'View Summary') {
      const summaryPath = path.join(traceDir, 'summary.md');
      try {
        await fs.promises.access(summaryPath);
        const summaryUri = vscode.Uri.file(summaryPath);
        await vscode.commands.executeCommand(
          'markdown.showPreview',
          summaryUri
        );
      } catch {
        // No summary.md on disk — generate one and show it
        const doc = await vscode.workspace.openTextDocument({
          content: session.summary ?? generateSummaryMarkdown(session),
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc);
      }
    }
  });

  // ── HTTP server for agent streaming ────────────────────────────────────
  const serverPort = vscode.workspace
    .getConfiguration('debrief')
    .get<number>('serverPort', 53931);
  const autoStart = vscode.workspace
    .getConfiguration('debrief')
    .get<boolean>('autoStartServer', true);

  const httpServer = new AgentHttpServer({
    port: serverPort,
    outputChannel,
  });
  context.subscriptions.push(httpServer);

  if (autoStart) {
    httpServer.start().catch((err) => {
      outputChannel.appendLine(`[httpServer] Failed to start: ${err}`);
    });
  }

  // Wire live session events
  httpServer.onSessionStarted((metadata) => {
    statusBar.showLiveStatus({
      title: metadata.agent ?? 'Agent session started',
    });
    outputChannel.appendLine(
      `[httpServer] Session started: ${metadata.agent ?? 'unknown agent'}`
    );
  });

  httpServer.onEventsReceived((events) => {
    engine.appendEvents(events);
    // Update status bar with latest event info
    const lastEvent = events[events.length - 1];
    if (lastEvent) {
      statusBar.showLiveStatus({
        filePath: lastEvent.filePath,
        title: lastEvent.title,
      });
    }
  });

  httpServer.onSessionEnded(async (session) => {
    statusBar.showIdle();

    // Save trace files to workspace
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws && session.events.length > 0) {
      const dir = path.join(ws.uri.fsPath, '.debrief', 'replay');
      await fs.promises.mkdir(dir, { recursive: true });

      // Suppress file watcher to prevent duplicate notification
      traceWatcher.suppressNext = true;

      // Write trace.jsonl
      const traceContent =
        session.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.promises.writeFile(
        path.join(dir, 'trace.jsonl'),
        traceContent,
        'utf-8'
      );

      // Write metadata.json
      const meta = {
        ...session.metadata,
        timestamp:
          session.metadata.timestamp ?? new Date().toISOString(),
      };
      await fs.promises.writeFile(
        path.join(dir, 'metadata.json'),
        JSON.stringify(meta, null, 2),
        'utf-8'
      );

      outputChannel.appendLine(`[httpServer] Session saved to ${dir}`);
    }

    // Show auto-summary notification
    if (session.events.length > 0) {
      const replaySession: ReplaySession = {
        events: session.events,
        metadata: session.metadata,
      };
      const summaryText = buildNotificationSummary(replaySession);

      const action = await vscode.window.showInformationMessage(
        `Debrief: ${summaryText}`,
        'Walk Me Through It',
        'Dismiss'
      );

      if (action === 'Walk Me Through It') {
        // Engine already has events via appendEvents — restart from beginning
        await engine.goToStep(0);
      }
    }
  });

  // ── Commands ───────────────────────────────────────────────────────────

  // Load Replay
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.loadReplay', async () => {
      // Guard: check for active live session
      if (httpServer.hasActiveSession) {
        const confirm = await vscode.window.showWarningMessage(
          'A live session is in progress. End it and load a trace file?',
          'Yes',
          'Cancel'
        );
        if (confirm !== 'Yes') {
          return;
        }
        httpServer.stop();
        httpServer.start().catch((err) => {
          outputChannel.appendLine(
            `[httpServer] Failed to restart: ${err}`
          );
        });
      }

      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Trace files': ['jsonl'] },
        openLabel: 'Load Replay',
      });

      if (!uris || uris.length === 0) {
        return;
      }

      const filePath = uris[0].fsPath;
      outputChannel.appendLine(`Loading trace: ${filePath}`);

      const { session, warnings } = await parseTraceFile(filePath);

      for (const warning of warnings) {
        outputChannel.appendLine(`[warn] ${warning}`);
      }

      if (session.events.length === 0) {
        vscode.window.showWarningMessage(
          'Debrief: Trace file contains no valid events.'
        );
        return;
      }

      loadedTracePath = filePath;
      engine.load(session);

      const fileCount = new Set(
        session.events.filter((e) => e.filePath).map((e) => e.filePath)
      ).size;

      vscode.window.showInformationMessage(
        `Debrief: Loaded ${session.events.length} steps across ${fileCount} files.`
      );

      // Navigate to the first step without playing TTS
      await engine.goToStep(0, { skipTts: true });
    })
  );

  // Next Step
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.nextStep', () => {
      if (engine.isLoaded) {
        engine.next();
      }
    })
  );

  // Previous Step
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.previousStep', () => {
      if (engine.isLoaded) {
        engine.previous();
      }
    })
  );

  // Toggle Play/Pause
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.togglePlayPause', () => {
      if (engine.isLoaded) {
        engine.togglePlayPause();
      }
    })
  );

  // Speed Up
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.speedUp', () => {
      if (!engine.isLoaded) return;
      const speeds = [0.5, 1.0, 2.0];
      const currentIdx = speeds.indexOf(engine.speed);
      if (currentIdx < speeds.length - 1) {
        engine.setSpeed(speeds[currentIdx + 1]);
      }
    })
  );

  // Speed Down
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.speedDown', () => {
      if (!engine.isLoaded) return;
      const speeds = [0.5, 1.0, 2.0];
      const currentIdx = speeds.indexOf(engine.speed);
      if (currentIdx > 0) {
        engine.setSpeed(speeds[currentIdx - 1]);
      }
    })
  );

  // Toggle Follow Mode
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.toggleFollowMode', () => {
      followMode.toggle();
    })
  );

  // Show Narration (when status bar is clicked)
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.showNarration', () => {
      inlineCard.showNarrationPanel();
    })
  );

  // Start Server
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.startServer', async () => {
      try {
        const port = await httpServer.start();
        vscode.window.showInformationMessage(
          `Debrief server listening on port ${port}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Debrief: Failed to start server — ${err}`
        );
      }
    })
  );

  // Stop Server
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.stopServer', () => {
      httpServer.stop();
      vscode.window.showInformationMessage('Debrief server stopped');
    })
  );

  // Export Review
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.exportReview', async () => {
      if (!engine.isLoaded) {
        vscode.window.showWarningMessage(
          'Debrief: No replay session loaded.'
        );
        return;
      }

      const reviewData = engine.exportReview();
      if (reviewData.length === 0) {
        vscode.window.showInformationMessage(
          'Debrief: No steps have been reviewed yet.'
        );
        return;
      }

      // Determine output directory
      let outputDir: string;
      if (loadedTracePath) {
        outputDir = path.dirname(loadedTracePath);
      } else if (workspaceRoot) {
        outputDir = path.join(workspaceRoot, '.debrief', 'replay');
      } else {
        // Fall back to asking user
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file('review.json'),
          filters: { 'JSON files': ['json'] },
          saveLabel: 'Export Review',
        });
        if (!saveUri) return;
        outputDir = path.dirname(saveUri.fsPath);
      }

      await fs.promises.mkdir(outputDir, { recursive: true });
      const reviewPath = path.join(outputDir, 'review.json');

      const reviewOutput = {
        exportedAt: new Date().toISOString(),
        summary: engine.getReviewSummary(),
        reviews: reviewData,
      };

      await fs.promises.writeFile(
        reviewPath,
        JSON.stringify(reviewOutput, null, 2),
        'utf-8'
      );

      const openAction = await vscode.window.showInformationMessage(
        `Debrief: Review exported to ${path.basename(reviewPath)}`,
        'Open File'
      );

      if (openAction === 'Open File') {
        const doc = await vscode.workspace.openTextDocument(reviewPath);
        await vscode.window.showTextDocument(doc);
      }
    })
  );

  // Approve Current Step
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.approveCurrentStep', () => {
      const event = engine.currentEvent;
      if (event) {
        engine.approveStep(event.id);
        // Refresh the inline card to show updated state
        if (engine.isLoaded) {
          engine.goToStep(engine.currentIndex);
        }
      }
    })
  );

  // Flag Current Step
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.flagCurrentStep', async () => {
      const event = engine.currentEvent;
      if (event) {
        const comment = await vscode.window.showInputBox({
          prompt: 'Add a comment for this flagged step (optional)',
          placeHolder: 'Why are you flagging this step?',
        });
        engine.flagStep(event.id, comment);
        // Refresh the inline card to show updated state
        if (engine.isLoaded) {
          engine.goToStep(engine.currentIndex);
        }
      }
    })
  );
}

export function deactivate() {
  // VS Code disposes subscriptions automatically
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildNotificationSummary(session: ReplaySession): string {
  const fileSet = new Set(
    session.events.filter((e) => e.filePath).map((e) => e.filePath)
  );
  const diffCount = session.events.filter(
    (e) => e.type === 'showDiff'
  ).length;

  const parts: string[] = ['Agent completed'];

  if (fileSet.size > 0) {
    parts.push(
      `— changed ${fileSet.size} file${fileSet.size !== 1 ? 's' : ''}`
    );
  }
  if (diffCount > 0) {
    parts.push(`(${diffCount} diff${diffCount !== 1 ? 's' : ''})`);
  }

  return parts.join(' ') + '.';
}

function generateSummaryMarkdown(session: ReplaySession): string {
  const lines: string[] = ['# Agent Session Summary\n'];
  const fileSet = new Set(
    session.events.filter((e) => e.filePath).map((e) => e.filePath)
  );

  lines.push(`**Steps:** ${session.events.length}`);
  lines.push(`**Files:** ${fileSet.size}`);
  lines.push('');
  lines.push('## Steps\n');

  for (const event of session.events) {
    if (event.type === 'sectionStart') {
      lines.push(`### ${event.title}\n`);
    } else if (event.type !== 'sectionEnd') {
      lines.push(
        `- **${event.title}**${event.filePath ? ` (\`${event.filePath}\`)` : ''}`
      );
      if (event.narration) {
        lines.push(`  ${event.narration}`);
      }
    }
  }

  return lines.join('\n');
}
