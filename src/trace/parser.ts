import * as fs from 'fs';
import * as path from 'path';
import { traceEventSchema, sessionMetadataSchema } from './types';
import type { TraceEvent, ReplaySession, SessionMetadata } from './types';

export interface ParseResult {
  session: ReplaySession;
  warnings: string[];
}

/**
 * Parse a trace.jsonl file into a ReplaySession.
 *
 * Each line is parsed independently. Malformed lines are skipped with a
 * warning rather than failing the whole parse.
 */
export async function parseTraceFile(filePath: string): Promise<ParseResult> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);

  const events: TraceEvent[] = [];
  const warnings: string[] = [];
  let inlineMetadata: SessionMetadata | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i].trim();

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`Line ${lineNum}: invalid JSON — skipped`);
      continue;
    }

    // Check for inline metadata header (a line with session metadata but no event type)
    const metaResult = sessionMetadataSchema.safeParse(parsed);
    if (
      metaResult.success &&
      (metaResult.data.commitSha || metaResult.data.sourceKind || metaResult.data.snapshotsDir) &&
      !traceEventSchema.safeParse(parsed).success
    ) {
      inlineMetadata = metaResult.data;
      continue;
    }

    // Validate against schema
    const result = traceEventSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      warnings.push(`Line ${lineNum}: validation failed (${issues}) — skipped`);
      continue;
    }

    events.push(result.data);
  }

  // Try to load metadata.json alongside the trace (inline metadata takes priority)
  const dir = path.dirname(filePath);
  const fileMetadata = await loadMetadata(path.join(dir, 'metadata.json'));
  const metadata = inlineMetadata ?? fileMetadata;
  const summary = await loadSummary(path.join(dir, 'summary.md'));

  return {
    session: { events, metadata, summary },
    warnings,
  };
}

async function loadMetadata(
  filePath: string
): Promise<SessionMetadata | undefined> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = sessionMetadataSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

async function loadSummary(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
