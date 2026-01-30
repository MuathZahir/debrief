import * as http from 'http';
import * as vscode from 'vscode';
import { traceEventSchema, sessionMetadataSchema } from '../trace/types';
import type { TraceEvent, SessionMetadata } from '../trace/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiveSession {
  metadata: SessionMetadata;
  events: TraceEvent[];
  startTime: number;
}

export interface HttpServerOptions {
  port: number;
  outputChannel: vscode.OutputChannel;
}

// ── AgentHttpServer ───────────────────────────────────────────────────────────

/**
 * Local HTTP server that agents use to stream trace events to the extension.
 *
 * Endpoints:
 * - GET  /ping           — health check
 * - POST /session/start  — begin a live session
 * - POST /event          — append an event to the live session
 * - POST /session/end    — end the live session
 * - GET  /session/status — return current session state
 *
 * Events received via POST /event are batched (200ms) before being emitted,
 * to prevent UI thrashing during rapid event bursts.
 */
export class AgentHttpServer {
  private server: http.Server | null = null;
  private liveSession: LiveSession | null = null;
  private eventBatch: TraceEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_INTERVAL_MS = 200;
  private actualPort = 0;
  private options: HttpServerOptions;

  // Events
  private readonly _onSessionStarted =
    new vscode.EventEmitter<SessionMetadata>();
  public readonly onSessionStarted = this._onSessionStarted.event;

  private readonly _onEventsReceived =
    new vscode.EventEmitter<TraceEvent[]>();
  public readonly onEventsReceived = this._onEventsReceived.event;

  private readonly _onSessionEnded =
    new vscode.EventEmitter<LiveSession>();
  public readonly onSessionEnded = this._onSessionEnded.event;

  constructor(options: HttpServerOptions) {
    this.options = options;
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get isListening(): boolean {
    return this.server?.listening ?? false;
  }

  get port(): number {
    return this.actualPort;
  }

  get hasActiveSession(): boolean {
    return this.liveSession !== null;
  }

  get currentSession(): LiveSession | null {
    return this.liveSession;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<number> {
    if (this.server?.listening) {
      return this.actualPort;
    }

    this.server = http.createServer((req, res) =>
      this.handleRequest(req, res)
    );

    return new Promise<number>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.options.outputChannel.appendLine(
            `[httpServer] Port ${this.options.port} in use, trying random port...`
          );
          // Retry on a random available port
          this.server!.listen(0, '127.0.0.1', () => {
            const addr = this.server!.address();
            this.actualPort =
              typeof addr === 'object' && addr ? addr.port : 0;
            this.options.outputChannel.appendLine(
              `[httpServer] Listening on port ${this.actualPort}`
            );
            resolve(this.actualPort);
          });
        } else {
          reject(err);
        }
      };

      this.server!.once('error', onError);

      this.server!.listen(this.options.port, '127.0.0.1', () => {
        this.server!.removeListener('error', onError);
        this.actualPort = this.options.port;
        this.options.outputChannel.appendLine(
          `[httpServer] Listening on port ${this.actualPort}`
        );
        resolve(this.actualPort);
      });
    });
  }

  stop(): void {
    this.flushBatch();
    if (this.liveSession) {
      this._onSessionEnded.fire(this.liveSession);
      this.liveSession = null;
    }
    this.server?.close();
    this.server = null;
    this.actualPort = 0;
  }

  // ── Request routing ───────────────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/ping') {
      this.handlePing(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/session/status') {
      this.handleSessionStatus(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/session/start') {
      this.readBody(req)
        .then((body) => this.handleSessionStart(body, res))
        .catch((err) => this.sendError(res, 400, err.message));
      return;
    }

    if (req.method === 'POST' && pathname === '/event') {
      this.readBody(req)
        .then((body) => this.handleEvent(body, res))
        .catch((err) => this.sendError(res, 400, err.message));
      return;
    }

    if (req.method === 'POST' && pathname === '/session/end') {
      this.handleSessionEnd(res);
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  // ── Endpoint handlers ────────────────────────────────────────────────────

  private handlePing(res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      status: 'ok',
      port: this.actualPort,
      version: '0.1.0',
    });
  }

  private handleSessionStatus(res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      active: this.liveSession !== null,
      eventCount: this.liveSession?.events.length ?? 0,
      metadata: this.liveSession?.metadata ?? null,
    });
  }

  private handleSessionStart(
    body: unknown,
    res: http.ServerResponse
  ): void {
    if (this.liveSession) {
      this.sendJson(res, 409, {
        error: 'A session is already active. End it before starting a new one.',
      });
      return;
    }

    const parsed = sessionMetadataSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(res, 400, {
        error: 'Invalid session metadata',
        details: parsed.error.issues.map((i) => i.message),
      });
      return;
    }

    this.liveSession = {
      metadata: parsed.data,
      events: [],
      startTime: Date.now(),
    };

    this._onSessionStarted.fire(parsed.data);
    this.options.outputChannel.appendLine(
      `[httpServer] Session started: ${parsed.data.agent ?? 'unknown agent'}`
    );

    this.sendJson(res, 200, { started: true });
  }

  private handleEvent(body: unknown, res: http.ServerResponse): void {
    if (!this.liveSession) {
      this.sendJson(res, 400, {
        error: 'No active session. Send POST /session/start first.',
      });
      return;
    }

    const parsed = traceEventSchema.safeParse(body);
    if (!parsed.success) {
      this.sendJson(res, 400, {
        error: 'Invalid trace event',
        details: parsed.error.issues.map((i) => i.message),
      });
      return;
    }

    this.eventBatch.push(parsed.data);

    // Start batch timer if not running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(
        () => this.flushBatch(),
        this.BATCH_INTERVAL_MS
      );
    }

    this.sendJson(res, 200, { received: true });
  }

  private handleSessionEnd(res: http.ServerResponse): void {
    if (!this.liveSession) {
      this.sendJson(res, 400, {
        error: 'No active session to end.',
      });
      return;
    }

    this.flushBatch();

    const session = this.liveSession;
    this.liveSession = null;

    this.options.outputChannel.appendLine(
      `[httpServer] Session ended: ${session.events.length} events`
    );

    this._onSessionEnded.fire(session);

    this.sendJson(res, 200, {
      ended: true,
      eventCount: session.events.length,
    });
  }

  // ── Batch flushing ────────────────────────────────────────────────────────

  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.eventBatch.length === 0) {
      return;
    }

    const batch = [...this.eventBatch];
    this.eventBatch = [];

    if (this.liveSession) {
      this.liveSession.events.push(...batch);
    }

    this._onEventsReceived.fire(batch);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve(text.length > 0 ? JSON.parse(text) : {});
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    data: unknown
  ): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(
    res: http.ServerResponse,
    statusCode: number,
    message: string
  ): void {
    this.sendJson(res, statusCode, { error: message });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  dispose(): void {
    this.flushBatch();
    this.server?.close();
    this.server = null;
    this._onSessionStarted.dispose();
    this._onEventsReceived.dispose();
    this._onSessionEnded.dispose();
  }
}
