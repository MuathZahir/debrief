# Documentation Research: TTS Optimization

## VS Code Extension Patterns

### Progress Indicators

VS Code provides multiple ways to show progress for long-running operations:

**1. Notification Progress (Global)**
```typescript
vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Preparing audio",
    cancellable: true
}, async (progress, token) => {
    token.onCancellationRequested(() => {
        console.log("User canceled the operation");
    });

    for (let i = 0; i < totalSteps; i++) {
        progress.report({ increment: (100 / totalSteps), message: `(${i + 1}/${totalSteps})` });
        await generateTts(steps[i]);
        if (token.isCancellationRequested) {
            return;
        }
    }
});
```

**2. Window/Status Bar Progress (Subtle)**
```typescript
vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: 'Preparing audio'
}, async (progress) => {
    progress.report({ message: 'Step 1 of 20' });
    await step1();
    progress.report({ message: 'Step 2 of 20' });
    await step2();
});
```

**Best Practice:** For TTS pre-generation, use `ProgressLocation.Window` (status bar) for subtle background indication, but show progress in the webview timeline for richer UX.

### Webview Communication Patterns

**Extension to Webview:**
```typescript
// Extension side
panel.webview.postMessage({
    type: 'progress-update',
    current: 5,
    total: 20
});

// Webview side (JavaScript)
window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'progress-update') {
        updateProgressBar(message.current, message.total);
    }
});
```

**Webview to Extension:**
```javascript
// Webview side
const vscode = acquireVsCodeApi();
vscode.postMessage({ command: 'cancel-pregeneration' });

// Extension side
panel.webview.onDidReceiveMessage(
    message => {
        if (message.command === 'cancel-pregeneration') {
            preloader.cancel();
        }
    },
    undefined,
    context.subscriptions
);
```

### EventEmitter Patterns

VS Code uses a consistent pattern for custom events:

```typescript
class TtsPreloader {
    private _onProgress = new vscode.EventEmitter<{ current: number; total: number }>();
    readonly onProgress: vscode.Event<{ current: number; total: number }> = this._onProgress.event;

    private _onComplete = new vscode.EventEmitter<void>();
    readonly onComplete: vscode.Event<void> = this._onComplete.event;

    private _onError = new vscode.EventEmitter<{ stepId: string; error: Error }>();
    readonly onError: vscode.Event<{ stepId: string; error: Error }> = this._onError.event;

    async pregenerate(steps: TraceStep[]): Promise<void> {
        for (let i = 0; i < steps.length; i++) {
            try {
                await this.generateTts(steps[i]);
                this._onProgress.fire({ current: i + 1, total: steps.length });
            } catch (error) {
                this._onError.fire({ stepId: steps[i].id, error });
            }
        }
        this._onComplete.fire();
    }

    dispose() {
        this._onProgress.dispose();
        this._onComplete.dispose();
        this._onError.dispose();
    }
}
```

**Naming Convention:** Use `onDid*` for events that fire after something happened (e.g., `onDidChangeTreeData`, `onDidWriteData`).

### Webview State Persistence

**For simple state (recommended for timeline):**
```javascript
// Inside webview
const vscode = acquireVsCodeApi();
const previousState = vscode.getState();
let collapsedSections = previousState?.collapsedSections || [];

function toggleSection(sectionId) {
    // Update state
    vscode.setState({ collapsedSections });
}
```

**For complex state (use sparingly - high memory):**
```typescript
const panel = vscode.window.createWebviewPanel('timeline', 'Timeline', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true  // Keeps webview alive when hidden
});
```

## OpenAI TTS API

### Rate Limits

| Tier | Model | RPM (Requests/min) | Notes |
|------|-------|-------------------|-------|
| Free | tts-1 | ~3 | Very limited |
| Tier 1 | tts-1 | ~50 | Entry paid tier |
| Tier 2+ | tts-1 | ~100+ | Increases with usage |
| All | tts-1-hd | Similar to tts-1 | Higher quality |

**Key Headers to Monitor:**
- `x-ratelimit-limit-requests` - Your RPM limit
- `x-ratelimit-remaining-requests` - Requests left this minute
- `x-ratelimit-reset-requests` - When limit resets
- `retry-after` - Seconds to wait (on 429)

### Error Handling

**429 Error Response:**
```json
{
    "error": {
        "message": "Rate limit reached for tts-1 in organization org-xxx on requests per min...",
        "type": "rate_limit_error",
        "code": "rate_limit_exceeded"
    }
}
```

**Recommended Retry Strategy:**
```typescript
import { backOff } from 'exponential-backoff';

async function generateTtsWithRetry(text: string): Promise<Buffer> {
    return backOff(
        () => openai.audio.speech.create({
            model: 'tts-1',
            voice: 'alloy',
            input: text
        }),
        {
            numOfAttempts: 3,
            startingDelay: 1000,      // 1 second
            timeMultiple: 2,          // 1s, 2s, 4s
            jitter: 'full',           // Randomize delays
            retry: (error, attemptNumber) => {
                const isRateLimit = error?.status === 429;
                console.log(`Attempt ${attemptNumber} failed: ${isRateLimit ? 'rate limit' : error.message}`);
                return isRateLimit; // Only retry on rate limits
            }
        }
    );
}
```

### Best Practices

1. **Pre-generate sequentially** - Don't parallelize TTS calls; sequential requests are more reliable
2. **Respect `retry-after` header** - When present, wait the specified time before retrying
3. **Cache aggressively** - Hash narration text and reuse cached audio files
4. **Graceful degradation** - If TTS fails after retries, mark step as "no audio" and continue
5. **Monitor usage** - Log rate limit headers to understand your actual limits

## Background Task Patterns

### Queue Management

**Simple In-Memory Queue Pattern:**
```typescript
interface TtsJob {
    stepId: string;
    text: string;
    priority: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    retries: number;
    audioPath?: string;
}

class TtsQueue {
    private queue: TtsJob[] = [];
    private isProcessing = false;
    private _onJobComplete = new vscode.EventEmitter<TtsJob>();

    add(job: TtsJob) {
        this.queue.push(job);
        this.queue.sort((a, b) => b.priority - a.priority); // Higher priority first
        this.processNext();
    }

    prioritize(stepId: string) {
        const job = this.queue.find(j => j.stepId === stepId);
        if (job) {
            job.priority = 100; // Boost priority
            this.queue.sort((a, b) => b.priority - a.priority);
        }
    }

    private async processNext() {
        if (this.isProcessing || this.queue.length === 0) return;

        const job = this.queue.find(j => j.status === 'pending');
        if (!job) return;

        this.isProcessing = true;
        job.status = 'processing';

        try {
            job.audioPath = await this.generateTts(job.text);
            job.status = 'completed';
            this._onJobComplete.fire(job);
        } catch (error) {
            job.retries++;
            if (job.retries < 3) {
                job.status = 'pending';
            } else {
                job.status = 'failed';
            }
        }

        this.isProcessing = false;
        this.processNext();
    }
}
```

### Retry with Backoff

**Using `exponential-backoff` npm package (recommended):**
```typescript
import { backOff } from 'exponential-backoff';

const result = await backOff(
    () => riskyOperation(),
    {
        numOfAttempts: 3,           // Max 3 attempts total
        startingDelay: 1000,        // Start with 1 second delay
        timeMultiple: 2,            // Double delay each retry
        maxDelay: 10000,            // Cap at 10 seconds
        jitter: 'full',             // Add randomness to prevent thundering herd
        retry: (error, attemptNumber) => {
            // Return true to retry, false to stop
            return error?.status === 429 || error?.code === 'ETIMEDOUT';
        }
    }
);
```

**Manual Implementation (no dependencies):**
```typescript
async function withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 3,
    baseDelay = 1000
): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts) break;

            // Check for retry-after header
            const retryAfter = error?.response?.headers?.['retry-after'];
            const delay = retryAfter
                ? parseInt(retryAfter) * 1000
                : baseDelay * Math.pow(2, attempt - 1) * (0.5 + Math.random());

            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}
```

### Cancellation Pattern

```typescript
class CancellablePreloader {
    private abortController: AbortController | null = null;

    async pregenerate(steps: TraceStep[]) {
        this.abortController = new AbortController();

        for (const step of steps) {
            if (this.abortController.signal.aborted) {
                break;
            }
            await this.generateTts(step, this.abortController.signal);
        }
    }

    cancel() {
        this.abortController?.abort();
    }

    private async generateTts(step: TraceStep, signal: AbortSignal) {
        const response = await fetch(url, { signal });
        // ... process response
    }
}
```

## Common Mistakes

| Mistake | Correct Approach |
|---------|------------------|
| Parallelizing TTS calls | Process sequentially to avoid rate limits; queue with priority boosting |
| No retry on 429 errors | Implement exponential backoff with 3 retries and jitter |
| Blocking UI during pre-generation | Run in background, update webview via postMessage |
| Regenerating unchanged audio | Cache audio files using content hash of narration text |
| Not handling cancellation | Use AbortController; check abort signal in loops |
| Using `retainContextWhenHidden` by default | Only use when absolutely necessary; prefer `getState`/`setState` |
| Firing events without disposal | Always dispose EventEmitters in extension's `dispose()` method |
| Ignoring `retry-after` header | Parse and respect the header value when present |
| Resetting queue on trace reload | Clear old queue, cancel in-progress jobs, then start fresh |
| No visual feedback when playback catches up | Show spinner on step UI until audio is ready |

## Sources

### VS Code Documentation
- [VS Code Webview API Guide](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/webview.md)
- [VS Code Tree View Guide](https://github.com/microsoft/vscode-docs/blob/main/api/extension-guides/tree-view.md)
- [VS Code Release Notes v1.22 - Progress API](https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_22.md)
- [VS Code Extension Samples](https://github.com/microsoft/vscode-extension-samples)

### OpenAI Documentation
- [OpenAI Rate Limits Guide](https://platform.openai.com/docs/guides/rate-limits)
- [OpenAI Cookbook - How to Handle Rate Limits](https://cookbook.openai.com/examples/how_to_handle_rate_limits)
- [OpenAI Help Center - 429 Errors](https://help.openai.com/en/articles/5955604-how-can-i-solve-429-too-many-requests-errors)

### Libraries
- [exponential-backoff npm](https://www.npmjs.com/package/exponential-backoff)
- [BullMQ - Background Jobs](https://bullmq.io/)
