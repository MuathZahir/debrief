import * as fs from 'fs';
import * as path from 'path';
import type { TraceEvent } from './types';

/**
 * Capture workspace file snapshots for all files referenced in trace events.
 * Snapshots are written to `<traceDir>/.assets/snapshots/<filePath>`.
 *
 * @returns List of file paths that were successfully snapshotted
 */
export async function captureSnapshots(
  events: TraceEvent[],
  workspaceRoot: string,
  traceDir: string,
  outputChannel?: { appendLine(msg: string): void }
): Promise<string[]> {
  const filePaths = new Set<string>();
  for (const event of events) {
    if (event.filePath) {
      filePaths.add(event.filePath.replace(/\\/g, '/'));
    }
  }

  if (filePaths.size === 0) {
    return [];
  }

  const snapshotsDir = path.join(traceDir, '.assets', 'snapshots');
  const captured: string[] = [];

  for (const filePath of filePaths) {
    const sourcePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceRoot, filePath);

    const destPath = path.join(snapshotsDir, filePath);

    try {
      const content = await fs.promises.readFile(sourcePath, 'utf-8');
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.writeFile(destPath, content, 'utf-8');
      captured.push(filePath);
    } catch (err) {
      outputChannel?.appendLine(
        `[snapshotCapture] Failed to snapshot ${filePath}: ${err}`
      );
    }
  }

  outputChannel?.appendLine(
    `[snapshotCapture] Captured ${captured.length}/${filePaths.size} file snapshots to ${snapshotsDir}`
  );

  return captured;
}

/**
 * Check if snapshots already exist for a trace directory.
 */
export function hasExistingSnapshots(traceDir: string): boolean {
  const snapshotsDir = path.join(traceDir, '.assets', 'snapshots');
  return fs.existsSync(snapshotsDir);
}
