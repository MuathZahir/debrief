import * as vscode from 'vscode';
import { exec } from 'child_process';

/**
 * Provides content for `debrief-git://` URIs by running `git show`.
 *
 * URI format: debrief-git:/<ref>/<filepath>
 * Example:    debrief-git:/HEAD~1/src/auth/handler.ts
 *
 * The ref and path are extracted from the URI path.
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // URI path: /<ref>/<filepath>
    // Remove leading slash, split on first slash to get ref and path
    const fullPath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    const slashIndex = fullPath.indexOf('/');

    if (slashIndex === -1) {
      throw new Error(`Invalid debrief-git URI: ${uri.toString()}`);
    }

    const ref = fullPath.slice(0, slashIndex);
    const filePath = fullPath.slice(slashIndex + 1);

    return this.gitShow(ref, filePath);
  }

  private gitShow(ref: string, filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = `git show ${ref}:${filePath}`;
      exec(
        command,
        { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(`git show failed: ${stderr || err.message}`)
            );
            return;
          }
          resolve(stdout);
        }
      );
    });
  }
}

/**
 * Parse a diff reference string into a VS Code URI.
 *
 * Supported formats:
 *   "git:HEAD~1:src/auth.ts"  → debrief-git:/HEAD~1/src/auth.ts
 *   "workspace:src/auth.ts"   → file:///workspace/root/src/auth.ts
 */
export function resolveDiffRef(
  ref: string,
  workspaceRoot: string
): vscode.Uri {
  if (ref.startsWith('git:')) {
    // "git:HEAD~1:src/auth.ts" → ref="HEAD~1", path="src/auth.ts"
    const withoutPrefix = ref.slice(4); // "HEAD~1:src/auth.ts"
    const colonIndex = withoutPrefix.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid git diff ref: ${ref}`);
    }
    const gitRef = withoutPrefix.slice(0, colonIndex);
    const filePath = withoutPrefix.slice(colonIndex + 1);
    return vscode.Uri.parse(`debrief-git:/${gitRef}/${filePath}`);
  }

  if (ref.startsWith('workspace:')) {
    const filePath = ref.slice('workspace:'.length);
    const fullPath = require('path').join(workspaceRoot, filePath);
    return vscode.Uri.file(fullPath);
  }

  // Fallback: treat as a file path
  const fullPath = require('path').join(workspaceRoot, ref);
  return vscode.Uri.file(fullPath);
}
