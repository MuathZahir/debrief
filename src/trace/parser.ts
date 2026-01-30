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

  // Try to load metadata.json alongside the trace
  const dir = path.dirname(filePath);
  const metadata = await loadMetadata(path.join(dir, 'metadata.json'));
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
