/**
 * Developer Adapter — builds Developer input and validates Developer output.
 * Phase 3 §10.2: Developer executes first-round development and generates handoff.
 *
 * Developer rules:
 * - Must read plan.md and GOAL.md
 * - Only modify allowed_changes files and .agent/developer-handoff.md
 * - Must not modify Planner/state/audit files
 * - Must not commit, tag, push
 * - Must not delete/skip/weaken tests
 * - Must generate .agent/developer-handoff.md
 * - BLOCKED handoff → run enters BLOCKED immediately
 * - COMPLETED handoff → proceed to VERIFYING
 * - Do not trust Developer's claimed test results
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseHandoff } from '../artifacts/artifact-schemas.js';
import { computeDigest, type Digest } from '../runtime/digest.js';
import type { AgentRunInput, HandoffFrontMatter, HandoffStatus } from '../types.js';
import type { IEventBus } from '../runtime/event-bus.js';

/** Developer expected artifacts (relative to project root). */
const DEVELOPER_ARTIFACTS = ['.agent/developer-handoff.md'];

/**
 * Build the AgentRunInput for the Developer.
 */
export function buildDeveloperInput(params: {
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
    role: 'developer',
    project_root: params.project_root,
    run_id: params.run_id,
    iteration: params.iteration,
    attempt: params.attempt,
    prompt: params.prompt,
    prompt_file: params.prompt_file,
    expected_artifacts: DEVELOPER_ARTIFACTS.map(p => join(params.project_root, p)),
    timeout_seconds: params.timeout_seconds,
    command_template: params.command_template,
    signal: params.signal,
    eventBus: params.eventBus,
  };
}

/**
 * Validate Developer output.
 * Phase 3 §10.2 post-Developer checks:
 * 1. Parse handoff
 * 2. Validate run_id, iteration, status
 * 3. BLOCKED handoff → immediate BLOCKED
 * 4. COMPLETED handoff → proceed
 * 5. Validate plan/GOAL digest unchanged
 * 6. Do not trust claimed test results
 */
export function validateDeveloperOutput(
  projectRoot: string,
  runId: string,
  iteration: number,
  preCallPlanDigest: Digest | null,
  preCallGoalDigest: Digest | null,
): DeveloperValidationResult {
  const errors: string[] = [];
  let handoffFm: HandoffFrontMatter | null = null;
  let handoffStatus: HandoffStatus | null = null;

  // 1. Parse handoff
  const handoffPath = join(projectRoot, '.agent/developer-handoff.md');
  if (!existsSync(handoffPath)) {
    errors.push('developer-handoff.md not found');
  } else {
    try {
      const handoffContent = readFileSync(handoffPath, 'utf8');
      const { frontMatter } = parseHandoff(handoffContent, handoffPath);

      // 2. Validate run_id and iteration
      if (frontMatter.run_id !== runId) {
        errors.push(`handoff run_id "${frontMatter.run_id}" does not match expected "${runId}"`);
      }
      if (frontMatter.iteration !== iteration) {
        errors.push(`handoff iteration ${frontMatter.iteration} does not match expected ${iteration}`);
      }
      if (frontMatter.author_role !== 'developer') {
        errors.push(`handoff author_role "${frontMatter.author_role}" is not "developer"`);
      }

      handoffFm = frontMatter;
      handoffStatus = frontMatter.status;
    } catch (err) {
      errors.push(`handoff parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. Validate plan/GOAL digest unchanged
  if (preCallPlanDigest) {
    const planPath = join(projectRoot, '.agent/plan.md');
    if (existsSync(planPath)) {
      const currentDigest = computeDigest(readFileSync(planPath, 'utf8'));
      if (currentDigest !== preCallPlanDigest) {
        errors.push(`plan.md was modified by Developer (digest changed from ${preCallPlanDigest} to ${currentDigest})`);
      }
    }
  }

  if (preCallGoalDigest) {
    const goalPath = join(projectRoot, '.agent/GOAL.md');
    if (existsSync(goalPath)) {
      const currentDigest = computeDigest(readFileSync(goalPath, 'utf8'));
      if (currentDigest !== preCallGoalDigest) {
        errors.push(`GOAL.md was modified by Developer (digest changed from ${preCallGoalDigest} to ${currentDigest})`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    handoffFrontMatter: handoffFm,
    handoffStatus,
    isBlocked: handoffStatus === 'BLOCKED',
  };
}

export interface DeveloperValidationResult {
  valid: boolean;
  errors: string[];
  handoffFrontMatter: HandoffFrontMatter | null;
  handoffStatus: HandoffStatus | null;
  isBlocked: boolean;
}
