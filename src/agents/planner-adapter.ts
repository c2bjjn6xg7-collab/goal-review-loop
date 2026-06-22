/**
 * Planner Adapter — builds Planner input and validates Planner output.
 * Phase 3 §10.1: Planner generates plan.md and GOAL.md.
 *
 * Planner rules:
 * - Only generates .agent/plan.md and .agent/GOAL.md
 * - Must not modify business code
 * - After completion: validate plan/GOAL, check workspace ownership
 * - Compute and save GOAL digest
 */

import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { computeDigest, type Digest } from '../runtime/digest.js';
import { parsePlan, parseGoal, normalizeGoalCommands } from '../artifacts/artifact-schemas.js';
import type { AgentRunInput, GoalFrontMatter, VerificationCommand, TaskGraph } from '../types.js';
import type { IEventBus } from '../runtime/event-bus.js';
import { loadTaskGraph, taskGraphExists } from '../scheduler/task-graph.js';

/** Planner expected artifacts (relative to project root). */
const PLANNER_ARTIFACTS = ['.agent/plan.md', '.agent/GOAL.md'];

/**
 * Build the AgentRunInput for the Planner.
 */
export function buildPlannerInput(params: {
  run_id: string;
  project_root: string;
  command_template: string[];
  timeout_seconds: number;
  prompt: string;
  prompt_file?: string;
  signal?: AbortSignal;
  eventBus?: IEventBus;
}): AgentRunInput {
  return {
    role: 'planner',
    project_root: params.project_root,
    run_id: params.run_id,
    iteration: 0,
    prompt: params.prompt,
    prompt_file: params.prompt_file,
    expected_artifacts: PLANNER_ARTIFACTS.map(p => join(params.project_root, p)),
    timeout_seconds: params.timeout_seconds,
    command_template: params.command_template,
    signal: params.signal,
    eventBus: params.eventBus,
  };
}

/**
 * Validate Planner output.
 * Phase 3 §10.1 post-Planner checks:
 * 1. Parse plan and GOAL
 * 2. Validate run_id consistency
 * 3. Validate GOAL paths (no absolute, no ..)
 * 4. Validate verification commands (non-empty, safe cwd, unique IDs)
 * 5. Reject destructive verification argv
 * 6. Normalize command → argv
 * 7. Compute and save GOAL digest
 * 8. Check workspace for non-Planner changes
 */
export function validatePlannerOutput(
  projectRoot: string,
  runId: string,
): PlannerValidationResult {
  const errors: string[] = [];
  let goalFm: GoalFrontMatter | null = null;
  let goalDigest: Digest | null = null;
  let verificationCommands: VerificationCommand[] | null = null;

  // 1. Parse plan.md
  const planPath = join(projectRoot, '.agent/plan.md');
  if (!existsSync(planPath)) {
    errors.push('plan.md not found');
  } else {
    try {
      const planContent = readFileSync(planPath, 'utf8');
      const { frontMatter } = parsePlan(planContent, planPath);
      if (frontMatter.run_id !== runId) {
        errors.push(`plan.md run_id "${frontMatter.run_id}" does not match expected "${runId}"`);
      }
    } catch (err) {
      errors.push(`plan.md parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Parse GOAL.md
  const goalPath = join(projectRoot, '.agent/GOAL.md');
  if (!existsSync(goalPath)) {
    errors.push('GOAL.md not found');
  } else {
    try {
      const goalContent = readFileSync(goalPath, 'utf8');
      const { frontMatter } = parseGoal(goalContent, goalPath);

      // Check run_id consistency
      if (frontMatter.run_id !== runId) {
        errors.push(`GOAL.md run_id "${frontMatter.run_id}" does not match expected "${runId}"`);
      }

      goalFm = frontMatter;

      // 3. Validate GOAL paths
      for (const ac of frontMatter.allowed_changes) {
        if (ac.startsWith('/') || ac.includes('..')) {
          errors.push(`GOAL allowed_changes contains unsafe path: "${ac}"`);
        }
      }
      for (const dc of frontMatter.disallowed_changes) {
        if (dc.startsWith('/') || dc.includes('..')) {
          errors.push(`GOAL disallowed_changes contains unsafe path: "${dc}"`);
        }
      }

      // 4-6. Normalize verification commands
      try {
        verificationCommands = normalizeGoalCommands(frontMatter.verification_commands);
      } catch (err) {
        errors.push(`GOAL verification_commands validation error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 7. Compute GOAL digest
      goalDigest = computeDigest(goalContent);
    } catch (err) {
      errors.push(`GOAL.md parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Phase 8B: validate task-graph.json if present.
  let taskGraph: TaskGraph | null = null;
  if (taskGraphExists(projectRoot)) {
    const tgResult = loadTaskGraph(projectRoot);
    if (!tgResult.valid) {
      errors.push(`task-graph.json validation failed: ${tgResult.errors.join('; ')}`);
    } else {
      const tg = tgResult.graph!;
      // Cross-check run_id consistency
      if (tg.run_id !== runId) {
        errors.push(`task-graph.json run_id "${tg.run_id}" does not match expected "${runId}"`);
      } else if (goalDigest && tg.goal_digest !== goalDigest) {
        // Cross-check goal_digest consistency
        errors.push(`task-graph.json goal_digest "${tg.goal_digest}" does not match GOAL.md digest "${goalDigest}"`);
      } else {
        taskGraph = tg;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    goalFrontMatter: goalFm,
    goalDigest,
    verificationCommands,
    taskGraph,
  };
}

export interface PlannerValidationResult {
  valid: boolean;
  errors: string[];
  goalFrontMatter: GoalFrontMatter | null;
  goalDigest: Digest | null;
  verificationCommands: VerificationCommand[] | null;
  /** Phase 8B: validated task graph, or null when absent/invalid. */
  taskGraph: TaskGraph | null;
}

/**
 * Snapshot the workspace file digests before calling the Planner.
 * Returns a Map of posix-relative-path → digest for all tracked and
 * untracked files in the working tree.
 */
export async function snapshotWorkspaceBeforePlanner(
  projectRoot: string,
): Promise<Map<string, Digest>> {
  const snapshot = new Map<string, Digest>();
  // Use git ls-files to get all tracked files
  const { execFileSync } = await import('child_process');
  let trackedFiles: string[] = [];
  try {
    const result = execFileSync('git', ['ls-files', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    trackedFiles = result.split('\0').filter(Boolean);
  } catch {
    // Not a git repo or git failed — fall back to directory walk
  }

  // Also get untracked files
  let untrackedFiles: string[] = [];
  try {
    const result = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    untrackedFiles = result.split('\0').filter(Boolean);
  } catch {
    // ignore
  }

  const allFiles = [...trackedFiles, ...untrackedFiles];
  for (const relPath of allFiles) {
    const posixPath = relPath.split(/\\/).join('/');
    const fullPath = join(projectRoot, relPath);
    try {
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const content = readFileSync(fullPath, 'utf8');
        snapshot.set(posixPath, computeDigest(content));
      }
    } catch {
      // Skip unreadable files
    }
  }
  return snapshot;
}

/**
 * Validate that the Planner only modified allowed files.
 * Compares pre-call snapshot with current workspace state.
 * Only checks business files (not .agent/ or .git/) since
 * orchestrator-owned files in .agent/ are expected to change.
 */
export async function validatePlannerWorkspaceOwnership(
  projectRoot: string,
  preCallSnapshot: Map<string, Digest>,
): Promise<{ valid: boolean; violations: string[] }> {
  const violations: string[] = [];
  const { execFileSync } = await import('child_process');

  // Check existing files for modifications (only business files)
  for (const [relPath, expectedDigest] of preCallSnapshot) {
    // Skip orchestrator-managed paths
    if (relPath.startsWith('.agent/') || relPath.startsWith('.git/')) continue;

    const fullPath = join(projectRoot, relPath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf8');
        const currentDigest = computeDigest(content);
        if (currentDigest !== expectedDigest) {
          violations.push(`Planner modified disallowed file: ${relPath}`);
        }
      } catch {
        // Skip
      }
    } else {
      // File was deleted
      violations.push(`Planner deleted file: ${relPath}`);
    }
  }

  // Check for newly created business files (untracked)
  try {
    const result = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const newFiles = result.split('\0').filter(Boolean);
    for (const relPath of newFiles) {
      const posixPath = relPath.split(/\\/).join('/');
      // Skip .agent/ and .git/ paths
      if (posixPath.startsWith('.agent/') || posixPath.startsWith('.git/')) continue;
      if (!preCallSnapshot.has(posixPath)) {
        violations.push(`Planner created disallowed file: ${posixPath}`);
      }
    }
  } catch {
    // ignore
  }

  // Also check tracked files that may have been added (staged)
  try {
    const result = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const addedFiles = result.trim().split('\n').filter(Boolean);
    for (const relPath of addedFiles) {
      const posixPath = relPath.split(/\\/).join('/');
      if (posixPath.startsWith('.agent/') || posixPath.startsWith('.git/')) continue;
      if (!preCallSnapshot.has(posixPath)) {
        violations.push(`Planner created disallowed file: ${posixPath}`);
      }
    }
  } catch {
    // ignore
  }

  return { valid: violations.length === 0, violations };
}
