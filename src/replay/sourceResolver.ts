import * as vscode from "vscode";
import * as path from "path";
import type { SessionMetadata } from "../trace/types";
import type { SnapshotContentProvider } from "../ui/snapshotContentProvider";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResolvedSource {
  uri: vscode.Uri;
  kind: "snapshot" | "git" | "workspace";
  warning?: string;
}

export interface SourceResolverContext {
  workspaceRoot: string;
  metadata?: SessionMetadata;
  snapshotProvider: SnapshotContentProvider;
  outputChannel: vscode.OutputChannel;
}

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Open a trace event's file from the best available source.
 *
 * Priority:
 *   1. commitSha → debrief-git URI (fallback to snapshot if git fails)
 *   2. snapshot exists → debrief-snapshot URI
 *   3. workspace file (with warning)
 */
export async function openResolvedSource(
  filePath: string,
  ctx: SourceResolverContext,
): Promise<{ doc: vscode.TextDocument; source: ResolvedSource } | null> {
  const normalized = filePath.replace(/\\/g, "/");

  // If user has opted into workspace mode, skip authored sources
  const sourceMode = vscode.workspace
    .getConfiguration("debrief")
    .get<string>("replaySourceMode", "authored");

  if (sourceMode === "workspace") {
    return openWorkspaceSource(filePath, normalized, ctx, true);
  }

  // 1. Try git-pinned source
  if (ctx.metadata?.commitSha) {
    const gitUri = vscode.Uri.parse(
      `debrief-git:/${ctx.metadata.commitSha}/${normalized}`,
    );
    try {
      const doc = await vscode.workspace.openTextDocument(gitUri);
      return { doc, source: { uri: gitUri, kind: "git" } };
    } catch (err) {
      ctx.outputChannel.appendLine(
        `[sourceResolver] Git source failed for ${normalized}: ${err}`,
      );
      // Fall through to snapshot
    }
  }

  // 2. Try snapshot
  if (ctx.snapshotProvider.hasSnapshot(normalized)) {
    const snapshotUri = vscode.Uri.parse(`debrief-snapshot:/${normalized}`);
    try {
      const doc = await vscode.workspace.openTextDocument(snapshotUri);
      const warning = ctx.metadata?.commitSha
        ? "Git resolution failed; using snapshot fallback."
        : undefined;
      return { doc, source: { uri: snapshotUri, kind: "snapshot", warning } };
    } catch (err) {
      ctx.outputChannel.appendLine(
        `[sourceResolver] Snapshot failed for ${normalized}: ${err}`,
      );
    }
  }

  // 3. Workspace fallback
  return openWorkspaceSource(filePath, normalized, ctx, false);
}

async function openWorkspaceSource(
  filePath: string,
  normalized: string,
  ctx: SourceResolverContext,
  explicitWorkspaceMode: boolean,
): Promise<{ doc: vscode.TextDocument; source: ResolvedSource } | null> {
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.workspaceRoot, filePath);
  const wsUri = vscode.Uri.file(fullPath);

  try {
    const doc = await vscode.workspace.openTextDocument(wsUri);
    const warning = explicitWorkspaceMode
      ? "Workspace mode — highlights may not match if file changed since trace was created."
      : "No authored snapshot — using workspace file. Highlights may be incorrect if file changed.";
    ctx.outputChannel.appendLine(
      `[sourceResolver] ${explicitWorkspaceMode ? "Workspace mode" : "Falling back to workspace"} for ${normalized}`,
    );
    return { doc, source: { uri: wsUri, kind: "workspace", warning } };
  } catch (err) {
    ctx.outputChannel.appendLine(
      `[sourceResolver] All sources failed for ${normalized}: ${err}`,
    );
  }

  return null;
}
