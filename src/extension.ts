import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { parseTraceFile } from './trace/parser';
import { ReplayEngine } from './replay/engine';
import { FollowModeController } from './replay/followMode';
import { DecorationManager } from './util/decorations';
import { GitContentProvider, resolveDiffRef } from './ui/gitContentProvider';
import { TimelineViewProvider } from './ui/timelineView';
import { StatusBarController } from './ui/statusBar';
import { TraceFileWatcher } from './agent/fileWatcher';
import { AgentHttpServer } from './agent/httpServer';
import { InlineCardController } from './ui/inlineCard';
import { SnapshotContentProvider } from './ui/snapshotContentProvider';
import { TtsPlayer } from './audio/ttsPlayer';
import { captureSnapshots, hasExistingSnapshots } from './trace/snapshotCapture';
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

  // ── Snapshot content provider (for snapshot-based traces) ─────────────
  const snapshotContentProvider = new SnapshotContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      'debrief-snapshot',
      snapshotContentProvider
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
    snapshotContentProvider,
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

  // Wire source kind indicator
  engine.onSessionLoaded((session) => {
    const meta = session.metadata;
    if (meta?.commitSha) {
      statusBar.showSourceKind({ kind: 'git', commitSha: meta.commitSha });
    } else if (meta?.sourceKind === 'snapshot' || meta?.snapshotsDir) {
      statusBar.showSourceKind({ kind: 'snapshot' });
    } else {
      statusBar.showSourceKind({ kind: 'workspace' });
    }
  });
  engine.onSessionCleared(() => statusBar.hideSourceKind());

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
    engine
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

    // Skip notification if this is the currently loaded trace (e.g. comment save)
    if (loadedTracePath && path.normalize(traceUri.fsPath) === path.normalize(loadedTracePath)) {
      outputChannel.appendLine('Skipping notification — trace is already loaded');
      return;
    }

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

    const traceDir = path.dirname(traceUri.fsPath);

    // Backfill snapshots if they don't exist yet (e.g., agent-written traces)
    if (!hasExistingSnapshots(traceDir)) {
      await captureSnapshots(
        session.events,
        workspaceRoot,
        traceDir,
        outputChannel
      );
    }

    // Ensure metadata reflects snapshot state (whether just captured or pre-existing)
    if (hasExistingSnapshots(traceDir)) {
      if (!session.metadata) {
        session.metadata = {};
      }
      session.metadata.sourceKind ??= 'snapshot';
      session.metadata.snapshotsDir ??= '.assets/snapshots';
    }

    const stepCount = session.events.length;
    const fileCount = new Set(
      session.events.filter((e) => e.filePath).map((e) => e.filePath)
    ).size;

    // Show rich notification in the sidebar instead of an OS dialog
    await vscode.commands.executeCommand('debrief.timeline.focus');
    timelineProvider.showTraceNotification({
      fileName: path.basename(traceUri.fsPath),
      stepCount,
      fileCount,
      tracePath: traceUri.fsPath,
      summaryPath: path.join(traceDir, 'summary.md'),
      summary: session.summary,
    });

    // Wait for user action from the webview
    const action = await timelineProvider.waitForNotificationAction();

    if (action === 'walkthrough') {
      loadedTracePath = traceUri.fsPath;
      session.tracePath = traceUri.fsPath;
      engine.load(session);
      // Sidebar is already focused — ready handshake will deliver state
      await engine.play();
    } else if (action === 'summary') {
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

      // Capture file snapshots for stable replay
      await captureSnapshots(
        session.events,
        ws.uri.fsPath,
        dir,
        outputChannel
      );

      // Write metadata.json with snapshot info
      const meta = {
        ...session.metadata,
        timestamp:
          session.metadata.timestamp ?? new Date().toISOString(),
        sourceKind: session.metadata.sourceKind ?? 'snapshot' as const,
        snapshotsDir: '.assets/snapshots',
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
      const stepCount = replaySession.events.length;
      const fileCount = new Set(
        replaySession.events.filter((e) => e.filePath).map((e) => e.filePath)
      ).size;

      // Show rich notification in the sidebar
      await vscode.commands.executeCommand('debrief.timeline.focus');
      timelineProvider.showTraceNotification({
        fileName: 'trace.jsonl',
        stepCount,
        fileCount,
      });

      const action = await timelineProvider.waitForNotificationAction();

      if (action === 'walkthrough') {
        // Engine already has events via appendEvents — play from beginning
        await engine.play();
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

      // Scan workspace for existing traces and show picker
      const traces = await scanWorkspaceTraces();
      let selectedPath: string | undefined;

      if (traces.length > 0) {
        const items: (vscode.QuickPickItem & { tracePath?: string })[] =
          traces.map((t) => {
            const dateStr = t.modifiedDate.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });
            return {
              label: t.fileName,
              description: t.relativePath,
              detail: `$(list-unordered) ${t.stepCount} steps  $(calendar) ${dateStr}`,
              tracePath: t.uri.fsPath,
            };
          });

        // Add browse option at the bottom
        items.push({
          label: '$(folder-opened)  Browse...',
          description: 'Open file dialog',
        });

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a trace to load',
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (!picked) {
          return;
        }

        selectedPath = picked.tracePath ?? (await pickTraceFromDialog());
      } else {
        selectedPath = await pickTraceFromDialog();
      }

      if (!selectedPath) {
        return;
      }

      outputChannel.appendLine(`Loading trace: ${selectedPath}`);

      const { session, warnings } = await parseTraceFile(selectedPath);

      for (const warning of warnings) {
        outputChannel.appendLine(`[warn] ${warning}`);
      }

      if (session.events.length === 0) {
        vscode.window.showWarningMessage(
          'Debrief: Trace file contains no valid events.'
        );
        return;
      }

      loadedTracePath = selectedPath;
      session.tracePath = selectedPath;

      // Ensure snapshots exist and metadata reflects it
      const traceDir = path.dirname(selectedPath);
      if (!hasExistingSnapshots(traceDir)) {
        await captureSnapshots(
          session.events,
          workspaceRoot,
          traceDir,
          outputChannel
        );
      }
      if (hasExistingSnapshots(traceDir)) {
        if (!session.metadata) {
          session.metadata = {};
        }
        session.metadata.sourceKind ??= 'snapshot';
        session.metadata.snapshotsDir ??= '.assets/snapshots';
      }

      engine.load(session);

      const fileCount = new Set(
        session.events.filter((e) => e.filePath).map((e) => e.filePath)
      ).size;

      vscode.window.showInformationMessage(
        `Debrief: Loaded ${session.events.length} steps across ${fileCount} files.`
      );

      // Navigate to the first step without playing TTS
      await engine.goToStep(0, { skipTts: true });

      // Auto-open the Debrief sidebar
      await vscode.commands.executeCommand('debrief.timeline.focus');
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

  // Pin Trace to Commit
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.pinTraceToCommit', async () => {
      if (!engine.isLoaded || !engine.currentSession) {
        vscode.window.showWarningMessage('Debrief: No trace loaded to pin.');
        return;
      }

      const session = engine.currentSession;
      if (session.metadata?.commitSha) {
        vscode.window.showInformationMessage(
          `Debrief: Trace is already pinned to commit ${session.metadata.commitSha.slice(0, 7)}.`
        );
        return;
      }

      // Check git availability and working tree cleanliness
      try {
        const isClean = await new Promise<boolean>((resolve, reject) => {
          exec(
            'git status --porcelain',
            { cwd: workspaceRoot },
            (err, stdout) => {
              if (err) {
                reject(err);
                return;
              }
              resolve(stdout.trim().length === 0);
            }
          );
        });

        if (!isClean) {
          const action = await vscode.window.showWarningMessage(
            'Debrief: Working tree has uncommitted changes. Commit your changes first to pin this trace.',
            'Open Source Control',
            'Cancel'
          );
          if (action === 'Open Source Control') {
            vscode.commands.executeCommand('workbench.view.scm');
          }
          return;
        }

        // Get HEAD sha
        const commitSha = await new Promise<string>((resolve, reject) => {
          exec(
            'git rev-parse HEAD',
            { cwd: workspaceRoot },
            (err, stdout) => {
              if (err) {
                reject(err);
                return;
              }
              resolve(stdout.trim());
            }
          );
        });

        // Update session metadata
        if (!session.metadata) {
          session.metadata = {};
        }
        session.metadata.commitSha = commitSha;
        session.metadata.profile = 'documentation';
        session.metadata.sourceKind = 'git';

        // Persist the updated metadata to the trace file
        // Engine.persistTraceFile is private — write metadata.json directly
        if (session.tracePath) {
          const traceDir = path.dirname(session.tracePath);
          const metaPath = path.join(traceDir, 'metadata.json');
          try {
            const existing = await fs.promises.readFile(metaPath, 'utf-8');
            const meta = JSON.parse(existing);
            meta.commitSha = commitSha;
            meta.profile = 'documentation';
            meta.sourceKind = 'git';
            await fs.promises.writeFile(
              metaPath,
              JSON.stringify(meta, null, 2),
              'utf-8'
            );
          } catch {
            // No metadata.json — create one
            await fs.promises.writeFile(
              metaPath,
              JSON.stringify(
                { commitSha, profile: 'documentation', sourceKind: 'git', snapshotsDir: session.metadata.snapshotsDir },
                null,
                2
              ),
              'utf-8'
            );
          }
        }

        // Update UI
        statusBar.showSourceKind({ kind: 'git', commitSha });
        timelineProvider.refresh();

        vscode.window.showInformationMessage(
          `Debrief: Trace pinned to commit ${commitSha.slice(0, 7)}. It is now shareable and reproducible.`
        );
        outputChannel.appendLine(`[pinToCommit] Pinned to ${commitSha}`);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Debrief: Failed to pin trace — ${err}`
        );
      }
    })
  );

  // Diff Authored vs Workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('debrief.diffAuthoredVsWorkspace', async () => {
      if (!engine.isLoaded || !engine.currentSession) {
        vscode.window.showWarningMessage('Debrief: No trace loaded.');
        return;
      }

      const event = engine.currentEvent;
      if (!event?.filePath) {
        vscode.window.showWarningMessage(
          'Debrief: Current step has no file to diff.'
        );
        return;
      }

      const meta = engine.currentSession.metadata;
      const normalized = event.filePath.replace(/\\/g, '/');

      // Build left URI (authored source)
      let leftRef: string;
      if (meta?.commitSha) {
        leftRef = `git:${meta.commitSha}:${normalized}`;
      } else {
        leftRef = `snapshot:${normalized}`;
      }

      try {
        const leftUri = resolveDiffRef(leftRef, workspaceRoot);
        const rightUri = resolveDiffRef(`workspace:${normalized}`, workspaceRoot);
        const fileName = path.basename(event.filePath);

        await vscode.commands.executeCommand(
          'vscode.diff',
          leftUri,
          rightUri,
          `Authored \u2194 Workspace: ${fileName}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Debrief: Failed to open diff — ${err}`
        );
      }
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

interface TraceScanResult {
  uri: vscode.Uri;
  fileName: string;
  relativePath: string;
  stepCount: number;
  modifiedDate: Date;
}

async function scanWorkspaceTraces(): Promise<TraceScanResult[]> {
  const uris = await vscode.workspace.findFiles(
    '**/.debrief/replay/**/*.jsonl',
    '**/node_modules/**'
  );

  const results: TraceScanResult[] = [];

  for (const uri of uris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const raw = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(raw).toString('utf-8');
      const stepCount = content
        .split('\n')
        .filter((l) => l.trim().length > 0).length;

      const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
      const relativePath = wsFolder
        ? path.relative(wsFolder.uri.fsPath, path.dirname(uri.fsPath))
        : path.dirname(uri.fsPath);

      results.push({
        uri,
        fileName: path.basename(uri.fsPath),
        relativePath,
        stepCount,
        modifiedDate: new Date(stat.mtime),
      });
    } catch {
      // Skip files that can't be read
    }
  }

  // Sort by modification date, newest first
  results.sort((a, b) => b.modifiedDate.getTime() - a.modifiedDate.getTime());
  return results;
}

async function pickTraceFromDialog(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Trace files': ['jsonl'] },
    openLabel: 'Load Replay',
  });
  return uris?.[0]?.fsPath;
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
