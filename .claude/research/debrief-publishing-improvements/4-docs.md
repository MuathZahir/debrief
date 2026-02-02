# Documentation Research: Debrief Publishing Improvements

## VS Code Decoration API

**For highlight animations:**

VS Code decorations are static styling applied to text ranges. The API does NOT support CSS animations or transitions directly on decorations. Animations must be achieved through:
1. Rapidly swapping decoration types (fade effect simulation)
2. Using webview-based overlays for true CSS animations
3. Creating multiple decoration types with different opacities and cycling through them

**Key DecorationRenderOptions properties:**
- `backgroundColor` - Background color for the range
- `border` / `borderWidth` / `borderStyle` / `borderColor` - Border styling
- `outline` / `outlineWidth` / `outlineStyle` / `outlineColor` - Outline styling
- `overviewRulerColor` / `overviewRulerLane` - Minimap indicator
- `light` / `dark` - Theme-specific overrides
- `before` / `after` - Content attachments with `contentText`, `color`
- `rangeBehavior` - Controls decoration behavior when editing at edges

**RangeBehavior options:**
- `DecorationRangeBehavior.OpenOpen` - Decoration grows when typing at edges
- `DecorationRangeBehavior.ClosedClosed` - Decoration stays fixed
- `DecorationRangeBehavior.OpenClosed` - Grows at start, fixed at end
- `DecorationRangeBehavior.ClosedOpen` - Fixed at start, grows at end

**Code example:**
```typescript
// Creating a decoration type with styling
const highlightDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 255, 0, 0.3)',
    borderWidth: '1px',
    borderStyle: 'solid',
    overviewRulerColor: 'blue',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    light: {
        borderColor: 'darkblue'
    },
    dark: {
        borderColor: 'lightblue'
    }
});

// Applying decorations to ranges
activeEditor.setDecorations(highlightDecorationType, [
    { range: new vscode.Range(10, 0, 10, 50), hoverMessage: 'Highlighted line' }
]);

// Using theme colors
const warningDecoration = vscode.window.createTextEditorDecorationType({
    before: {
        contentText: "\u26A0",
        color: new vscode.ThemeColor('editorWarning.foreground')
    }
});
```

**Simulating fade-in animation:**
```typescript
// Create multiple decoration types with increasing opacity
const fadeSteps = [0.1, 0.3, 0.5, 0.7, 1.0];
const decorationTypes = fadeSteps.map(opacity =>
    vscode.window.createTextEditorDecorationType({
        backgroundColor: `rgba(255, 255, 0, ${opacity * 0.3})`
    })
);

// Cycle through them with setTimeout
async function fadeInHighlight(editor: vscode.TextEditor, range: vscode.Range) {
    for (let i = 0; i < decorationTypes.length; i++) {
        // Clear previous
        if (i > 0) editor.setDecorations(decorationTypes[i - 1], []);
        // Apply current
        editor.setDecorations(decorationTypes[i], [range]);
        await new Promise(r => setTimeout(r, 50)); // 50ms per step = 250ms total
    }
}
```

## Editor Reveal

**revealRange options:**

The `TextEditor.revealRange()` method scrolls the editor to show a specific range.

**TextEditorRevealType enum:**
- `Default` - Scrolls minimally to show the range
- `InCenter` - Scrolls to place the range in the center of the viewport
- `InCenterIfOutsideViewport` - Centers only if range is outside current view
- `AtTop` - Scrolls to place the range at the top of the viewport

**Code example:**
```typescript
// Reveal range in center
editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

// Reveal at top of viewport
editor.revealRange(range, vscode.TextEditorRevealType.AtTop);

// Alternative: using command
vscode.commands.executeCommand('revealLine', {
    lineNumber: 10,
    at: 'center'  // 'top', 'center', or 'bottom'
});
```

**Best practice for smooth transitions:**
```typescript
// Reveal before applying decoration for smoother UX
async function highlightWithReveal(editor: vscode.TextEditor, range: vscode.Range) {
    // First reveal the range
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    // Small delay for scroll to complete
    await new Promise(r => setTimeout(r, 100));

    // Then apply decoration
    editor.setDecorations(highlightDecorationType, [range]);
}
```

## Webview Communication

**postMessage patterns:**

**Extension to Webview:**
```typescript
// In extension
panel.webview.postMessage({ command: 'update', data: { step: 5 } });

// In webview HTML/JS
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'update':
            updateUI(message.data);
            break;
    }
});
```

**Webview to Extension:**
```typescript
// In webview HTML/JS
const vscode = acquireVsCodeApi();  // Can only call once!
vscode.postMessage({ command: 'stepClicked', stepId: '123' });

// In extension
panel.webview.onDidReceiveMessage(
    message => {
        switch (message.command) {
            case 'stepClicked':
                handleStepClick(message.stepId);
                return;
        }
    },
    undefined,
    context.subscriptions
);
```

**Best practices:**
1. Call `acquireVsCodeApi()` once and store the reference
2. Use a consistent message format with `command` field for routing
3. Handle messages in a switch statement for clarity
4. Add messages to `context.subscriptions` for proper disposal
5. Always enable scripts: `{ enableScripts: true }` in webview options
6. JSON-serializable data only (no functions, circular references)

**WebviewView (sidebar) pattern:**
```typescript
class TimelineViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(message => {
            // Handle messages
        });
    }

    public postMessage(message: any) {
        this._view?.webview.postMessage(message);
    }
}
```

## Publishing Requirements

**vsce package:**

Install: `npm install -g @vscode/vsce`

**Required package.json fields:**
| Field | Requirement |
|-------|-------------|
| `name` | Unique identifier (lowercase, no spaces) |
| `displayName` | Human-readable name |
| `version` | Semver format (major.minor.patch) |
| `publisher` | Publisher ID from marketplace |
| `engines.vscode` | Minimum VS Code version (e.g., `^1.85.0`) |
| `main` | Entry point path |

**Icon requirements:**
- Minimum 128x128 pixels (256x256 recommended)
- PNG format
- Relative path in `icon` field
```json
{
    "icon": "images/icon.png"
}
```

**README requirements:**
- Must exist at project root
- Automatically included in marketplace listing
- Should include: description, features, usage, requirements

**CHANGELOG requirements:**
- Recommended: `CHANGELOG.md` at project root
- Automatically included by vsce
- Document version history

**Complete manifest example:**
```json
{
    "name": "debrief",
    "displayName": "Debrief",
    "description": "Narrated code walkthroughs with TTS",
    "version": "0.1.0",
    "publisher": "muath-zaher",
    "engines": {
        "vscode": "^1.85.0"
    },
    "categories": ["Other"],
    "icon": "images/icon.png",
    "repository": {
        "type": "git",
        "url": "https://github.com/user/debrief.git"
    },
    "license": "MIT",
    "main": "./dist/extension.js",
    "activationEvents": ["onStartupFinished"],
    "contributes": { /* ... */ }
}
```

**Packaging commands:**
```bash
# Package without publishing
vsce package

# Package pre-release
vsce package --pre-release

# Skip dependency bundling (if using bundler like esbuild)
vsce package --no-dependencies

# Publish to marketplace
vsce publish
```

## Common Mistakes

| Mistake | Correct Approach |
|---------|------------------|
| Missing `publisher` field | Add `"publisher": "your-publisher-id"` to package.json |
| Icon too small | Use at least 128x128 PNG, preferably 256x256 |
| Missing `repository` field | Add repository URL for marketplace linking |
| Calling `acquireVsCodeApi()` multiple times | Call once, store reference, pass to functions |
| Not disposing decoration types | Call `decorationType.dispose()` when done |
| Expecting CSS animations on decorations | Use decoration swapping or webview overlays |
| Using `revealRange` without delay before decorations | Add small delay (50-100ms) for smooth scroll |
| Missing `enableScripts: true` for webviews | Always set when using postMessage |
| Hardcoding colors instead of ThemeColors | Use `new vscode.ThemeColor('editor.foreground')` |
| Not handling webview disposal | Check if view exists before posting messages |
| Including node_modules in vsix | Use `.vscodeignore` and bundler |
| Missing `engines.vscode` field | Required - specify minimum VS Code version |
| Using semver pre-release tags | Only `major.minor.patch` supported by vsce |

## Animation Alternatives

Since VS Code decorations don't support CSS animations, consider these approaches:

**1. Decoration cycling (recommended for highlights):**
- Create 5-10 decoration types with varying opacity
- Cycle through them at 30-50ms intervals
- Provides fade-in/pulse effect

**2. Webview overlay (for complex animations):**
- Position a webview over the editor
- Use CSS animations in the webview
- More complex but full animation support

**3. Status bar / notification (for transitions):**
- Show "Opening file..." in status bar
- Use `vscode.window.withProgress` for loading indicators

**File transition indicator pattern:**
```typescript
async function transitionToFile(filePath: string, range: vscode.Range) {
    // Show brief indicator
    const statusBarItem = vscode.window.createStatusBarItem();
    statusBarItem.text = "$(loading~spin) Opening...";
    statusBarItem.show();

    // Open file
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    // Small delay for visual feedback
    await new Promise(r => setTimeout(r, 200));

    // Hide indicator and reveal
    statusBarItem.dispose();
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
```
