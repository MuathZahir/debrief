import type { TraceEvent } from '../trace/types';

// ── Risk categories ─────────────────────────────────────────────────────────

export type RiskCategory =
  | 'security'
  | 'migration'
  | 'publicApi'
  | 'deletedTests'
  | 'largeChange'
  | 'newDependency';

export interface RiskFlag {
  category: RiskCategory;
  label: string;
  icon: string; // VS Code codicon name
}

// ── Detection patterns ──────────────────────────────────────────────────────

const SECURITY_PATTERNS = /auth|crypto|password|secret|token|jwt|oauth|permission|rbac|credential|encrypt|decrypt|hash|salt|session|cookie|csrf|xss|sanitiz/i;

const MIGRATION_PATTERNS = /migration|migrate|schema|seed|alembic|knex|prisma\/migrations|flyway|liquibase|typeorm.*migration|sequelize.*migration/i;

const PUBLIC_API_PATTERNS = /api\/|routes\/|endpoints\/|controllers\/|handlers\/|\.api\./i;
const PUBLIC_API_NARRATION_PATTERNS = /\bexport\b|\bpublic api\b|\bbreaking change\b|\bapi change\b/i;

const TEST_FILE_PATTERNS = /\.test\.|\.spec\.|__tests__|test\/|tests\/|spec\//i;
const DELETED_TEST_NARRATION_PATTERNS = /removed? test|deleted? test|remove.*test|delete.*test/i;

const DEPENDENCY_FILES = /package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile|Pipfile\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|pyproject\.toml|poetry\.lock|composer\.json|composer\.lock/;

// ── Detection function ──────────────────────────────────────────────────────

/**
 * Detects potential risks in a trace event based on file paths, narration, and metadata.
 * This is a pure function with no side effects.
 */
export function detectRisks(event: TraceEvent): RiskFlag[] {
  const risks: RiskFlag[] = [];
  const filePath = event.filePath || '';
  const narration = event.narration || '';
  const metadata = event.metadata || {};

  // Security-sensitive files
  if (SECURITY_PATTERNS.test(filePath)) {
    risks.push({
      category: 'security',
      label: 'Security-sensitive',
      icon: 'shield',
    });
  }

  // Database migrations
  if (MIGRATION_PATTERNS.test(filePath)) {
    risks.push({
      category: 'migration',
      label: 'Database migration',
      icon: 'database',
    });
  }

  // Public API changes
  if (PUBLIC_API_PATTERNS.test(filePath) || PUBLIC_API_NARRATION_PATTERNS.test(narration)) {
    risks.push({
      category: 'publicApi',
      label: 'Public API change',
      icon: 'globe',
    });
  }

  // Deleted tests
  if (TEST_FILE_PATTERNS.test(filePath) && DELETED_TEST_NARRATION_PATTERNS.test(narration)) {
    risks.push({
      category: 'deletedTests',
      label: 'Deleted tests',
      icon: 'warning',
    });
  }

  // Large changes (metadata.lineCount > 100)
  const lineCount = typeof metadata.lineCount === 'number' ? metadata.lineCount : 0;
  if (lineCount > 100) {
    risks.push({
      category: 'largeChange',
      label: 'Large change',
      icon: 'expand-all',
    });
  }

  // New dependencies
  if (DEPENDENCY_FILES.test(filePath)) {
    risks.push({
      category: 'newDependency',
      label: 'Dependency change',
      icon: 'package',
    });
  }

  return risks;
}

// ── Utility functions ───────────────────────────────────────────────────────

/**
 * Returns the highest-priority risk from an array, or null if empty.
 * Priority order: security > migration > deletedTests > publicApi > newDependency > largeChange
 */
export function getPrimaryRisk(risks: RiskFlag[]): RiskFlag | null {
  if (risks.length === 0) return null;

  const priorityOrder: RiskCategory[] = [
    'security',
    'migration',
    'deletedTests',
    'publicApi',
    'newDependency',
    'largeChange',
  ];

  for (const category of priorityOrder) {
    const risk = risks.find((r) => r.category === category);
    if (risk) return risk;
  }

  return risks[0];
}

/**
 * Returns a color for a risk category (used in UI).
 */
export function getRiskColor(category: RiskCategory): string {
  switch (category) {
    case 'security':
      return '#f85149'; // Red
    case 'migration':
      return '#a371f7'; // Purple
    case 'deletedTests':
      return '#d29922'; // Yellow/orange
    case 'publicApi':
      return '#58a6ff'; // Blue
    case 'newDependency':
      return '#7ee787'; // Green
    case 'largeChange':
      return '#8b949e'; // Gray
    default:
      return '#8b949e';
  }
}
