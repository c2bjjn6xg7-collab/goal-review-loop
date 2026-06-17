import path from 'path';
import micromatch from 'micromatch';
import { atomicWriteJSON } from '../runtime/atomic-file.js';
import { validateScopeReport } from '../artifacts/json-schemas.js';
import type { ChangedFilesSchema, ScopeReportV2, ScopeWarning, ScopeDenialReason } from '../types.js';

const SYSTEM_PROTECTED_PATHS = [
  '.git/**',
  '.agent/state.json',
  '.agent/plan.md',
  '.agent/GOAL.md',
  '.agent/task-graph.json',
  '.agent/audit-report.md',
  '.agent/final-audit.md',
  '.agent/run.lock',
  '.agent/iteration-log.md',
  '.agent/rework-instructions.md',
  '.agent/progress.json',
  '.agent/progress.md',
  '.agent/transcripts/**',
  '.agent/evidence/**',
  '.agent/verification/**',
  '.agent/history/**',
  '.agent/debug/**',
];

const DEVELOPER_HANDOFF_EXCEPTION = '.agent/developer-handoff.md';

const ORCHESTRATOR_OWNED_PATTERNS = [
  '.agent/plan.md',
  '.agent/GOAL.md',
  '.agent/task-graph.json',
  '.agent/state.json',
  '.agent/run.lock',
  '.agent/audit-report.md',
  '.agent/final-audit.md',
  '.agent/rework-instructions.md',
  '.agent/progress.json',
  '.agent/progress.md',
  '.agent/transcripts/**',
  '.agent/evidence/**',
  '.agent/verification/**',
  '.agent/history/**',
  '.agent/debug/**',
  '.agent/iteration-log.md',
];

// F-315R1: Only UNTRACKED dependency cache files are excluded.
// Tracked files (e.g. committed .pnp.cjs, .yarn/plugins/) must still
// pass allowed_changes — they are project source, not transient cache.
const DEPENDENCY_CACHE_PATTERNS = [
  'node_modules/**',
  '.pnpm-store/**',
  '.yarn/cache/**',
  '.yarn/unplugged/**',
  '.yarn/install-state.gz',
];

const TEST_FILE_PATTERNS = [
  '**/*.test.ts',
  '**/*.test.js',
  '**/*.spec.ts',
  '**/*.spec.js',
  '**/__tests__/**',
  '**/tests/**',
];

const SUSPICIOUS_TEST_MARKERS = [
  /\.skip\(/g,
  /\.only\(/g,
  /\bxit\(/g,
  /\bxdescribe\(/g,
];

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function matchesPattern(filePath: string, patterns: string[]): boolean {
  return micromatch.isMatch(filePath, patterns, { dot: true });
}

export interface ScopeGuardInput {
  allowedChanges: string[];
  disallowedChanges: string[];
  changedFiles: ChangedFilesSchema;
  orchestratorOwnedFiles?: string[];
  fileContents?: Map<string, string>;
}

export interface ScopeGuardResult {
  report: ScopeReportV2;
  passed: boolean;
}

export function checkScope(input: ScopeGuardInput): ScopeGuardResult {
  const { allowedChanges, disallowedChanges, changedFiles, orchestratorOwnedFiles = [], fileContents } = input;
  const allowed: string[] = [];
  const excludedOrchestratorOwned: string[] = [];
  const excludedDependencyCache: string[] = [];
  const denied: Array<{ path: string; reason: ScopeDenialReason }> = [];
  const warnings: ScopeWarning[] = [];

  for (const file of changedFiles.files) {
    const filePath = toPosixPath(file.path);

    if (filePath === DEVELOPER_HANDOFF_EXCEPTION) {
      allowed.push(filePath);
      continue;
    }

    if (matchesPattern(filePath, SYSTEM_PROTECTED_PATHS)) {
      if (matchesPattern(filePath, ORCHESTRATOR_OWNED_PATTERNS)) {
        const isOrchestratorOwned = orchestratorOwnedFiles.some(
          (owned) => toPosixPath(owned) === filePath,
        );
        if (isOrchestratorOwned) {
          excludedOrchestratorOwned.push(filePath);
          continue;
        }
      }

      denied.push({ path: filePath, reason: 'system_protected' });
      continue;
    }

    if (matchesPattern(filePath, disallowedChanges)) {
      denied.push({ path: filePath, reason: 'disallowed_change' });
      continue;
    }

    // F-315R1: Exclude UNTRACKED dependency cache files only.
    // Tracked files (committed .pnp.cjs, .yarn/plugins/, etc.) must still
    // pass allowed_changes — they are project source, not transient cache.
    if (file.status === 'untracked' && file.tracked === false && matchesPattern(filePath, DEPENDENCY_CACHE_PATTERNS)) {
      excludedDependencyCache.push(filePath);
      continue;
    }

    if (file.status === 'deleted' && matchesPattern(filePath, TEST_FILE_PATTERNS)) {
      if (!matchesPattern(filePath, allowedChanges)) {
        denied.push({ path: filePath, reason: 'unauthorized_test_deletion' });
        continue;
      }
    }

    if (matchesPattern(filePath, allowedChanges)) {
      allowed.push(filePath);
      continue;
    }

    denied.push({ path: filePath, reason: 'outside_allowed_changes' });
  }

  const testWarnings = checkTestProtection(changedFiles);
  warnings.push(...testWarnings);

  if (fileContents) {
    for (const [filePath, content] of fileContents) {
      const posixPath = toPosixPath(filePath);
      if (matchesPattern(posixPath, TEST_FILE_PATTERNS)) {
        const markerWarnings = checkSuspiciousTestMarkers(content, posixPath);
        warnings.push(...markerWarnings);
      }
      if (posixPath === 'package.json') {
        const configWarnings = checkTestConfigDisabled(content, posixPath);
        warnings.push(...configWarnings);
      }
    }
  }

  const hasUnauthorizedTestDeletion = checkUnauthorizedTestDeletion(changedFiles, allowedChanges);
  if (hasUnauthorizedTestDeletion) {
    for (const file of changedFiles.files) {
      const filePath = toPosixPath(file.path);
      if (file.status === 'deleted' && matchesPattern(filePath, TEST_FILE_PATTERNS)) {
        if (!matchesPattern(filePath, allowedChanges)) {
          const alreadyDenied = denied.some((d) => d.path === filePath);
          if (!alreadyDenied) {
            denied.push({ path: filePath, reason: 'unauthorized_test_deletion' });
          }
        }
      }
    }
  }

  const passed = denied.length === 0;

  const report: ScopeReportV2 = {
    schema_version: 2,
    passed,
    allowed: allowed.sort(),
    excluded_orchestrator_owned: excludedOrchestratorOwned.sort(),
    excluded_dependency_cache: excludedDependencyCache.sort(),
    denied: denied.sort((a, b) => a.path.localeCompare(b.path)),
    warnings: warnings.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '')),
  };

  return { report, passed };
}

function checkTestProtection(changedFiles: ChangedFilesSchema): ScopeWarning[] {
  const warnings: ScopeWarning[] = [];

  for (const file of changedFiles.files) {
    const filePath = toPosixPath(file.path);

    if (file.status === 'deleted' && matchesPattern(filePath, TEST_FILE_PATTERNS)) {
      warnings.push({
        code: 'TEST_FILE_DELETED',
        message: `Test file deleted: ${filePath}`,
        path: filePath,
      });
    }
  }

  return warnings;
}

function checkUnauthorizedTestDeletion(
  changedFiles: ChangedFilesSchema,
  allowedChanges: string[],
): boolean {
  for (const file of changedFiles.files) {
    if (file.status !== 'deleted') continue;
    const filePath = toPosixPath(file.path);
    if (!matchesPattern(filePath, TEST_FILE_PATTERNS)) continue;
    if (matchesPattern(filePath, allowedChanges)) continue;
    return true;
  }
  return false;
}

export function checkSuspiciousTestMarkers(content: string, filePath: string): ScopeWarning[] {
  const warnings: ScopeWarning[] = [];

  for (const pattern of SUSPICIOUS_TEST_MARKERS) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      warnings.push({
        code: 'SUSPICIOUS_TEST_MARKER',
        message: `Suspicious test marker found: ${matches[0]} (${matches.length} occurrences)`,
        path: filePath,
      });
    }
  }

  return warnings;
}

export function checkTestConfigDisabled(content: string, filePath: string): ScopeWarning[] {
  const warnings: ScopeWarning[] = [];

  if (filePath.endsWith('package.json')) {
    try {
      const pkg = JSON.parse(content);
      if (pkg.scripts) {
        const testScript = pkg.scripts.test;
        if (testScript === 'true' || testScript === 'echo "no tests"' || testScript === ':') {
          warnings.push({
            code: 'TEST_SCRIPT_DISABLED',
            message: 'Test script appears to be disabled or no-op',
            path: filePath,
          });
        }
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  return warnings;
}

export async function writeScopeReport(
  projectRoot: string,
  iteration: number,
  report: ScopeReportV2,
): Promise<void> {
  if (!validateScopeReport(report)) {
    throw new Error(`Invalid scope-report.json: ${JSON.stringify(validateScopeReport.errors)}`);
  }
  const evidenceDir = path.join(projectRoot, '.agent', 'evidence', `iteration-${String(iteration).padStart(2, '0')}`);
  const reportPath = path.join(evidenceDir, 'scope-report.json');
  await atomicWriteJSON(reportPath, report);
}
