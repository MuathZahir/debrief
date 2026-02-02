import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';
import { spawn, ChildProcess } from 'child_process';

/**
 * TTS audio player for replay narration.
 * Uses OpenAI TTS API to generate speech and plays via webview audio.
 */
export type TtsVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';


export class TtsPlayer {
  private audioCache: Map<string, string> = new Map(); // cacheKey -> tempFilePath
  private isEnabled = true;
  private outputChannel: vscode.OutputChannel;
  private tempDir: string;
  private voice: TtsVoice = 'alloy';
  private speed: number = 1.0;
  private isPlaying = false;
  private currentRequestId: number = 0;
  private currentProcess: ChildProcess | null = null;

  // Event fired when playback completes (naturally or via stop)
  private readonly _onPlaybackComplete = new vscode.EventEmitter<{ requestId: number; cancelled: boolean }>();
  public readonly onPlaybackComplete = this._onPlaybackComplete.event;

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;
    this.tempDir = path.join(os.tmpdir(), 'debrief-tts');

    // Ensure temp directory exists
    fs.mkdirSync(this.tempDir, { recursive: true });

    context.subscriptions.push({ dispose: () => this.dispose() });

    // Initialize from configuration
    this.loadConfig();

    // Listen for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('debrief.enableTts') ||
            e.affectsConfiguration('debrief.ttsVoice') ||
            e.affectsConfiguration('debrief.ttsSpeed')) {
          this.loadConfig();
          if (!this.isEnabled) {
            this.stop();
          }
        }
      })
    );
  }

  /**
   * Load configuration from VS Code settings.
   */
  private loadConfig(): void {
    const config = vscode.workspace.getConfiguration('debrief');
    this.isEnabled = config.get<boolean>('enableTts', true);
    this.voice = config.get<TtsVoice>('ttsVoice', 'alloy');
    this.speed = config.get<number>('ttsSpeed', 1.0);
    this.outputChannel.appendLine(`[TtsPlayer] Config loaded - enabled: ${this.isEnabled}, voice: ${this.voice}, speed: ${this.speed}`);
  }

  /**
   * Start TTS audio without waiting for completion.
   * Use this for the TTS-first pattern where navigation happens while audio plays.
   * Cancels any previous in-flight or playing TTS request.
   * @param text The narration text to speak
   * @param eventId Unique ID for caching
   */
  speakAsync(text: string, eventId: string): void {
    // Stop any currently playing audio FIRST (before incrementing ID)
    // This ensures the completion event fires with the OLD request ID
    this.stop();

    // Now increment request ID for the new request
    const requestId = ++this.currentRequestId;

    this.speakWithRequestId(text, eventId, requestId).catch(err => {
      // Only log if this was still the active request
      if (requestId === this.currentRequestId) {
        this.outputChannel.appendLine(`[TtsPlayer] Async speak error: ${err}`);
      }
    });
  }

  /**
   * Generate TTS audio only (without playing).
   * Used for pre-generation to cache audio before playback.
   * @param text The narration text to generate
   * @param eventId Unique ID for logging
   * @returns Path to the generated audio file
   */
  async generateOnly(text: string, eventId: string): Promise<string> {
    this.outputChannel.appendLine(`[TtsPlayer] generateOnly() called - eventId: ${eventId}`);

    if (!text.trim()) {
      throw new Error('Empty text');
    }

    const cacheKey = this.getCacheKey(text);
    let audioFilePath = this.audioCache.get(cacheKey);

    if (audioFilePath && fs.existsSync(audioFilePath)) {
      this.outputChannel.appendLine(`[TtsPlayer] Using cached audio: ${audioFilePath}`);
      return audioFilePath;
    }

    audioFilePath = await this.generateTts(text, cacheKey);
    this.audioCache.set(cacheKey, audioFilePath);
    return audioFilePath;
  }

  /**
   * Check if audio is currently playing.
   */
  get playing(): boolean {
    return this.isPlaying;
  }

  /**
   * Generate and play TTS audio for the given text (blocking).
   * Prefer speakAsync() for non-blocking TTS with proper cancellation.
   * @param text The narration text to speak
   * @param eventId Unique ID for caching
   */
  async speak(text: string, eventId: string): Promise<void> {
    // Stop first, then increment ID (same as speakAsync)
    this.stop();
    const requestId = ++this.currentRequestId;
    await this.speakWithRequestId(text, eventId, requestId);
  }

  /**
   * Internal: Generate and play TTS with request ID tracking for cancellation.
   */
  private async speakWithRequestId(text: string, eventId: string, requestId: number): Promise<void> {
    this.outputChannel.appendLine(`[TtsPlayer] speak() called - enabled: ${this.isEnabled}, eventId: ${eventId}, requestId: ${requestId}`);

    if (!this.isEnabled) {
      this.outputChannel.appendLine(`[TtsPlayer] TTS is disabled in settings`);
      // Defer completion to next tick so listener has time to be set up
      setImmediate(() => {
        if (requestId === this.currentRequestId) {
          this._onPlaybackComplete.fire({ requestId, cancelled: true });
        }
      });
      return;
    }

    if (!text.trim()) {
      this.outputChannel.appendLine(`[TtsPlayer] Empty text, skipping`);
      // Defer completion to next tick so listener has time to be set up
      setImmediate(() => {
        if (requestId === this.currentRequestId) {
          this._onPlaybackComplete.fire({ requestId, cancelled: true });
        }
      });
      return;
    }

    // Check cache first
    const cacheKey = this.getCacheKey(text);
    let audioFilePath = this.audioCache.get(cacheKey);

    if (!audioFilePath || !fs.existsSync(audioFilePath)) {
      try {
        audioFilePath = await this.generateTts(text, cacheKey);
        this.audioCache.set(cacheKey, audioFilePath);
      } catch (err) {
        this.outputChannel.appendLine(`[TtsPlayer] Failed to generate TTS: ${err}`);
        vscode.window.showWarningMessage(`TTS failed: ${err}`);
        // Defer completion to next tick so listener has time to be set up
        setImmediate(() => {
          if (requestId === this.currentRequestId) {
            this._onPlaybackComplete.fire({ requestId, cancelled: true });
          }
        });
        return;
      }
    } else {
      this.outputChannel.appendLine(`[TtsPlayer] Using cached audio: ${audioFilePath}`);
    }

    // Before playing, check if we're still the current request
    if (requestId !== this.currentRequestId) {
      this.outputChannel.appendLine(`[TtsPlayer] Request ${requestId} superseded by ${this.currentRequestId}, aborting playback`);
      return;
    }

    // Play the audio using system player
    try {
      await this.playAudioFile(audioFilePath);
      // Fire completion event (natural completion, not cancelled)
      if (requestId === this.currentRequestId) {
        this._onPlaybackComplete.fire({ requestId, cancelled: false });
      }
    } catch (err) {
      this.outputChannel.appendLine(`[TtsPlayer] Failed to play audio: ${err}`);
      // Fire completion event even on error
      if (requestId === this.currentRequestId) {
        this._onPlaybackComplete.fire({ requestId, cancelled: true });
      }
    }
  }

  /**
   * Stop current audio playback.
   */
  stop(): void {
    const wasPlaying = this.isPlaying;

    // Kill the current audio process if running
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }

    this.isPlaying = false;

    // Fire completion event if we were playing (cancelled)
    if (wasPlaying) {
      this._onPlaybackComplete.fire({ requestId: this.currentRequestId, cancelled: true });
    }
  }

  /**
   * Get the current request ID (for tracking which TTS is active).
   */
  get requestId(): number {
    return this.currentRequestId;
  }

  /**
   * Enable or disable TTS playback.
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (!enabled) {
      this.stop();
    }
  }

  /**
   * Check if TTS is enabled.
   */
  get enabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Clear the audio cache.
   */
  clearCache(): void {
    // Delete cached audio files
    for (const filePath of this.audioCache.values()) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    this.audioCache.clear();
  }

  /**
   * Generate TTS audio using OpenAI API.
   */
  private async generateTts(text: string, cacheKey: string): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      const errorMsg = 'OPENAI_API_KEY not configured. Set it in:\n' +
        '1. VS Code settings: debrief.openaiApiKey\n' +
        '2. Environment variable: OPENAI_API_KEY\n' +
        '3. .env file in workspace root';
      this.outputChannel.appendLine(`[TtsPlayer] ERROR: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    this.outputChannel.appendLine(`[TtsPlayer] Generating TTS for: "${text.slice(0, 50)}..." (key: ${apiKey.slice(0, 8)}...)`);

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1-hd',
        voice: this.voice,
        input: text,
        response_format: 'mp3',
        speed: this.speed,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Save to temp file
    const filePath = path.join(this.tempDir, `${cacheKey}.mp3`);
    fs.writeFileSync(filePath, buffer);

    this.outputChannel.appendLine(`[TtsPlayer] TTS saved to: ${filePath} (${Math.round(buffer.length / 1024)}KB)`);

    return filePath;
  }

  /**
   * Play audio file using system audio player.
   * Uses PowerShell on Windows, afplay on macOS, mpv/paplay on Linux.
   */
  private playAudioFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.outputChannel.appendLine(`[TtsPlayer] Playing audio via system: ${filePath}`);
      this.isPlaying = true;

      let command: string;
      let args: string[];

      const platform = os.platform();
      if (platform === 'win32') {
        // Windows: Use PowerShell with Windows Media Player COM object (supports MP3)
        const escapedPath = filePath.replace(/'/g, "''");
        command = 'powershell';
        args = [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName PresentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([Uri]'${escapedPath}'); $player.Play(); Start-Sleep -Milliseconds 500; while ($player.Position -lt $player.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 100 }; $player.Close()`,
        ];
      } else if (platform === 'darwin') {
        // macOS: Use afplay
        command = 'afplay';
        args = [filePath];
      } else {
        // Linux: Try mpv first, fall back to paplay
        command = 'mpv';
        args = ['--no-video', '--really-quiet', filePath];
      }

      this.outputChannel.appendLine(`[TtsPlayer] Running: ${command} ${args.join(' ')}`);

      const proc = spawn(command, args, {
        stdio: 'ignore',
        detached: false,
      });

      this.currentProcess = proc;

      proc.on('error', (err) => {
        this.isPlaying = false;
        this.currentProcess = null;
        this.outputChannel.appendLine(`[TtsPlayer] Process error: ${err.message}`);
        reject(err);
      });

      proc.on('close', (code) => {
        this.isPlaying = false;
        this.currentProcess = null;

        if (code === 0 || code === null) {
          this.outputChannel.appendLine(`[TtsPlayer] Playback completed`);
          resolve();
        } else {
          this.outputChannel.appendLine(`[TtsPlayer] Process exited with code ${code}`);
          reject(new Error(`Audio player exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Get OpenAI API key from various sources.
   */
  private getApiKey(): string | undefined {
    // 1. Check VS Code settings first
    const config = vscode.workspace.getConfiguration('debrief');
    const settingsKey = config.get<string>('openaiApiKey');
    if (settingsKey) {
      this.outputChannel.appendLine(`[TtsPlayer] Using API key from VS Code settings`);
      return settingsKey;
    }

    // 2. Check environment variable
    if (process.env.OPENAI_API_KEY) {
      this.outputChannel.appendLine(`[TtsPlayer] Using API key from environment variable`);
      return process.env.OPENAI_API_KEY;
    }

    // 3. Try to load from .env files in workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        // Check workspace root .env
        const rootEnvPath = path.join(folder.uri.fsPath, '.env');
        if (fs.existsSync(rootEnvPath)) {
          this.outputChannel.appendLine(`[TtsPlayer] Loading .env from: ${rootEnvPath}`);
          const result = dotenv.config({ path: rootEnvPath });
          if (result.parsed?.OPENAI_API_KEY) {
            this.outputChannel.appendLine(`[TtsPlayer] Found API key in ${rootEnvPath}`);
            return result.parsed.OPENAI_API_KEY;
          }
        }

        // Check extension folder .env
        const extEnvPath = path.join(folder.uri.fsPath, 'extensions', 'debrief', '.env');
        if (fs.existsSync(extEnvPath)) {
          this.outputChannel.appendLine(`[TtsPlayer] Loading .env from: ${extEnvPath}`);
          const result = dotenv.config({ path: extEnvPath });
          if (result.parsed?.OPENAI_API_KEY) {
            this.outputChannel.appendLine(`[TtsPlayer] Found API key in ${extEnvPath}`);
            return result.parsed.OPENAI_API_KEY;
          }
        }
      }
    }

    this.outputChannel.appendLine(`[TtsPlayer] No API key found in settings, environment, or .env files`);
    return undefined;
  }

  /**
   * Generate a cache key for the text.
   */
  private getCacheKey(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `tts_${Math.abs(hash)}`;
  }

  dispose(): void {
    this.stop();
    this.clearCache();
    this._onPlaybackComplete.dispose();
  }
}
