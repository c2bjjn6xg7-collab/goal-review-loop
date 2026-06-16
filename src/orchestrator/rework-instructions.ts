/**
 * Rework Instructions — Phase 4 §7
 * Builds, writes, and parses `.agent/rework-instructions.md`.
 * This file is orchestrator-owned; Developer must not modify it.
 */

import { join } from 'node:path';
import { serializeFrontMatter } from '../artifacts/front-matter.js';
import { atomicWriteFile } from '../runtime/atomic-file.js';
import { parseFrontMatter, validateRequiredFields, validateEnumField } from '../artifacts/front-matter.js';
import type {
  ReworkInstructionsFrontMatter,
  ReworkFinding,
  ScopeReportV2,
  VerificationManifest,
} from '../types.js';

// ─── Types ──────────────────────────────────────────────────

export interface ReworkInstructionsResult {
  valid: boolean;
  frontMatter: ReworkInstructionsFrontMatter | null;
  errors: string[];
}

export interface BuildReworkInstructionsParams {
  run_id: string;
  iteration: number;
  source: ReworkInstructionsFrontMatter['source'];
  findings: ReworkFinding[];
  goal_path: string;
  evidence_paths: string[];
  verification_commands: string[];
  project_root: string;
}

// ─── Build ──────────────────────────────────────────────────

/**
 * Build the full content of `.agent/rework-instructions.md`.
 */
export function buildReworkInstructions(params: BuildReworkInstructionsParams): string {
  const frontMatter: ReworkInstructionsFrontMatter = {
    schema_version: 1,
    run_id: params.run_id,
    iteration: params.iteration,
    author_role: 'orchestrator',
    source: params.source,
    status: 'REWORK_REQUIRED',
  };

  const findingsSection = params.findings.length > 0
    ? params.findings.map(f => {
        let entry = `- id: "${f.id}"\n`;
        entry += `  severity: ${f.severity}\n`;
        entry += `  source: ${f.source}\n`;
        entry += `  path: "${f.path}"\n`;
        entry += `  evidence: "${f.evidence}"\n`;
        entry += `  required_fix: "${f.required_fix}"\n`;
        if (f.command_id) entry += `  command_id: "${f.command_id}"\n`;
        if (f.argv) entry += `  argv: ${JSON.stringify(f.argv)}\n`;
        if (f.exit_code !== undefined) entry += `  exit_code: ${f.exit_code}\n`;
        if (f.stdout_path) entry += `  stdout_path: "${f.stdout_path}"\n`;
        if (f.stderr_path) entry += `  stderr_path: "${f.stderr_path}"\n`;
        if (f.timed_out !== undefined) entry += `  timed_out: ${f.timed_out}\n`;
        if (f.denial_reason) entry += `  denial_reason: "${f.denial_reason}"\n`;
        if (f.scope_report_path) entry += `  scope_report_path: "${f.scope_report_path}"\n`;
        return entry;
      }).join('\n')
    : '- (none)';

  const evidenceList = params.evidence_paths.length > 0
    ? params.evidence_paths.map(p => `- ${p}`).join('\n')
    : '- (none)';

  const verificationList = params.verification_commands.length > 0
    ? params.verification_commands.map(c => `- ${c}`).join('\n')
    : '- (none)';

  const body = `# Rework Instructions

## Rework Goal

Fix the issues listed below. Do NOT expand the task scope beyond these findings.

## Failure Source

${params.source}

## Findings

${findingsSection}

## Evidence Paths

${evidenceList}

## Verification Commands to Re-run

All required verification commands must be re-executed:

${verificationList}

## Prohibitions

1. Do NOT modify \`.agent/GOAL.md\`, \`.agent/state.json\`, \`.agent/plan.md\`, \`.agent/audit-report.md\`, or \`.agent/rework-instructions.md\`.
2. Do NOT expand allowed_changes beyond what GOAL.md specifies.
3. Do NOT execute git commit, tag, push, or destructive Git commands.
4. Do NOT delete, skip, or weaken tests.
5. Do NOT modify files outside the scope of these findings.

## Scope

Only fix the issues listed in Findings above, and any tests necessary to validate the fixes.
The original GOAL remains unchanged.
`;

  return serializeFrontMatter(frontMatter, body);
}

/**
 * Write `.agent/rework-instructions.md` atomically.
 */
export async function writeReworkInstructions(projectRoot: string, content: string): Promise<void> {
  const filePath = join(projectRoot, '.agent', 'rework-instructions.md');
  await atomicWriteFile(filePath, content);
}

/**
 * Parse and validate `.agent/rework-instructions.md`.
 */
export function parseReworkInstructions(content: string, filePath?: string): ReworkInstructionsResult {
  const errors: string[] = [];

  let parsed: ReturnType<typeof parseFrontMatter<Record<string, unknown>>>;
  try {
    parsed = parseFrontMatter<Record<string, unknown>>(content, filePath);
  } catch (err) {
    return {
      valid: false,
      frontMatter: null,
      errors: [`Failed to parse rework-instructions.md: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const fm = parsed.frontMatter;

  try {
    validateRequiredFields(fm, ['schema_version', 'run_id', 'iteration', 'author_role', 'source', 'status'], filePath);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    validateEnumField(fm, 'author_role', ['orchestrator'], filePath);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    validateEnumField(fm, 'source', ['scope', 'verification', 'audit', 'artifact'], filePath);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    validateEnumField(fm, 'status', ['REWORK_REQUIRED'], filePath);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (typeof fm.iteration === 'number' && fm.iteration < 2) {
    errors.push('rework-instructions.md iteration must be >= 2');
  }

  return {
    valid: errors.length === 0,
    frontMatter: errors.length === 0 ? fm as unknown as ReworkInstructionsFrontMatter : null,
    errors,
  };
}

// ─── Finding Builders ───────────────────────────────────────

let findingCounter = 0;

function nextFindingId(prefix: string): string {
  findingCounter++;
  return `${prefix}-${String(findingCounter).padStart(3, '0')}`;
}

/**
 * Reset the finding counter (for testing).
 */
export function resetFindingCounter(): void {
  findingCounter = 0;
}

/**
 * Convert scope guard denials to rework findings.
 */
export function buildReworkFindingsFromScope(
  scopeReport: ScopeReportV2,
  iteration: number,
  projectRoot: string,
): ReworkFinding[] {
  void projectRoot; // kept for API consistency — may be used in future features
  resetFindingCounter();
  const scopeReportPath = `.agent/evidence/iteration-${String(iteration).padStart(2, '0')}/scope-report.json`;

  return scopeReport.denied.map(d => ({
    id: nextFindingId('R'),
    severity: 'high' as const,
    source: 'scope' as const,
    path: d.path,
    evidence: `Denied by scope guard: ${d.reason}`,
    required_fix: `Remove or revert the change to "${d.path}" that is outside allowed_changes, or adjust the change to comply with GOAL.md allowed_changes.`,
    denial_reason: d.reason,
    scope_report_path: scopeReportPath,
  }));
}

/**
 * Convert verification failures to rework findings.
 */
export function buildReworkFindingsFromVerification(
  manifest: VerificationManifest,
  iteration: number,
): ReworkFinding[] {
  void iteration; // kept for API consistency — may be used in future features
  resetFindingCounter();
  const failedCommands = manifest.commands.filter(c => c.required && c.status !== 'success');

  return failedCommands.map(c => ({
    id: nextFindingId('R'),
    severity: 'critical' as const,
    source: 'verification' as const,
    path: c.argv.join(' '),
    evidence: `Verification command "${c.id}" failed with exit code ${c.exit_code ?? 'unknown'}${c.timed_out ? ' (timed out)' : ''}`,
    required_fix: `Fix the code so that verification command "${c.id}" (${c.argv.join(' ')}) passes. Check the stdout and stderr logs for details.`,
    command_id: c.id,
    argv: c.argv,
    exit_code: c.exit_code,
    stdout_path: c.stdout_path,
    stderr_path: c.stderr_path,
    timed_out: c.timed_out,
  }));
}

/**
 * Extract findings from audit-report.md body.
 * Parses the Findings section and converts each to a ReworkFinding.
 */
export function buildReworkFindingsFromAudit(
  auditReportContent: string,
  iteration: number,
): ReworkFinding[] {
  void iteration; // kept for API consistency — may be used in future features
  resetFindingCounter();
  const findings: ReworkFinding[] = [];

  // Extract findings from the audit report body
  // Pattern: ### F-001 - High - ... or ### F-NNN - Severity - Title
  const findingPattern = /###\s+(F-\d+(?:R\d+)?)\s*-\s*(Critical|High|Medium|Low)\s*-\s*(.+?)(?:\n|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = findingPattern.exec(auditReportContent)) !== null) {
    const findingId = match[1];
    const severity = match[2].toLowerCase() as ReworkFinding['severity'];
    const title = match[3].trim();

    // Try to extract evidence, impact, and required fix from the finding body
    const findingSection = extractFindingSection(auditReportContent, findingId);

    const evidenceMatch = findingSection.match(/(?:Evidence|File|Location):\s*`?([^`\n]+)`?/i);
    const fixMatch = findingSection.match(/(?:Required\s+fix|Fix|Rework):\s*(.+?)(?:\n(?:\||#)|$)/is);

    findings.push({
      id: nextFindingId('R'),
      severity,
      source: 'audit',
      path: evidenceMatch ? evidenceMatch[1].trim() : '(see audit report)',
      evidence: `Audit finding ${findingId}: ${title}`,
      required_fix: fixMatch ? fixMatch[1].trim() : `Fix the issue described in audit finding ${findingId}: ${title}`,
    });
  }

  // If no structured findings found, create a generic one
  if (findings.length === 0) {
    findings.push({
      id: nextFindingId('R'),
      severity: 'high',
      source: 'audit',
      path: '(see audit report)',
      evidence: 'Auditor returned FAIL. See .agent/audit-report.md for details.',
      required_fix: 'Read .agent/audit-report.md and fix all identified issues.',
    });
  }

  return findings;
}

/**
 * Extract the text of a specific finding section from the audit report.
 */
function extractFindingSection(content: string, findingId: string): string {
  // Find the section starting with ### findingId and ending at the next ### or ##
  const startPattern = new RegExp(`###\\s+${escapeRegExp(findingId)}\\b`, 'i');
  const startMatch = startPattern.exec(content);
  if (!startMatch) return '';

  const startIndex = startMatch.index + startMatch[0].length;
  const nextSection = content.indexOf('\n### ', startIndex);
  const nextH2 = content.indexOf('\n## ', startIndex);
  let endIndex = content.length;
  if (nextSection !== -1) endIndex = Math.min(endIndex, nextSection);
  if (nextH2 !== -1) endIndex = Math.min(endIndex, nextH2);

  return content.slice(startIndex, endIndex);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
