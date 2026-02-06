# Documentation Research: trace-detection-playback-fixes

## VS Code API: FileSystemWatcher

### createFileSystemWatcher Signatures

Two overloads exist (VS Code 1.84+):

```typescript
// Classic overload — glob string, with boolean flags to ignore event types
createFileSystemWatcher(
  globPattern: GlobPattern,       // string | RelativePattern
  ignoreCreateEvents?: boolean,   // default false
  ignoreChangeEvents?: boolean,   // default false
  ignoreDeleteEvents?: boolean    // default false
): FileSystemWatcher;

// Newer overload (1.84+) — RelativePattern only, with custom excludes
createFileSystemWatcher(
  pattern: RelativePattern,
  options?: { readonly excludes?: string[] }
): FileSystemWatcher;
```

### Glob Pattern Rules

- Glob patterns are matched against the **full filesystem path**, not relative paths (Issue #20184).
- A backslash (`\`) is **not valid** within a glob pattern even on Windows. Always use forward slashes (`/`). Using `src\**` fails silently on Windows; use `src/**` instead (Issue #172939).
- `**` matches zero or more path segments. `**/*.jsonl` matches any `.jsonl` file at any depth.
- Negation patterns (`!(*.min)`) are **not supported** in file watchers (they do work in `workspace.findFiles`).
- For the project's fix: `**/.debrief/replay/**/*.jsonl` is the correct pattern to match any `.jsonl` file at any depth under `.debrief/replay/`.

### RelativePattern (Recommended)

```typescript
class RelativePattern {
  base: string;                             // Absolute base path
  pattern: string;                          // Glob relative to base
  constructor(base: WorkspaceFolder | string, pattern: string);
}

// Example:
const rp = new vscode.RelativePattern(
  vscode.workspace.workspaceFolders[0],
  '.debrief/replay/**/*.jsonl'
);
const watcher = vscode.workspace.createFileSystemWatcher(rp);
```

Using `RelativePattern` handles path separator conversion automatically and avoids the full-path matching confusion.

### Event Types

- `onDidCreate` — fires when a new file matching the pattern is created
- `onDidChange` — fires when a matching file's content changes
- `onDidDelete` — fires when a matching file is deleted

Each returns a `vscode.Event<vscode.Uri>`. The callback receives only a `Uri` — no metadata about whether it is a file or directory, no old/new content, no rename detection.

### Limitations and Gotchas

| Issue | Detail |
|-------|--------|
| **No rename detection** | Renames appear as delete + create; no built-in rename event |
| **Events may be dropped** | OS-level event services can drop events silently; no delivery guarantee |
| **No pause/resume** | Must dispose and recreate the watcher to temporarily stop events |
| **Symlinks not followed** | Need explicit `files.watcherInclude` config |
| **Network/virtual FS** | Cannot guarantee events from network drives or third-party filesystems |
| **Linux inotify limits** | Large recursive watches can exhaust file handles; VS Code shows a warning |
| **Remote workspaces** | Watcher runs on the remote, not the local OS (SSH, WSL, Docker) |
| **`files.watcherExclude`** | User settings can exclude directories from watching; the newer `excludes` option in the 1.84+ overload ignores user excludes |

### Diagnostic Logging

To debug file watcher issues: "Developer - Set Log Level" to Trace, then filter console output for "File Watcher".

## VS Code API: Notifications/Modals

### showInformationMessage — Non-Modal (default)

```typescript
showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
showInformationMessage<T extends MessageItem>(message: string, ...items: T[]): Thenable<T | undefined>;
```

- Non-modal notifications with buttons **auto-hide after a timeout** (since VS Code 1.29). Only `showErrorMessage` with buttons stays open.
- Returns `undefined` if dismissed without clicking a button.
- Returns the string or `MessageItem` that was clicked.

### showInformationMessage — Modal

```typescript
showInformationMessage(
  message: string,
  options: { modal: true; detail?: string },
  ...items: string[]
): Thenable<string | undefined>;

showInformationMessage<T extends MessageItem>(
  message: string,
  options: { modal: true; detail?: string },
  ...items: T[]
): Thenable<T | undefined>;
```

Key behaviors:
- **Blocks user interaction** until dismissed — user must click a button or press Escape.
- **`detail` property** (since VS Code 1.58): Renders a second line below the main message with less prominence but more space. Only supported when `modal: true`.
- **Auto-added Cancel button**: VS Code always adds a "Cancel" button to modal dialogs. It cannot be suppressed.
- **Escape / Cancel returns `undefined`**: Pressing Escape or clicking Cancel returns `undefined`, not a `MessageItem`.
- **`isCloseAffordance`**: Set to `true` on a `MessageItem` to make it the button triggered when the dialog is dismissed without explicit selection (Escape key).

### MessageItem Interface

```typescript
interface MessageItem {
  title: string;                  // Button label text
  isCloseAffordance?: boolean;    // If true, triggered on Escape/dismiss
}
```

### Recommended Pattern for This Project

```typescript
const action = await vscode.window.showInformationMessage(
  'Debrief: New walkthrough ready',
  {
    modal: true,
    detail: `${stepCount} steps across ${fileCount} files\n${fileName}`
  },
  { title: 'Walk Me Through It' },
  { title: 'View Summary' }
);

if (action?.title === 'Walk Me Through It') {
  // load + auto-play
} else if (action?.title === 'View Summary') {
  // show summary
}
// undefined = user dismissed/cancelled — do nothing
```

### Important: Discouraged Overuse

VS Code docs explicitly state: "If you must get immediate input from the user or need to show a message prominently, you can still use `modal: true`. We do however discourage overuse of this option because it interrupts the user." The spec calls for modal here because the notification is in response to a deliberate action (file write to `.debrief/replay/`) and must not be missed.

## VS Code API: WebviewView Lifecycle

### WebviewViewProvider Interface

```typescript
interface WebviewViewProvider {
  resolveWebviewView(
    webviewView: WebviewView,
    context: WebviewViewResolveContext,
    token: CancellationToken
  ): void | Thenable<void>;
}
```

### When resolveWebviewView Fires

- Called **when the view first becomes visible** (sidebar panel is opened/focused).
- Also called again if the user hides and then re-shows the view (webview content is destroyed when hidden).
- **NOT called** when the extension activates — only on first visibility.
- The only way to trigger it programmatically is `vscode.commands.executeCommand('viewId.focus')`, which also makes the view visible. There is no way to resolve without showing (Issue #152382, closed as duplicate of #146330).

### Webview Ready Detection

There is **no built-in "ready" event** from the VS Code API for when the webview's HTML/JS has finished loading. The standard pattern is a **ready handshake**:

1. Extension calls `resolveWebviewView`, sets `webview.html`, stores `this._view = webviewView`.
2. Webview JS executes and sends a message: `vscode.postMessage({ type: 'ready' })`.
3. Extension receives message via `webviewView.webview.onDidReceiveMessage`, then pushes pending state.

Without this handshake, `postMessage` calls made immediately after setting `webview.html` may be lost because the webview script hasn't loaded yet.

### State Persistence

- **`getState()` / `setState()`**: Webview-side APIs to save/restore JSON-serializable state. State persists when the webview goes to a background tab but is **destroyed when the webview panel is destroyed**.
- **`retainContextWhenHidden`**: If set to `true` in webview options, the webview DOM is preserved when hidden (not destroyed/recreated). Expensive — use sparingly.
- For `WebviewView` (sidebar), content is destroyed and recreated on each show/hide cycle unless `retainContextWhenHidden` is used.

### Lifecycle Timeline

```
Extension activates
  |
  v
User opens sidebar / executeCommand('viewId.focus')
  |
  v
resolveWebviewView() called
  |-- Store this._view = webviewView
  |-- Set webview.options (enableScripts, localResourceRoots)
  |-- Set webview.html
  |-- Register onDidReceiveMessage handler
  |
  v
Webview HTML loads, script executes
  |
  v
Webview sends { type: 'ready' } message  <-- Handshake
  |
  v
Extension receives 'ready', pushes pending state via postMessage
  |
  v
User hides sidebar
  |-- Webview content destroyed (unless retainContextWhenHidden)
  |-- this._view reference still valid
  |
  v
User shows sidebar again
  |-- resolveWebviewView() called again
  |-- Full cycle repeats
```

### Key Implication for Bug 2

The race condition in the spec: `engine.load()` fires `onSessionLoaded` before the timeline webview is resolved. The fix must either:
1. **Buffer the state**: Store the loaded session, and in `resolveWebviewView`, check if a session is already loaded and push it after the ready handshake.
2. **Await focus + ready**: After `executeCommand('viewId.focus')`, wait for the webview's ready message before pushing state.
3. **Retry with delay**: Current approach (100ms delay) is fragile. A handshake is more robust.

## Common Mistakes

| Mistake | Correct Approach |
|---------|------------------|
| Using backslashes in glob patterns on Windows (`src\**\*.jsonl`) | Always use forward slashes: `src/**/*.jsonl`. Or use `RelativePattern` which handles conversion. |
| Assuming `postMessage` is received immediately after setting `webview.html` | Implement a ready handshake: webview sends `{ type: 'ready' }`, extension waits for it before posting state. |
| Using a single global debounce timer for multiple file URIs | Track debounce per file URI with a `Map<string, NodeJS.Timeout>`. |
| Assuming non-modal notifications with buttons persist | Since VS Code 1.29, non-modal notifications with buttons auto-hide after timeout. Use `modal: true` for important prompts. |
| Not handling `undefined` return from modal dialogs | Modal always adds Cancel. Escape and Cancel both return `undefined`. Always check for it. |
| Calling `resolveWebviewView` programmatically without showing the view | Not possible. `viewId.focus` is the only trigger and it makes the view visible (Issue #152382). |
| Not stopping audio in `goToStep()` before executing new handler | `goToStep()` must call `ttsPlayer.stop()` before clearing timers and before executing the new step handler. `speakAsync()` calls `stop()` internally but steps without narration skip it. |
| Assuming `FileSystemWatcher` events are guaranteed | OS can drop events. Do not rely on watchers as the sole mechanism for critical state; have a fallback (e.g., manual load). |
| Using `retainContextWhenHidden` unnecessarily | Expensive for memory. Prefer the `getState()`/`setState()` + ready handshake pattern. |
| Not disposing FileSystemWatcher when extension deactivates | Push `watcher.dispose()` into `context.subscriptions` to avoid leaks. |

## Recent Issues/Updates

- **FileSystemWatcher glob on Windows** (Issue #172939, 2023): `createFileSystemWatcher` with backslash patterns (`FOLDER\**`) only matches root-level files, not nested. Root cause: backslash is not a valid glob separator. Use forward slashes or `RelativePattern`. Closed as resolved.
- **Glob exclude patterns not working** (Issues #173621, #175801, 2023): `files.watcherExclude` glob patterns do not always work; absolute paths may be needed. The 1.84+ `createFileSystemWatcher` overload with `excludes` option bypasses user excludes entirely.
- **FileSystemWatcher oddities** (Issue #26852): Callbacks receive only `Uri` — no file/directory distinction, no rename detection, no content diff. Extension authors must do additional `fs.stat()` calls.
- **Programmatic WebviewView resolution** (Issue #152382, closed 2022): No API to resolve a `WebviewView` without making it visible. Workaround: `viewId.focus` command, then push state after ready handshake.
- **Non-modal notification timeout** (VS Code 1.29+): `showInformationMessage` and `showWarningMessage` with buttons auto-hide after timeout unless `modal: true`. Only `showErrorMessage` with buttons persists.
- **Modal `detail` property** (VS Code 1.58+): Allows a secondary detail line in modal dialogs. Only effective when `modal: true`.
- **Custom excludes for watchers** (VS Code 1.84+): New proposed API overload for `createFileSystemWatcher` accepting `RelativePattern` + `{ excludes: string[] }`, which ignores user/default exclude rules.
