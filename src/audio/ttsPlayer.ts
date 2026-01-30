import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import * as dotenv from 'dotenv';

/**
 * TTS audio player for replay narration.
 * Uses OpenAI TTS API to generate speech and plays via system audio.
 */
export type TtsVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

/**
 * Word-level timing from Whisper transcription.
 */
export interface WordTiming {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

/**
 * Result from TTS generation with word timings.
 */
export interface TtsResult {
  requestId: number;
  wordTimings: WordTiming[];
  duration: number; // seconds
}

export class TtsPlayer {
  private audioCache: Map<string, string> = new Map(); // cacheKey -> tempFilePath
  private timingsCache: Map<string, WordTiming[]> = new Map(); // cacheKey -> word timings
  private isEnabled = true;
  private currentProcess: ReturnType<typeof spawn> | null = null;
  private outputChannel: vscode.OutputChannel;
  private tempDir: string;
  private voice: TtsVoice = 'alloy';
  private speed: number = 1.0;
  private isPlaying = false;
  private currentRequestId: number = 0;

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
    // Increment request ID - invalidates any in-flight requests
    const requestId = ++this.currentRequestId;

    // Stop any currently playing audio immediately
    this.stop();

    this.speakWithRequestId(text, eventId, requestId).catch(err => {
      // Only log if this was still the active request
      if (requestId === this.currentRequestId) {
        this.outputChannel.appendLine(`[TtsPlayer] Async speak error: ${err}`);
      }
    });
  }

  /**
   * Start TTS audio with word-level timing callback.
   * The callback fires BEFORE playback starts, with Whisper-derived word timings.
   * Use this for synchronized visual effects (e.g., timed line highlights).
   *
   * @param text The narration text to speak
   * @param eventId Unique ID for caching
   * @param onTimingsReady Callback with word timings (fires before playback)
   */
  speakAsyncWithTimings(
    text: string,
    eventId: string,
    onTimingsReady: (result: TtsResult) => void
  ): void {
    const requestId = ++this.currentRequestId;
    this.stop();

    this.speakWithTimings(text, eventId, requestId, onTimingsReady).catch(err => {
      if (requestId === this.currentRequestId) {
        this.outputChannel.appendLine(`[TtsPlayer] Async speak with timings error: ${err}`);
      }
    });
  }

  /**
   * Internal: Generate TTS, get word timings, then play.
   */
  private async speakWithTimings(
    text: string,
    eventId: string,
    requestId: number,
    onTimingsReady: (result: TtsResult) => void
  ): Promise<void> {
    this.outputChannel.appendLine(`[TtsPlayer] speakWithTimings() called - eventId: ${eventId}, requestId: ${requestId}`);

    if (!this.isEnabled) {
      this.outputChannel.appendLine(`[TtsPlayer] TTS is disabled in settings`);
      return;
    }

    if (!text.trim()) {
      this.outputChannel.appendLine(`[TtsPlayer] Empty text, skipping`);
      return;
    }

    const cacheKey = this.getCacheKey(text);
    let audioFilePath = this.audioCache.get(cacheKey);
    let wordTimings = this.timingsCache.get(cacheKey);

    // Generate TTS if not cached
    if (!audioFilePath || !fs.existsSync(audioFilePath)) {
      try {
        audioFilePath = await this.generateTts(text, cacheKey);
        this.audioCache.set(cacheKey, audioFilePath);
      } catch (err) {
        this.outputChannel.appendLine(`[TtsPlayer] Failed to generate TTS: ${err}`);
        vscode.window.showWarningMessage(`TTS failed: ${err}`);
        return;
      }
    }

    // Get word timings via Whisper if not cached
    if (!wordTimings) {
      try {
        wordTimings = await this.transcribeForTimings(audioFilePath);
        this.timingsCache.set(cacheKey, wordTimings);
        this.outputChannel.appendLine(`[TtsPlayer] Got ${wordTimings.length} word timings from Whisper`);
      } catch (err) {
        this.outputChannel.appendLine(`[TtsPlayer] Whisper transcription failed: ${err}`);
        // Continue without timings - graceful degradation
        wordTimings = [];
      }
    } else {
      this.outputChannel.appendLine(`[TtsPlayer] Using cached word timings (${wordTimings.length} words)`);
    }

    // Check if still current request
    if (requestId !== this.currentRequestId) {
      this.outputChannel.appendLine(`[TtsPlayer] Request ${requestId} superseded, aborting`);
      return;
    }

    // Calculate duration from last word timing or estimate
    const duration = wordTimings.length > 0
      ? wordTimings[wordTimings.length - 1].end
      : text.split(/\s+/).length * 0.3; // rough estimate: 0.3s per word

    // Fire callback BEFORE playback starts
    onTimingsReady({ requestId, wordTimings, duration });

    // Play the audio
    try {
      await this.playAudioFile(audioFilePath);
      if (requestId === this.currentRequestId) {
        this._onPlaybackComplete.fire({ requestId, cancelled: false });
      }
    } catch (err) {
      this.outputChannel.appendLine(`[TtsPlayer] Failed to play audio: ${err}`);
      if (requestId === this.currentRequestId) {
        this._onPlaybackComplete.fire({ requestId, cancelled: true });
      }
    }
  }

  /**
   * Transcribe audio file with Whisper to get word-level timestamps.
   */
  private async transcribeForTimings(audioPath: string): Promise<WordTiming[]> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }

    this.outputChannel.appendLine(`[TtsPlayer] Transcribing with Whisper: ${audioPath}`);

    // Read audio file as buffer
    const audioBuffer = fs.readFileSync(audioPath);
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mp3' });

    // Create form data
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error: ${response.status} ${errorText}`);
    }

    const result = await response.json() as {
      words?: Array<{ word: string; start: number; end: number }>;
    };

    return (result.words ?? []).map(w => ({
      word: w.word,
      start: w.start,
      end: w.end,
    }));
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
    const requestId = ++this.currentRequestId;
    this.stop();
    await this.speakWithRequestId(text, eventId, requestId);
  }

  /**
   * Internal: Generate and play TTS with request ID tracking for cancellation.
   */
  private async speakWithRequestId(text: string, eventId: string, requestId: number): Promise<void> {
    this.outputChannel.appendLine(`[TtsPlayer] speak() called - enabled: ${this.isEnabled}, eventId: ${eventId}, requestId: ${requestId}`);

    if (!this.isEnabled) {
      this.outputChannel.appendLine(`[TtsPlayer] TTS is disabled in settings`);
      return;
    }

    if (!text.trim()) {
      this.outputChannel.appendLine(`[TtsPlayer] Empty text, skipping`);
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
   * Clear the audio and timings caches.
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
    this.timingsCache.clear();
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
   * Play audio file using system player.
   */
  private playAudioFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const platform = process.platform;
      let command: string;
      let args: string[];

      if (platform === 'win32') {
        // Windows: use PowerShell with Windows Media Player COM object for MP3
        command = 'powershell';
        args = [
          '-ExecutionPolicy', 'Bypass',
          '-Command',
          `Add-Type -AssemblyName presentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([Uri]'${filePath.replace(/'/g, "''")}'); $player.Play(); Start-Sleep -Milliseconds 500; while ($player.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }; $duration = $player.NaturalDuration.TimeSpan.TotalMilliseconds; Start-Sleep -Milliseconds $duration; $player.Close()`
        ];
      } else if (platform === 'darwin') {
        // macOS: use afplay
        command = 'afplay';
        args = [filePath];
      } else {
        // Linux: try paplay (PulseAudio) or aplay (ALSA)
        command = 'paplay';
        args = [filePath];
      }

      this.outputChannel.appendLine(`[TtsPlayer] Playing audio: ${filePath}`);
      this.isPlaying = true;

      this.currentProcess = spawn(command, args, {
        stdio: 'pipe',
        shell: false,
      });

      let stderr = '';
      this.currentProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      this.currentProcess.on('close', (code) => {
        this.currentProcess = null;
        this.isPlaying = false;
        if (code === 0) {
          this.outputChannel.appendLine(`[TtsPlayer] Playback completed`);
          resolve();
        } else {
          this.outputChannel.appendLine(`[TtsPlayer] Playback failed: ${stderr}`);
          // On Linux, if paplay fails, try aplay
          if (platform === 'linux' && command === 'paplay') {
            this.outputChannel.appendLine(`[TtsPlayer] paplay failed, trying aplay...`);
            this.isPlaying = true;
            this.currentProcess = spawn('aplay', [filePath]);
            this.currentProcess.on('close', (code2) => {
              this.currentProcess = null;
              this.isPlaying = false;
              code2 === 0 ? resolve() : reject(new Error(`Audio playback failed with code ${code2}`));
            });
            this.currentProcess.on('error', (err) => {
              this.isPlaying = false;
              reject(err);
            });
          } else {
            reject(new Error(`Audio playback failed with code ${code}: ${stderr}`));
          }
        }
      });

      this.currentProcess.on('error', (err) => {
        this.currentProcess = null;
        this.isPlaying = false;
        this.outputChannel.appendLine(`[TtsPlayer] Spawn error: ${err.message}`);
        reject(err);
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
