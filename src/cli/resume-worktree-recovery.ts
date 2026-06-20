/**
 * Injectable worktree recovery diagnostics — Phase 8D P7.
 *
 * `runWorktreeRecoveryDiagnostics()` backs `resume --recover-lock` for
 * task-graph runs. It prunes stale git worktree metadata, lists the run's
 * worktrees, classifies them with the pure worktree-recovery layer
 * (`classifyRunWorktrees`), and prints short diagnostic summaries.
 *
 * The git-touching operations (`prune`, `listForRun`) are injected so the
 * helper is unit-testable without a real repository. P7 recovery is
 * **diagnostic only**: this helper never deletes worktrees or branches and
 * never invokes automatic task cleanup. Completed, dirty, unknown, and
 * orphaned worktrees are surfaced for manual review.
 *
 * Errors from the injected dependencies propagate to the caller (the resume
 * command), which converts them into a `ResumeConsistencyError` so resume
 * stops with a clear manual-action suggestion rather than continuing with
 * misleading recovery evidence.
 */

import type { WorktreeInfo } from '../scheduler/worktree-manager.js';
import type { TaskGraph, TaskGraphState } from '../types.js';
import {
  classifyRunWorktrees,
  formatWorktreeRecoveryReport,
  type WorktreeRecoveryReport,
} from '../scheduler/worktree-recovery.js';

/**
 * Git worktree operations the diagnostics helper needs. Intentionally narrow:
 * only the read-only `prune` (stale-metadata cleanup) and `listForRun` are
 * exposed — no task cleanup, branch deletion, or worktree removal. This keeps
 * recovery non-destructive by construction.
 */
export interface WorktreeRecoveryDeps {
  /** Prune stale git worktree metadata (`git worktree prune`). */
  prune(): Promise<void>;
  /** List the worktrees currently registered for the given run. */
  listForRun(runId: string): Promise<WorktreeInfo[]>;
}

export interface RunWorktreeRecoveryDiagnosticsParams {
  runId: string;
  taskGraph: TaskGraph | null | undefined;
  taskGraphState: TaskGraphState | null | undefined;
  deps: WorktreeRecoveryDeps;
  /** Optional sink for diagnostic lines (defaults to `console.log`). */
  log?: (line: string) => void;
}

export interface RunWorktreeRecoveryDiagnosticsResult {
  worktreeCount: number;
  report: WorktreeRecoveryReport;
}

/**
 * Run non-destructive worktree recovery diagnostics for a run.
 *
 * 1. prune stale git worktree metadata,
 * 2. list the run's worktrees,
 * 3. classify them against the saved task graph + state,
 * 4. print diagnostic lines only when worktrees exist.
 *
 * Never deletes worktrees or calls task cleanup. Dependency errors propagate.
 */
export async function runWorktreeRecoveryDiagnostics(
  params: RunWorktreeRecoveryDiagnosticsParams,
): Promise<RunWorktreeRecoveryDiagnosticsResult> {
  const { runId, taskGraph, taskGraphState, deps, log } = params;

  await deps.prune();
  const worktrees = await deps.listForRun(runId);

  const report = classifyRunWorktrees({ worktrees, taskGraph, taskGraphState });

  if (worktrees.length > 0) {
    const logFn = log ?? ((line: string) => console.log(line));
    for (const line of formatWorktreeRecoveryReport(report)) {
      logFn(line);
    }
  }

  return { worktreeCount: worktrees.length, report };
}
