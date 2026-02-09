import { z } from 'zod';

// ── Range ──────────────────────────────────────────────────────────────────

export interface TraceRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export const traceRangeSchema = z.object({
  startLine: z.number().int().min(1),
  startCol: z.number().int().min(0),
  endLine: z.number().int().min(1),
  endCol: z.number().int().min(0),
});

// ── Diff reference ─────────────────────────────────────────────────────────

export interface DiffRef {
  left: string;  // "git:HEAD~1:path" | "workspace:path" | "snapshot:id"
  right: string;
}

export const diffRefSchema = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
});

// ── Event types ────────────────────────────────────────────────────────────

export const TRACE_EVENT_TYPES = [
  'openFile',
  'showDiff',
  'highlightRange',
  'say',
  'sectionStart',
  'sectionEnd',
] as const;

export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

// ── Trace event ────────────────────────────────────────────────────────────

// ── Agent-specified risks (replaces auto-detection) ────────────────────────

export interface AgentRisk {
  category: string;  // e.g., "security", "breaking-change", "performance"
  label: string;     // Human-readable description
}

export interface TraceEvent {
  id: string;
  type: TraceEventType;
  title: string;
  narration: string;
  filePath?: string;
  range?: TraceRange;
  metadata?: Record<string, unknown>;
  comment?: string;       // User feedback comment
  risks?: AgentRisk[];    // Agent-specified risks
}

export const agentRiskSchema = z.object({
  category: z.string(),
  label: z.string(),
});

export const traceEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(TRACE_EVENT_TYPES),
  title: z.string(),  // Allow empty for sectionEnd events
  narration: z.string(),
  filePath: z.string().optional(),
  range: traceRangeSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  comment: z.string().optional(),
  risks: z.array(agentRiskSchema).optional(),
});

// ── Session ────────────────────────────────────────────────────────────────

export type TraceProfile = 'documentation' | 'personal';
export type TraceSourceKind = 'git' | 'snapshot';

export interface SessionMetadata {
  agent?: string;
  timestamp?: string;
  duration?: number;
  filesChanged?: string[];
  commitSha?: string;
  profile?: TraceProfile;
  sourceKind?: TraceSourceKind;
  snapshotsDir?: string;
}

export const sessionMetadataSchema = z.object({
  agent: z.string().optional(),
  timestamp: z.string().optional(),
  duration: z.number().optional(),
  filesChanged: z.array(z.string()).optional(),
  commitSha: z.string().optional(),
  profile: z.enum(['documentation', 'personal']).optional(),
  sourceKind: z.enum(['git', 'snapshot']).optional(),
  snapshotsDir: z.string().optional(),
});

export interface ReplaySession {
  events: TraceEvent[];
  metadata?: SessionMetadata;
  summary?: string;
  tracePath?: string;  // Path to source JSONL file for persistence
}

// ── Step state (used by engine) ────────────────────────────────────────────

export interface StepChangedEvent {
  index: number;
  event: TraceEvent;
  total: number;
}

// ── Playback state ────────────────────────────────────────────────────────

export type PlayState = 'stopped' | 'playing' | 'paused';

export interface PlayStateChangedEvent {
  playState: PlayState;
}

// ── Follow mode ───────────────────────────────────────────────────────────

export interface FollowModeChangedEvent {
  enabled: boolean;
}

