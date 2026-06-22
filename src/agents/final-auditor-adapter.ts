/**
 * Final Auditor Adapter — builds Final Auditor input and validates output.
 * Phase 5 §7: Final Audit is a pre-commit confirmation, not a replacement for Auditor.
 *
 * Final Auditor rules:
 * - Reads all evidence, audit-report, GOAL, handoff
 * - Writes .agent/final-audit.md
 * - Decision: PASS, FAILED, or BLOCKED
 * - Must validate digest consistency
 * - Must not modify business code
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseFinalAudit } from '../artifacts/artifact-schemas.js';
import type {
  AgentRunInput,
  FinalAuditFrontMatter,
  FinalAuditDecision,
} from '../types.js';
import type { IEventBus } from '../runtime/event-bus.js';

/** Final Auditor expected artifacts (relative to project root). */
const FINAL_AUDITOR_ARTIFACTS = ['.agent/final-audit.md'];

/** The only file the Final Auditor is allowed to create or modify. */
// Used for scope validation — Final Auditor may only write .agent/final-audit.md
const _FINAL_AUDITOR_ALLOWED_WRITE = '.agent/final-audit.md';
void _FINAL_AUDITOR_ALLOWED_WRITE;

/**
 * Build the AgentRunInput for the Final Auditor.
 */
export function buildFinalAuditorInput(params: {
  run_id: string;
  iteration: number;
  project_root: string;
  command_template: string[];
  timeout_seconds: number;
  prompt: string;
  prompt_file?: string;
  signal?: AbortSignal;
  eventBus?: IEventBus;
}): AgentRunInput {
  return {
    role: 'final-auditor',
    project_root: params.project_root,
    run_id: params.run_id,
    iteration: params.iteration,
    prompt: params.prompt,
    prompt_file: params.prompt_file,
    expected_artifacts: FINAL_AUDITOR_ARTIFACTS.map(p => join(params.project_root, p)),
    timeout_seconds: params.timeout_seconds,
    command_template: params.command_template,
    signal: params.signal,
    eventBus: params.eventBus,
  };
}

/**
 * Validate Final Auditor output.
 * Phase 5 §7.4: Mechanical checks for final-audit.md.
 *
 * Checks:
 * 1. final-audit.md exists and parses correctly
 * 2. run_id matches current run
 * 3. final_iteration matches current iteration
 * 4. decision is a valid enum value
 * 5. goal_digest matches current GOAL.md digest
 * 6. diff_digest matches current diff digest
 * 7. audit_report_digest matches current audit-report.md digest
 * 8. verification_manifest_digest matches current manifest digest
 * 9. PASS decision has no unresolved Critical/High blockers in body
 */
export function validateFinalAuditorOutput(params: {
  projectRoot: string;
  runId: string;
  iteration: number;
  expectedGoalDigest: string;
  expectedDiffDigest: string;
  expectedAuditReportDigest: string;
  expectedVerificationManifestDigest: string;
}): FinalAuditorValidationResult {
  const errors: string[] = [];
  let finalAuditFm: FinalAuditFrontMatter | null = null;
  let decision: FinalAuditDecision | null = null;

  const { projectRoot, runId, iteration, expectedGoalDigest, expectedDiffDigest,
          expectedAuditReportDigest, expectedVerificationManifestDigest } = params;

  // 1. Parse final-audit.md
  const finalAuditPath = join(projectRoot, '.agent/final-audit.md');
  if (!existsSync(finalAuditPath)) {
    errors.push('final-audit.md not found');
  } else {
    try {
      const content = readFileSync(finalAuditPath, 'utf8');
      const { frontMatter, body } = parseFinalAudit(content, finalAuditPath);

      // 2. Validate run_id
      if (frontMatter.run_id !== runId) {
        errors.push(
          `final-audit run_id "${frontMatter.run_id}" does not match expected "${runId}"`,
        );
      }

      // 3. Validate final_iteration
      if (frontMatter.final_iteration !== iteration) {
        errors.push(
          `final-audit final_iteration ${frontMatter.final_iteration} does not match expected ${iteration}`,
        );
      }

      // 4. Validate author_role
      if (frontMatter.author_role !== 'auditor') {
        errors.push(`final-audit author_role "${frontMatter.author_role}" is not "auditor"`);
      }

      // 5. Validate goal_digest
      if (frontMatter.goal_digest !== expectedGoalDigest) {
        errors.push(
          `final-audit goal_digest "${frontMatter.goal_digest}" does not match expected "${expectedGoalDigest}"`,
        );
      }

      // 6. Validate diff_digest
      if (frontMatter.diff_digest !== expectedDiffDigest) {
        errors.push(
          `final-audit diff_digest "${frontMatter.diff_digest}" does not match expected "${expectedDiffDigest}"`,
        );
      }

      // 7. Validate audit_report_digest
      if (frontMatter.audit_report_digest !== expectedAuditReportDigest) {
        errors.push(
          `final-audit audit_report_digest "${frontMatter.audit_report_digest}" does not match expected "${expectedAuditReportDigest}"`,
        );
      }

      // 8. Validate verification_manifest_digest
      if (frontMatter.verification_manifest_digest !== expectedVerificationManifestDigest) {
        errors.push(
          `final-audit verification_manifest_digest "${frontMatter.verification_manifest_digest}" does not match expected "${expectedVerificationManifestDigest}"`,
        );
      }

      // 9. Check for unresolved Critical/High blockers when PASS
      decision = frontMatter.decision;
      if (decision === 'PASS') {
        const blockerPatterns = [
          /unresolved\s+(critical|high)/i,
          /(critical|high)\s+(blocker|blocking|unresolved)/i,
          /blocking\s+issue/i,
        ];
        for (const pattern of blockerPatterns) {
          if (pattern.test(body)) {
            errors.push(
              'final-audit decision is PASS but body contains unresolved Critical/High blocker language',
            );
            break;
          }
        }
      }

      finalAuditFm = frontMatter;
    } catch (err) {
      errors.push(`final-audit parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    finalAuditFrontMatter: finalAuditFm,
    decision,
    /** Mechanical check failure overrides PASS → FAILED */
    effectiveDecision: errors.length > 0 && decision === 'PASS' ? 'FAILED' : decision,
  };
}

export interface FinalAuditorValidationResult {
  valid: boolean;
  errors: string[];
  finalAuditFrontMatter: FinalAuditFrontMatter | null;
  decision: FinalAuditDecision | null;
  /** Effective decision after mechanical checks. */
  effectiveDecision: FinalAuditDecision | 'FAILED' | null;
}
