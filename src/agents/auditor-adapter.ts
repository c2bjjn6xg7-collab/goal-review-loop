/**
 * Auditor Adapter — builds Auditor input and validates Auditor output.
 * Phase 3 §10.3: Auditor reads evidence only, must not trust Developer self-assessment.
 *
 * Auditor rules:
 * - Read-only access to all evidence
 * - Findings sorted by severity
 * - Must check each Success Criterion
 * - audited_goal_digest and audited_diff_digest must match orchestrator values
 * - Decision: PASS, FAIL, or BLOCKED
 * - Must not modify business code (only .agent/audit-report.md allowed)
 * - Mechanical check failure overrides Auditor PASS
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseAuditReport } from '../artifacts/artifact-schemas.js';
import { createHash } from 'node:crypto';
import type { AgentRunInput, AuditReportFrontMatter, AuditDecision } from '../types.js';
import type { Digest } from '../runtime/digest.js';
import type { IEventBus } from '../runtime/event-bus.js';

/** Auditor expected artifacts (relative to project root). */
const AUDITOR_ARTIFACTS = ['.agent/audit-report.md'];

/** The only file the Auditor is allowed to create or modify. */
const AUDITOR_ALLOWED_WRITE = '.agent/audit-report.md';

/**
 * Build the AgentRunInput for the Auditor.
 */
export function buildAuditorInput(params: {
  run_id: string;
  iteration: number;
  /** 1-indexed retry attempt; when >= 2 the adapter appends `-attempt${N}` to log filenames. */
  attempt?: number;
  project_root: string;
  command_template: string[];
  timeout_seconds: number;
  prompt: string;
  prompt_file?: string;
  signal?: AbortSignal;
  eventBus?: IEventBus;
}): AgentRunInput {
  return {
    role: 'auditor',
    project_root: params.project_root,
    run_id: params.run_id,
    iteration: params.iteration,
    attempt: params.attempt,
    prompt: params.prompt,
    prompt_file: params.prompt_file,
    expected_artifacts: AUDITOR_ARTIFACTS.map(p => join(params.project_root, p)),
    timeout_seconds: params.timeout_seconds,
    command_template: params.command_template,
    signal: params.signal,
    eventBus: params.eventBus,
  };
}

/**
 * Validate Auditor output.
 * Phase 3 §10.3 post-Auditor checks:
 * 1. Parse audit report
 * 2. Validate run_id and iteration
 * 3. Validate both digests match exactly
 * 4. Validate decision is PASS, FAIL, or BLOCKED
 * 5. Validate workspace immutability (only audit-report.md changed)
 * 6. Mechanical check failure overrides Auditor PASS
 */
export async function validateAuditorOutput(
  projectRoot: string,
  runId: string,
  iteration: number,
  expectedGoalDigest: string,
  expectedDiffDigest: string,
  preCallWorkspaceDigests: Map<string, Digest>,
): Promise<AuditorValidationResult> {
  const errors: string[] = [];
  let auditFm: AuditReportFrontMatter | null = null;
  let decision: AuditDecision | null = null;

  // 1. Parse audit report
  const auditPath = join(projectRoot, '.agent/audit-report.md');
  if (!existsSync(auditPath)) {
    errors.push('audit-report.md not found');
  } else {
    try {
      const auditContent = readFileSync(auditPath, 'utf8');
      const { frontMatter } = parseAuditReport(auditContent, auditPath);

      // 2. Validate run_id and iteration
      if (frontMatter.run_id !== runId) {
        errors.push(`audit report run_id "${frontMatter.run_id}" does not match expected "${runId}"`);
      }
      if (frontMatter.iteration !== iteration) {
        errors.push(`audit report iteration ${frontMatter.iteration} does not match expected ${iteration}`);
      }
      if (frontMatter.author_role !== 'auditor') {
        errors.push(`audit report author_role "${frontMatter.author_role}" is not "auditor"`);
      }

      // 3. Validate both digests match exactly
      if (frontMatter.audited_goal_digest !== expectedGoalDigest) {
        errors.push(
          `audit report audited_goal_digest "${frontMatter.audited_goal_digest}" does not match expected "${expectedGoalDigest}"`,
        );
      }
      if (frontMatter.audited_diff_digest !== expectedDiffDigest) {
        errors.push(
          `audit report audited_diff_digest "${frontMatter.audited_diff_digest}" does not match expected "${expectedDiffDigest}"`,
        );
      }

      // 4. Validate decision
      decision = frontMatter.decision;

      auditFm = frontMatter;
    } catch (err) {
      errors.push(`audit report parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. Validate workspace immutability
  // Check that files other than audit-report.md haven't changed
  // This covers: modified files, deleted files, AND new files
  // Exclude orchestrator-managed paths (.agent/debug/, .agent/evidence/,
  // .agent/verification/, .agent/history/) since the orchestrator writes these,
  // not the Auditor.
  const orchestratorManagedPrefixes = [
    join(projectRoot, '.agent', 'debug') + '/',
    join(projectRoot, '.agent', 'evidence') + '/',
    join(projectRoot, '.agent', 'verification') + '/',
    join(projectRoot, '.agent', 'history') + '/',
    join(projectRoot, '.agent', 'transcripts') + '/',
  ];

  const orchestratorManagedFiles = new Set([
    join(projectRoot, '.agent', 'progress.json'),
    join(projectRoot, '.agent', 'progress.md'),
    join(projectRoot, '.agent', 'events.jsonl'),
  ]);

  function isOrchestratorManaged(filePath: string): boolean {
    return orchestratorManagedFiles.has(filePath)
      || orchestratorManagedPrefixes.some(prefix => filePath.startsWith(prefix));
  }

  for (const [filePath, expectedDigest] of preCallWorkspaceDigests) {
    if (filePath === auditPath) continue; // audit-report.md is expected to change
    if (isOrchestratorManaged(filePath)) continue; // orchestrator-managed files
    if (existsSync(filePath)) {
      const currentDigest = computeDigest(readFileSync(filePath, 'utf8'));
      if (currentDigest !== expectedDigest) {
        errors.push(`Auditor modified non-audit file: ${filePath} (digest changed)`);
      }
    } else {
      // File existed before Auditor but was deleted during Auditor call
      errors.push(`Auditor deleted non-audit file: ${filePath}`);
    }
  }

  // F-303R1 fix: Check for new files created by the Auditor using multiple strategies.
  // 1. Untracked files (git ls-files --others)
  // 2. Staged files (git diff --cached --name-only) — catches `git add` bypass
  // 3. Full tracked file set comparison — catches any manipulation
  try {
    const { execFileSync } = await import('child_process');

    // Strategy 1: Untracked files
    const untrackedResult = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const untrackedFiles = untrackedResult.split('\0').filter(Boolean);
    for (const relPath of untrackedFiles) {
      const fullPath = join(projectRoot, relPath);
      if (isOrchestratorManaged(fullPath)) continue;
      if (!preCallWorkspaceDigests.has(fullPath) && relPath !== AUDITOR_ALLOWED_WRITE) {
        errors.push(`Auditor created new file: ${relPath}`);
      }
    }

    // Strategy 2: Staged files (catches `git add` on new files)
    const stagedResult = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stagedFiles = stagedResult.split('\0').filter(Boolean);
    for (const relPath of stagedFiles) {
      const fullPath = join(projectRoot, relPath);
      if (isOrchestratorManaged(fullPath)) continue;
      if (!preCallWorkspaceDigests.has(fullPath) && relPath !== AUDITOR_ALLOWED_WRITE) {
        errors.push(`Auditor staged new file: ${relPath}`);
      }
    }

    // Strategy 3: Full tracked file set comparison
    // Get current tracked files and compare against pre-call snapshot
    const currentTrackedResult = execFileSync('git', ['ls-files', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const currentTrackedFiles = new Set(currentTrackedResult.split('\0').filter(Boolean));
    // Pre-call tracked files are those in preCallWorkspaceDigests that were tracked
    // (we know they were tracked because they came from git ls-files)
    for (const relPath of currentTrackedFiles) {
      const fullPath = join(projectRoot, relPath);
      if (isOrchestratorManaged(fullPath)) continue;
      if (!preCallWorkspaceDigests.has(fullPath) && relPath !== AUDITOR_ALLOWED_WRITE) {
        // This file is tracked now but wasn't in the pre-call snapshot
        // (could have been created and staged/committed)
        errors.push(`Auditor introduced new tracked file: ${relPath}`);
      }
    }
  } catch {
    // Git not available — rely on preCallWorkspaceDigests completeness
  }

  return {
    valid: errors.length === 0,
    errors,
    auditFrontMatter: auditFm,
    decision,
    /** Mechanical check failure overrides PASS — caller must check this. */
    effectiveDecision: errors.length > 0 && decision === 'PASS' ? 'FAIL' : decision,
  };
}

function computeDigest(content: string): Digest {
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  return `sha256:${hash}` as Digest;
}

export interface AuditorValidationResult {
  valid: boolean;
  errors: string[];
  auditFrontMatter: AuditReportFrontMatter | null;
  decision: AuditDecision | null;
  /** Effective decision after mechanical checks. If mechanical checks fail and Auditor said PASS, this becomes FAIL. */
  effectiveDecision: AuditDecision | 'FAIL' | null;
}
