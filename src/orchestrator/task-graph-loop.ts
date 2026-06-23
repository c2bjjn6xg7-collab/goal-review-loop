/**
 * Task Graph Loop — Phase 8B task-graph execution path.
 *
 * Extracted from run-orchestrator.ts in the Phase 8C pre-refactor so the
 * task-graph execution path is independently reviewable and testable.
 * This is a pure relocation: no behavior change, no new public API beyond
 * `runTaskGraphLoop` and its dedicated helpers.
 *
 * Shared helpers (state transitions, lock handling, finalization, archive,
 * scope/diff wrappers, registry verification) remain in run-orchestrator.ts
 * and are imported here. The reverse direction (run-orchestrator.ts imports
 * only `runTaskGraphLoop` from here) keeps the dependency seam one-way for
 * shared logic.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync, lstatSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { collectDiff, writeDiffArtifacts } from '../git/diff-collector.js';
import { checkScope, writeScopeReport } from '../scope/scope-guard.js';
import { runVerification } from '../verification/verification-runner.js';
import {
  buildTaskDeveloperPrompt,
  buildPrompt,
  buildAuditorPrompt,
  writePromptFile,
  deletePromptFile,
  type PromptCleanupResult,
} from '../agents/prompt-builder.js';
import { buildDeveloperInput, validateDeveloperOutput } from '../agents/developer-adapter.js';
import { buildAuditorInput } from '../agents/auditor-adapter.js';
import { orderedTasks, initialTaskStatuses, initialTaskAttempts } from '../scheduler/task-graph.js';
import { runAgent, buildAgentLogPaths } from '../agents/agent-adapter.js';
import { resolveCommandForAgent } from '../providers/provider-registry.js';
import { normalizeGoalCommands } from '../artifacts/artifact-schemas.js';
import { dispatchFeedbackBlocks } from './feedback-dispatcher.js';
import { readFeedbackNotesForAudit } from './feedback-dispatcher.js';
import { runTaskGraphPreflight } from './task-graph-preflight.js';
import { DeveloperIdleWatchdog, type DeveloperIdleWatchdogResult } from './developer-idle-watchdog.js';
import { buildProgressData, writeProgress, writeProgressMarkdown } from '../runtime/progress-writer.js';
import type { Digest } from '../runtime/digest.js';
import type {
  ReviewLoopConfig,
  GoalFrontMatter,
  VerificationCommand,
  TaskGraph,
  TaskNode,
  TaskResult,
  TaskResultsFile,
  TaskGraphState,
} from '../types.js';
import { Phase as PhaseEnum } from '../types.js';
import type { StateStore } from './state-store.js';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { OrchestratorResult, OrchestratorFileRegistry } from './run-orchestrator.js';
import { emitProviderFailureIfClassified } from './run-orchestrator.js';
import type { IEventBus } from '../runtime/event-bus.js';
import {
  checkCancelRequest,
  makeResult,
  appendLog,
  transitionToBlocked,
  makeBlockedResult,
  emitProgress,
  snapshotSystemPaths,
  computeDigest,
  verifySystemProtectedPaths,
  registerDirectoryFiles,
  emitTranscript,
  registerAgentLogs,
  runFinalization,
} from './run-orchestrator.js';

/** Parameters for the task graph loop. */
interface TaskGraphLoopParams {
  projectRoot: string;
  agentDir: string;
  runId: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  goalFm: GoalFrontMatter;
  verificationCommands: VerificationCommand[];
  goalDigest: string;
  taskGraph: TaskGraph;
  maxIterations: number;
  combinedSignal: AbortSignal;
  noCommit: boolean;
  tag: boolean;
  /** When resuming, the 0-based task index to restart from. */
  resumeTaskIndex?: number;
  eventBus: IEventBus;
}

/**
 * Phase 8D P5 Round 2C: parameters for `runTaskGraphTaskSerial`, the helper
 * that owns one task's serial Developer/verification attempt loop.
 */
export interface RunTaskGraphTaskSerialParams {
  projectRoot: string;
  agentDir: string;
  runId: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  taskGraph: TaskGraph;
  task: TaskNode;
  taskIndex: number;
  taskTotal: number;
  tgState: TaskGraphState;
  maxIterations: number;
  combinedSignal: AbortSignal;
  goalPath: string;
  handoffPath: string;
  goalSuccessCriteria: string[];
  mainEventBus?: IEventBus;
}

/**
 * Phase 8D P5 Round 2C: result of a single serial per-task execution.
 *
 * If `terminalResult` is set, the outer task graph loop must return it
 * verbatim (cancellation paths). Otherwise `passed`/`error` describe the
 * outcome of the per-task attempt loop.
 */
export interface RunTaskGraphTaskSerialResult {
  passed: boolean;
  error: string | null;
  terminalResult?: OrchestratorResult;
}

/**
 * Phase 8D P5 Round 2C: serial per-task Developer/verification attempt loop.
 *
 * This helper owns one task's rework loop, including:
 *   - per-attempt task_attempts state writes,
 *   - task-scoped Developer prompt build/cleanup,
 *   - Developer agent invocation,
 *   - system-protected path verification,
 *   - Developer handoff validation,
 *   - feedback block dispatch,
 *   - per-task scope guard,
 *   - per-task verification command execution,
 *   - retry/break/continue control flow,
 *   - cancellation handling.
 *
 * It does NOT own task ordering, `current_task_index`, task-result
 * persistence, BLOCKED transitions, integration verification, audit, or
 * finalization — those remain in `runTaskGraphLoop`.
 */
export async function runTaskGraphTaskSerial(
  params: RunTaskGraphTaskSerialParams,
): Promise<RunTaskGraphTaskSerialResult> {
  const {
    projectRoot,
    agentDir,
    runId,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    config,
    currentBranch,
    baseCommit,
    taskGraph,
    task,
    taskIndex,
    taskTotal,
    tgState,
    maxIterations,
    combinedSignal,
    goalPath,
    handoffPath,
    goalSuccessCriteria,
    mainEventBus,
  } = params;
  const taskIndexDisplay = taskIndex + 1;

  // Normalize task verification commands
  const taskVerificationCommands = normalizeGoalCommands(task.verification_commands);

  // ── Phase 8D P6.5: task graph scope preflight (warn-only) ──
  // Surface risky scopes before any Developer attempt runs: a required
  // integration-test verification with a test-only allowed_changes (no
  // source/docs/config path) usually cannot be satisfied. Warnings are logged
  // to iteration-log.md here and never block execution.
  const preflight = runTaskGraphPreflight({
    task_id: task.id,
    allowed_changes: task.allowed_changes,
    verification_commands: taskVerificationCommands,
  });
  for (const warning of preflight.warnings) {
    await appendLog(
      artifactStore,
      runId,
      taskIndexDisplay,
      'DEVELOPING',
      `task ${task.id} preflight`,
      'PASS',
      `PREFLIGHT WARNING (${warning.code}): ${warning.message}`,
    );
  }

  // ── Per-task Developer attempts (rework loop) ──
  let taskPassed = false;
  let taskError: string | null = null;

  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    tgState.task_attempts[task.id] = attempt;
    await stateStore.update(() => ({ task_graph_state: { ...tgState } }));

    await emitTaskProgress({ projectRoot, stateStore, taskGraph, taskIndex, taskStatus: attempt > 1 ? 'rework' : 'running', lastEvent: `Task ${taskIndexDisplay} attempt ${attempt}/${maxIterations}: ${task.title}` });

    // Build task-scoped Developer prompt
    // Phase 8B: Remove stale developer-handoff.md from prior tasks so the
    // agent-adapter artifact freshness check sees a freshly written file.
    const handoffFile = join(agentDir, 'developer-handoff.md');
    if (existsSync(handoffFile)) {
      try { unlinkSync(handoffFile); } catch { /* best effort */ }
    }

    // Snapshot protected paths + plan/GOAL digests BEFORE creating the prompt
    // file, so the prompt file (written to .agent/debug/) is not in the
    // snapshot and its later deletion is not flagged as tampering.
    const preDevSystemPaths = snapshotSystemPaths(agentDir);
    const preDevGoalDigest = computeDigest(readFileSync(goalPath, 'utf8'));
    // Phase 8B: snapshot workspace files for a task-scoped diff after Developer.
    const preTaskWorkspace = snapshotWorkspaceFiles(projectRoot);

    let developerPrompt: string;
    let developerPromptFile: string | undefined;
    try {
      developerPrompt = buildTaskDeveloperPrompt({
        run_id: runId,
        project_root: projectRoot,
        task_index: taskIndexDisplay,
        task_total: taskTotal,
        task_id: task.id,
        task_title: task.title,
        task_description: task.description,
        allowed_changes: task.allowed_changes,
        disallowed_changes: task.disallowed_changes,
        verification_commands: task.verification_commands,
        goal_success_criteria: goalSuccessCriteria,
        goal_path: goalPath,
        handoff_path: handoffPath,
      });
      developerPromptFile = await writePromptFile(agentDir, developerPrompt, runId, `task-${task.id}-attempt-${attempt}`);
    } catch (err) {
      taskError = `Prompt build failed: ${err instanceof Error ? err.message : String(err)}`;
      await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} prompt`, 'FAIL', taskError);
      break;
    }

    // ── Phase 8D P6.5: per-attempt idle watchdog ──
    // Compose a per-attempt AbortController with the run-wide combinedSignal so
    // that either a user cancel OR an idle-watchdog trip aborts this attempt.
    // The watchdog watches the attempt's stdout/stderr logs and the handoff
    // file; if none grow within the configured idle window it aborts the
    // controller, which the Process Runner turns into a 'cancelled' result.
    const attemptAbortController = createAttemptAbortController(combinedSignal);
    const idleTimeoutSeconds = config.runtime.agent_idle_timeout_seconds;
    const attemptLogPaths = buildAgentLogPaths(
      join(agentDir, 'debug'),
      runId,
      'developer',
      taskIndexDisplay,
      attempt,
    );
    const idleWatchdog = new DeveloperIdleWatchdog({
      idleTimeoutMs: idleTimeoutSeconds * 1000,
      stdoutPath: attemptLogPaths.stdoutPath,
      stderrPath: attemptLogPaths.stderrPath,
      handoffPath,
      controller: attemptAbortController,
    });

    let developerResult;
    let developerCleanupResult: PromptCleanupResult | undefined;
    let watchdogResult: DeveloperIdleWatchdogResult | undefined;
    try {
      await emitProgress({ projectRoot, stateStore, lastEvent: `Running Developer for task ${taskIndexDisplay} (attempt ${attempt})`, registry: orchestratorRegistry });

      const developerInput = buildDeveloperInput({
        run_id: runId,
        iteration: taskIndexDisplay,
        // F-8D-T-001 fix: pass attempt so retry log files don't collide
        // with the previous attempt's log files (which would otherwise
        // trip verifySystemProtectedPaths' digest_mismatch check).
        attempt,
        project_root: projectRoot,
        command_template: resolveCommandForAgent(config.agents.developer.command, config.agents.developer.provider, config),
        timeout_seconds: config.agents.developer.timeout_seconds,
        prompt: developerPrompt,
        prompt_file: developerPromptFile,
        // Per-attempt signal: aborted by user cancel OR idle-watchdog trip.
        signal: attemptAbortController.signal,
        eventBus: mainEventBus,
      });

      idleWatchdog.start();
      developerResult = await runAgent(developerInput, projectRoot);
    } finally {
      idleWatchdog.stop();
      watchdogResult = idleWatchdog.getResult();
      if (developerPromptFile) developerCleanupResult = await deletePromptFile(developerPromptFile);
    }

    if (developerResult) {
      emitTranscript({ projectRoot, role: 'developer', iteration: taskIndexDisplay, runId, startedAt: new Date().toISOString(), result: developerResult, registry: orchestratorRegistry });
    }
    registerAgentLogs(developerResult, orchestratorRegistry);

    if (developerCleanupResult && !developerCleanupResult.success) {
      taskError = `Prompt cleanup failed: ${developerCleanupResult.error}`;
      await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} cleanup`, 'FAIL', taskError);
      break;
    }

    // ── Phase 8D P6.5: idle-watchdog trip ──
    // A watchdog trip aborts the attempt, which surfaces as a 'cancelled'
    // result. Treat that as a task failure (stall) — NOT a user cancel — so
    // the rework loop retries or exhausts into BLOCKED with actionable
    // idle-timeout detail (task id, attempt, idle seconds, log paths, and a
    // suggested action from the watchdog reason).
    if (watchdogResult?.tripped) {
      taskError =
        `Developer stalled on task ${task.id} attempt ${attempt}: idle watchdog tripped after ` +
        `${idleTimeoutSeconds}s with no stdout, stderr, or handoff-file activity. ` +
        `${watchdogResult.reason ?? ''}`;
      await appendLog(
        artifactStore,
        runId,
        taskIndexDisplay,
        'DEVELOPING',
        `task ${task.id} developer idle watchdog`,
        'FAIL',
        taskError,
      );
      if (attempt < maxIterations) continue;
      break;
    }

    if (developerResult.status === 'cancelled') {
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} developer`, 'CANCELLED', developerResult.error?.message);
      return {
        passed: false,
        error: 'Run cancelled by user request',
        terminalResult: makeResult(runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [], 'Run cancelled by user request', `Developer cancelled on task ${task.id}`, developerResult.error),
      };
    }

    if (developerResult.status !== 'success') {
      taskError = `Developer failed: ${developerResult.error?.message ?? 'unknown'}`;
      await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} developer attempt ${attempt}`, 'FAIL', taskError);
      if (attempt < maxIterations) continue;
      break;
    }

    // Verify system-protected paths unchanged
    const registryVerification = await verifySystemProtectedPaths(projectRoot, orchestratorRegistry, preDevSystemPaths);
    if (!registryVerification.valid) {
      const violationMsgs = registryVerification.violations.map(v => v.message).join('; ');
      taskError = `Developer tampered with system-protected paths: ${violationMsgs}`;
      await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} system path integrity`, 'FAIL', violationMsgs);
      if (attempt < maxIterations) continue;
      break;
    }

    // Validate Developer handoff
    const developerValidation = validateDeveloperOutput(projectRoot, runId, taskIndexDisplay, null, preDevGoalDigest);
    if (!developerValidation.valid) {
      taskError = `Developer output invalid: ${developerValidation.errors.join('; ')}`;
      await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} handoff`, 'FAIL', developerValidation.errors.join('; '));
      if (attempt < maxIterations) continue;
      break;
    }
    if (developerValidation.isBlocked) {
      taskError = 'Developer reported BLOCKED';
      await appendLog(artifactStore, runId, taskIndexDisplay, 'DEVELOPING', `task ${task.id} handoff`, 'BLOCKED', 'Developer reported BLOCKED');
      break;
    }

    // Phase 10: dispatch ReviewLoopRequest feedback blocks from developer-handoff.md (best-effort).
    await dispatchFeedbackBlocks({
      projectRoot, runId, role: 'developer',
      artifactPath: join(projectRoot, '.agent/developer-handoff.md'),
      config: config.feedback_protocol,
      registry: orchestratorRegistry,
    }).catch(() => { /* failure-safe */ });

    // ── Per-task scope guard (enforces task.allowed_changes) ──
    // Collect full diff for evidence/metadata, but scope-check ONLY the files
    // this Developer run changed (task-scoped), so prior tasks' files — which
    // legitimately fall outside this task's allowed_changes — are not flagged.
    const diffResult = await collectDiff({ projectRoot, baseCommit, iteration: taskIndexDisplay });
    await writeDiffArtifacts(projectRoot, taskIndexDisplay, diffResult);
    const taskChangedFiles = buildTaskChangedFiles(projectRoot, preTaskWorkspace);
    registerDirectoryFiles(join(agentDir, 'evidence', `iteration-${String(taskIndexDisplay).padStart(2, '0')}`), orchestratorRegistry);

    const orchestratorOwnedFiles = orchestratorRegistry.getRelativePaths(projectRoot);
    const scopeResult = checkScope({
      allowedChanges: task.allowed_changes,
      disallowedChanges: task.disallowed_changes,
      changedFiles: taskChangedFiles,
      orchestratorOwnedFiles,
    });
    await writeScopeReport(projectRoot, taskIndexDisplay, scopeResult.report);
    if (existsSync(join(agentDir, 'evidence', `iteration-${String(taskIndexDisplay).padStart(2, '0')}`, 'scope-report.json'))) {
      orchestratorRegistry.register(join(agentDir, 'evidence', `iteration-${String(taskIndexDisplay).padStart(2, '0')}`, 'scope-report.json'), computeDigest(readFileSync(join(agentDir, 'evidence', `iteration-${String(taskIndexDisplay).padStart(2, '0')}`, 'scope-report.json'), 'utf8')));
    }

    if (!scopeResult.passed) {
      const deniedPaths = scopeResult.report.denied.map(d => `${d.path} (${d.reason})`).join(', ');
      taskError = `Scope violation: ${deniedPaths}`;
      await appendLog(artifactStore, runId, taskIndexDisplay, 'VERIFYING', `task ${task.id} scope`, 'FAIL', deniedPaths);
      if (attempt < maxIterations) continue;
      break;
    }
    await appendLog(artifactStore, runId, taskIndexDisplay, 'VERIFYING', `task ${task.id} scope`, 'PASS');

    // ── Per-task verification ──
    if (combinedSignal.aborted) {
      await stateStore.transition(PhaseEnum.CANCELLED);
      return {
        passed: false,
        error: 'Verification cancelled by abort signal',
        terminalResult: makeResult(runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [], 'Run cancelled', 'Verification cancelled by abort signal', null),
      };
    }

    const verificationResult = await runVerification({
      commands: taskVerificationCommands,
      projectRoot,
      runId,
      iteration: taskIndexDisplay,
      signal: combinedSignal,
    });
    registerDirectoryFiles(join(agentDir, 'verification', `iteration-${String(taskIndexDisplay).padStart(2, '0')}`), orchestratorRegistry);
    const taskManifestPath = join(agentDir, 'verification', 'manifest.json');
    if (existsSync(taskManifestPath)) {
      orchestratorRegistry.register(taskManifestPath, computeDigest(readFileSync(taskManifestPath, 'utf8')));
    }

    const requiredPassed = verificationResult.manifest.commands
      .filter(c => c.required)
      .every(c => c.status === 'success');

    if (!requiredPassed || !verificationResult.passed) {
      const failedCmds = verificationResult.manifest.commands
        .filter(c => c.required && c.status !== 'success')
        .map(c => c.id);
      taskError = `Task verification failed: ${failedCmds.join(', ')}`;
      await appendLog(artifactStore, runId, taskIndexDisplay, 'VERIFYING', `task ${task.id} verification`, 'FAIL', failedCmds.join(', '));
      if (attempt < maxIterations) continue;
      break;
    }

    await appendLog(artifactStore, runId, taskIndexDisplay, 'VERIFYING', `task ${task.id} verification`, 'PASS');
    taskPassed = true;
    taskError = null;
    break;
  } // end per-task attempt loop

  return { passed: taskPassed, error: taskError };
}

/**
 * Phase 8B: Execute tasks in topological order.
 *
 * For each task:
 *   1. Build a task-scoped Developer prompt.
 *   2. Run Developer (Claude) with per-task scope guard.
 *   3. Run the task's verification_commands.
 *   4. On failure, rework up to maxIterations.
 *   5. On exhaustion, BLOCKED the run.
 *
 * After all tasks pass, run the GOAL's integration verification, then
 * delegate to runFinalization (final audit + commit + tag).
 */
export async function runTaskGraphLoop(params: TaskGraphLoopParams): Promise<OrchestratorResult> {
  const {
    projectRoot, agentDir, runId, stateStore, artifactStore,
    orchestratorRegistry, config, currentBranch, baseCommit,
    goalFm, verificationCommands, goalDigest, taskGraph,
    maxIterations, combinedSignal, noCommit, tag, resumeTaskIndex, eventBus,
  } = params;

  const ordered = orderedTasks(taskGraph);
  const goalPath = join(projectRoot, '.agent/GOAL.md');
  const handoffPath = join(projectRoot, '.agent/developer-handoff.md');
  const taskResultsPath = join(agentDir, 'task-results.json');

  // Parse GOAL success criteria lines from the GOAL.md body for context.
  const goalSuccessCriteria = parseGoalSuccessCriteria(goalPath);

  // Initialize task graph state if not already present (or fresh run).
  let state = await stateStore.read();
  if (!state.task_graph_state) {
    await stateStore.update(() => ({
      task_graph_state: {
        current_task_index: 0,
        task_statuses: initialTaskStatuses(taskGraph),
        task_attempts: initialTaskAttempts(taskGraph),
      } as TaskGraphState,
    }));
    state = await stateStore.read();
  }

  const tgState = state.task_graph_state!;

  // Load any existing task results (for resume continuity).
  let taskResults = loadTaskResults(taskResultsPath);

  const startIndex = resumeTaskIndex ?? tgState.current_task_index ?? 0;

  for (let i = startIndex; i < ordered.length; i++) {
    const task = ordered[i];
    const taskIndexDisplay = i + 1;

    // Cancel check
    const cancelReq = await checkCancelRequest(agentDir);
    if (cancelReq) {
      await stateStore.update(() => ({ cancel_requested_at: cancelReq.requested_at, task_graph_state: { ...tgState, current_task_index: i, task_statuses: { ...tgState.task_statuses, [task.id]: 'failed' } } }));
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, i + 1, 'DEVELOPING', 'cancel requested', 'CANCELLED');
      return makeResult(runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [], 'Run cancelled by user request', `Cancel requested at ${cancelReq.requested_at}`, null);
    }

    // Mark task running + persist state
    tgState.current_task_index = i;
    tgState.task_statuses[task.id] = 'running';
    await stateStore.update(() => ({ task_graph_state: { ...tgState } }));
    await emitTaskProgress({ projectRoot, stateStore, taskGraph, taskIndex: i, taskStatus: 'running', lastEvent: `Starting task ${taskIndexDisplay}/${ordered.length}: ${task.title}` });
    await eventBus.emit({
      kind: 'task.started',
      phase: 'DEVELOPING',
      level: 'info',
      message: `Task ${taskIndexDisplay}/${ordered.length}: ${task.title}`,
      task_id: task.id,
      payload: { task_index: i, task_total: ordered.length },
    });

    await appendLog(artifactStore, runId, i + 1, 'DEVELOPING', `task ${task.id} start`, 'PASS', `Task ${taskIndexDisplay} of ${ordered.length}: ${task.title}`);
    await emitProgress({ projectRoot, stateStore, lastEvent: `Task ${taskIndexDisplay}/${ordered.length}: ${task.title}`, registry: orchestratorRegistry });

    // ── Phase 8D P5 Round 2C: delegate the per-task attempt loop to the
    // serial helper. The outer loop retains task ordering, current_task_index,
    // task-result persistence, BLOCKED transitions, integration verification,
    // audit, and finalization.
    const taskExecution = await runTaskGraphTaskSerial({
      projectRoot,
      agentDir,
      runId,
      stateStore,
      artifactStore,
      orchestratorRegistry,
      config,
      currentBranch,
      baseCommit,
      taskGraph,
      task,
      taskIndex: i,
      taskTotal: ordered.length,
      tgState,
      maxIterations,
      combinedSignal,
      goalPath,
      handoffPath,
      goalSuccessCriteria,
    });

    if (taskExecution.terminalResult) {
      return taskExecution.terminalResult;
    }

    const taskPassed = taskExecution.passed;
    const taskError = taskExecution.error;

    // Record task result
    const now = new Date().toISOString();
    const taskResult: TaskResult = {
      task_id: task.id,
      status: taskPassed ? 'passed' : 'failed',
      attempts: tgState.task_attempts[task.id] ?? 0,
      started_at: now,
      finished_at: now,
      verification_passed: taskPassed,
      error: taskError,
    };
    taskResults = upsertTaskResult(taskResults, runId, taskResult);
    await writeTaskResults(taskResultsPath, taskResults);
    orchestratorRegistry.register(taskResultsPath, computeDigest(readFileSync(taskResultsPath, 'utf8')));

    tgState.task_statuses[task.id] = taskPassed ? 'passed' : 'failed';
    await stateStore.update(() => ({ task_graph_state: { ...tgState } }));

    const taskProgressEvent = taskPassed
      ? `Task ${taskIndexDisplay}/${ordered.length} passed: ${task.title}`
      : `Task ${taskIndexDisplay}/${ordered.length} failed: ${task.title}${taskError ? ` — ${taskError}` : ''}`;
    await emitTaskProgress({ projectRoot, stateStore, taskGraph, taskIndex: i, taskStatus: taskPassed ? 'passed' : 'failed', lastEvent: taskProgressEvent });
    await eventBus.emit({
      kind: taskPassed ? 'task.completed' : 'task.blocked',
      phase: 'DEVELOPING',
      level: taskPassed ? 'info' : 'warn',
      message: taskProgressEvent,
      task_id: task.id,
      status: taskPassed ? 'passed' : 'failed',
    });

    if (!taskPassed) {
      // Task failed after max rework — BLOCKED the entire run.
      await transitionToBlocked(stateStore, `Task "${task.id}" failed after ${tgState.task_attempts[task.id]} attempt(s): ${taskError}`, eventBus);
      await appendLog(artifactStore, runId, i + 1, 'DEVELOPING', `task ${task.id} exhausted`, 'BLOCKED', taskError ?? 'unknown');
      return makeBlockedResult(runId, projectRoot, `Task "${task.id}" failed after ${tgState.task_attempts[task.id]} attempt(s): ${taskError ?? 'unknown'}`, 'VERIFICATION_FAILED', currentBranch);
    }

    await appendLog(artifactStore, runId, i + 1, 'DEVELOPING', `task ${task.id} completed`, 'PASS', `Task ${taskIndexDisplay} of ${ordered.length} passed`);
  } // end task loop

  // ═══════════════════════════════════════════════════════════
  // All tasks passed — final integration verification
  // ═══════════════════════════════════════════════════════════
  const integrationIteration = ordered.length + 1;
  await stateStore.transition(PhaseEnum.VERIFYING);
  await appendLog(artifactStore, runId, integrationIteration, 'VERIFYING', 'integration verification start', 'PASS');
  await emitProgress({ projectRoot, stateStore, lastEvent: 'Running final integration verification', registry: orchestratorRegistry });

  const integrationDiff = await collectDiff({ projectRoot, baseCommit, iteration: integrationIteration });
  await writeDiffArtifacts(projectRoot, integrationIteration, integrationDiff);

  // Final scope check uses the GOAL's global allowed_changes
  const finalOrchestratorOwned = orchestratorRegistry.getRelativePaths(projectRoot);
  const finalScopeResult = checkScope({
    allowedChanges: goalFm.allowed_changes,
    disallowedChanges: goalFm.disallowed_changes,
    changedFiles: integrationDiff.changedFiles,
    orchestratorOwnedFiles: finalOrchestratorOwned,
  });
  await writeScopeReport(projectRoot, integrationIteration, finalScopeResult.report);
  registerDirectoryFiles(join(agentDir, 'evidence', `iteration-${String(integrationIteration).padStart(2, '0')}`), orchestratorRegistry);

  if (!finalScopeResult.passed) {
    const deniedPaths = finalScopeResult.report.denied.map(d => `${d.path} (${d.reason})`).join(', ');
    await transitionToBlocked(stateStore, `Final integration scope violation: ${deniedPaths}`, eventBus);
    await appendLog(artifactStore, runId, integrationIteration, 'VERIFYING', 'integration scope', 'FAIL', deniedPaths);
    return makeBlockedResult(runId, projectRoot, `Final integration scope violation: ${deniedPaths}`, 'SCOPE_VIOLATION', currentBranch);
  }

  if (combinedSignal.aborted) {
    await stateStore.transition(PhaseEnum.CANCELLED);
    return makeResult(runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [], 'Run cancelled', 'Integration verification cancelled', null);
  }

  const integrationVerification = await runVerification({
    commands: verificationCommands,
    projectRoot,
    runId,
    iteration: integrationIteration,
    signal: combinedSignal,
  });
  registerDirectoryFiles(join(agentDir, 'verification', `iteration-${String(integrationIteration).padStart(2, '0')}`), orchestratorRegistry);
  const integrationManifestPath = join(agentDir, 'verification', 'manifest.json');
  if (existsSync(integrationManifestPath)) {
    orchestratorRegistry.register(integrationManifestPath, computeDigest(readFileSync(integrationManifestPath, 'utf8')));
  }

  const integrationPassed = integrationVerification.manifest.commands
    .filter(c => c.required)
    .every(c => c.status === 'success') && integrationVerification.passed;

  if (!integrationPassed) {
    const failedCmds = integrationVerification.manifest.commands
      .filter(c => c.required && c.status !== 'success')
      .map(c => c.id);
    await transitionToBlocked(stateStore, `Final integration verification failed: ${failedCmds.join(', ')}`, eventBus);
    await appendLog(artifactStore, runId, integrationIteration, 'VERIFYING', 'integration verification', 'FAIL', failedCmds.join(', '));
    return makeBlockedResult(runId, projectRoot, `Final integration verification failed: ${failedCmds.join(', ')}`, 'VERIFICATION_FAILED', currentBranch);
  }

  await appendLog(artifactStore, runId, integrationIteration, 'VERIFYING', 'integration verification', 'PASS');

  const diffDigest = `sha256:${integrationDiff.diffDigest}` as Digest;
  await stateStore.update(() => ({ audited_diff_digest: diffDigest }));

  // ── Audit the full cumulative diff before finalization ──
  // runFinalization runs the Final Auditor, which requires audit-report.md to
  // exist. Run one Auditor pass over the integration diff to produce it.
  const auditIteration = integrationIteration;
  await stateStore.transition(PhaseEnum.AUDITING);
  await appendLog(artifactStore, runId, auditIteration, 'AUDITING', 'auditor start', 'PASS');
  await emitProgress({ projectRoot, stateStore, lastEvent: 'Starting Auditor (integration)', registry: orchestratorRegistry });
  await eventBus.emit({
    kind: 'role.started',
    phase: 'AUDITING',
    level: 'info',
    message: 'Integration Auditor starting',
    role: 'auditor',
    provider: config.agents.auditor.provider ?? 'codex',
  });

  {
    let auditorPromptFile: string | undefined;
    let auditorResult;
    let auditorCleanupResult: PromptCleanupResult | undefined;
    try {
      const iterStr = String(auditIteration).padStart(2, '0');
      const taskGraphFeedbackNotes = await readFeedbackNotesForAudit(projectRoot);
      const promptResult = await buildPrompt(
        projectRoot,
        'auditor.md',
        (template) => buildAuditorPrompt(template, {
          run_id: runId,
          iteration: auditIteration,
          project_root: projectRoot,
          plan_path: join(projectRoot, '.agent/plan.md'),
          goal_path: join(projectRoot, '.agent/GOAL.md'),
          handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
          verification_manifest_path: join(agentDir, 'verification', 'manifest.json'),
          changed_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'changed-files.json'),
          untracked_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'untracked-files.json'),
          scope_report_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'scope-report.json'),
          tracked_diff_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'tracked.diff'),
          diff_metadata_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'diff-metadata.json'),
          audit_report_path: join(projectRoot, '.agent/audit-report.md'),
          goal_digest: goalDigest,
          diff_digest: diffDigest,
          feedback_notes: taskGraphFeedbackNotes,
          feedback_notes_path: '.agent/feedback-notes.md',
        }),
        { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'auditor' },
      );
      auditorPromptFile = promptResult.prompt_file_path ?? undefined;

      const auditorInput = buildAuditorInput({
        run_id: runId,
        iteration: auditIteration,
        project_root: projectRoot,
        command_template: resolveCommandForAgent(config.agents.auditor.command, config.agents.auditor.provider, config),
        timeout_seconds: config.agents.auditor.timeout_seconds,
        prompt: promptResult.prompt,
        prompt_file: auditorPromptFile,
        signal: combinedSignal,
        eventBus: eventBus,
      });
      auditorResult = await runAgent(auditorInput, projectRoot);
    } finally {
      if (auditorPromptFile) auditorCleanupResult = await deletePromptFile(auditorPromptFile);
    }

    if (auditorResult) {
      emitTranscript({ projectRoot, role: 'auditor', iteration: auditIteration, runId, startedAt: new Date().toISOString(), result: auditorResult, registry: orchestratorRegistry });
      await eventBus.emit({
        kind: 'role.exited',
        phase: 'AUDITING',
        level: auditorResult.status !== 'success' ? 'warn' : 'info',
        message: `Integration Auditor exited (${auditorResult.status})`,
        role: 'auditor',
        status: auditorResult.status,
        exit_code: auditorResult.exit_code ?? undefined,
        duration_ms: auditorResult.duration_ms ?? undefined,
        provider: config.agents.auditor.provider ?? 'codex',
      });
    }
    registerAgentLogs(auditorResult, orchestratorRegistry);

    if (auditorCleanupResult && !auditorCleanupResult.success) {
      await transitionToBlocked(stateStore, `Auditor prompt cleanup failed: ${auditorCleanupResult.error}`, eventBus);
      return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${auditorCleanupResult.error}`, 'STATE_CONFLICT', currentBranch);
    }
    if (auditorResult.status === 'cancelled') {
      await stateStore.transition(PhaseEnum.CANCELLED);
      return makeResult(runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [], 'Run cancelled', 'Auditor cancelled', auditorResult.error);
    }
    if (auditorResult.status !== 'success') {
      await emitProviderFailureIfClassified({
        eventBus,
        stderrPath: auditorResult.stderr_path,
        exitCode: auditorResult.exit_code,
        provider: config.agents.auditor.provider ?? 'codex',
        role: 'auditor',
        phase: 'AUDITING',
      });
      await transitionToBlocked(stateStore, `Auditor failed: ${auditorResult.error?.message ?? 'unknown'}`, eventBus);
      return makeBlockedResult(runId, projectRoot, `Auditor failed: ${auditorResult.error?.message ?? 'unknown'}`, 'AGENT_ERROR', currentBranch);
    }

    // Register audit-report.md
    const auditReportPath = join(agentDir, 'audit-report.md');
    if (existsSync(auditReportPath)) {
      orchestratorRegistry.register(auditReportPath, computeDigest(readFileSync(auditReportPath, 'utf8')));
    }
    await eventBus.emit({
      kind: 'audit.decision',
      phase: 'AUDITING',
      level: 'info',
      message: `Integration Auditor decision: PASS (iter ${auditIteration})`,
      role: 'auditor',
      status: 'PASS',
      artifact_refs: [{ type: 'audit-report', path: '.agent/audit-report.md' }],
      payload: { integration_audit: true, diff_digest: diffDigest },
    });
    await appendLog(artifactStore, runId, auditIteration, 'AUDITING', 'auditor completed', 'PASS');
  }

  // Transition to FINALIZING before delegating to the finalization pipeline.
  await stateStore.transition(PhaseEnum.FINALIZING);

  // Delegate to the existing finalization pipeline (final audit + commit + tag).
  return await runFinalization({
    projectRoot,
    agentDir,
    runId,
    stateStore,
    artifactStore,
    config,
    currentBranch,
    baseCommit,
    goalFm,
    goalDigest,
    diffDigest,
    iteration: integrationIteration,
    noCommit,
    tag,
    combinedSignal,
    orchestratorRegistry,
    eventBus,
  });
}

// ─── Phase 8B: Task Graph helpers ─────────────────────────────

/**
 * Phase 8D P6.5: Create a per-attempt AbortController composed with a parent
 * signal. The returned controller aborts when the parent aborts (user cancel)
 * OR when an idle watchdog aborts it directly. If the parent is already
 * aborted, the controller is returned pre-aborted so the attempt never starts.
 *
 * This keeps the existing cancellation path (combinedSignal) working while
 * giving the idle watchdog its own controller to trip independently per attempt.
 */
function createAttemptAbortController(parentSignal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return controller;
  }
  parentSignal.addEventListener(
    'abort',
    () => {
      if (!controller.signal.aborted) controller.abort(parentSignal.reason);
    },
    { once: true },
  );
  return controller;
}

/**
 * Parse "Success Criteria" numbered lines from GOAL.md body.
 * Returns an array of criteria strings for task prompt context.
 */
// ─── Phase 8B: per-task workspace diff ────────────────────────

/**
 * Snapshot all workspace files (tracked + untracked) with their digests.
 * Used to compute per-task diffs that only include files a single task
 * Developer run changed — not the cumulative diff from baseCommit.
 */
export function snapshotWorkspaceFiles(projectRoot: string): Map<string, string> {
  const snap = new Map<string, string>();
  try {
    const tracked = execSync('git ls-files -z', { cwd: projectRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
    const untracked = execSync('git ls-files --others --exclude-standard -z', { cwd: projectRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const rel of [...tracked, ...untracked]) {
      const posix = rel.split(/\\/).join('/');
      const full = join(projectRoot, rel);
      if (existsSync(full)) {
        try {
          const st = lstatSync(full);
          if (st.isFile()) snap.set(posix, computeDigest(readFileSync(full, 'utf8')));
        } catch { /* skip */ }
      }
    }
  } catch { /* not a git repo — fall back empty */ }
  return snap;
}

/**
 * Build a ChangedFilesSchema containing only files that changed between
 * a pre-task snapshot and the current workspace state.
 */
export function buildTaskChangedFiles(projectRoot: string, preTask: Map<string, string>): import('../types.js').ChangedFilesSchema {
  const current = snapshotWorkspaceFiles(projectRoot);
  const files: import('../types.js').ChangedFile[] = [];
  const allPaths = new Set<string>([...preTask.keys(), ...current.keys()]);
  for (const posix of allPaths) {
    const before = preTask.get(posix);
    const after = current.get(posix);
    if (before === after) continue;
    if (before === undefined && after !== undefined) {
      files.push({ path: posix, status: 'added', tracked: false, additions: null, deletions: null });
    } else if (before !== undefined && after === undefined) {
      files.push({ path: posix, status: 'deleted', tracked: true, additions: null, deletions: null });
    } else {
      files.push({ path: posix, status: 'modified', tracked: true, additions: null, deletions: null });
    }
  }
  return { schema_version: 1, base_commit: 'task-scoped', files };
}

export function parseGoalSuccessCriteria(goalPath: string): string[] {
  try {
    const content = readFileSync(goalPath, 'utf8');
    const lines = content.split('\n');
    const criteria: string[] = [];
    let inSection = false;
    for (const line of lines) {
      const heading = line.trim().toLowerCase();
      if (heading.startsWith('#') && heading.includes('success criteria')) {
        inSection = true;
        continue;
      }
      if (inSection) {
        // Stop at the next heading
        if (heading.startsWith('#')) break;
        const match = line.match(/^\s*\d+\.\s+(.+)$/);
        if (match) {
          criteria.push(match[1].trim());
        }
      }
    }
    return criteria;
  } catch {
    return [];
  }
}

/** Load task-results.json, or return an empty shell. */
export function loadTaskResults(path: string): TaskResultsFile {
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf8')) as TaskResultsFile;
      if (data && data.schema_version === 1 && Array.isArray(data.results)) {
        return data;
      }
    }
  } catch { /* fall through to empty */ }
  return { schema_version: 1, run_id: '', results: [] };
}

/** Insert or replace a task result by task_id. */
export function upsertTaskResult(file: TaskResultsFile, runId: string, result: TaskResult): TaskResultsFile {
  const results = file.results.filter((r) => r.task_id !== result.task_id);
  results.push(result);
  return { schema_version: 1, run_id: runId, results };
}

/** Atomically write task-results.json. */
export async function writeTaskResults(path: string, file: TaskResultsFile): Promise<void> {
  const { atomicWriteJSON } = await import('../runtime/atomic-file.js');
  await atomicWriteJSON(path, file);
}

/** Emit task-aware progress to progress.json/progress.md. */
export async function emitTaskProgress(params: {
  projectRoot: string;
  stateStore: StateStore;
  taskGraph: TaskGraph;
  taskIndex: number;
  taskStatus: 'running' | 'passed' | 'failed' | 'rework';
  lastEvent: string;
}): Promise<void> {
  try {
    const state = await params.stateStore.read();
    const total = params.taskGraph.tasks.length;
    const ordered = orderedTasks(params.taskGraph);
    const task = ordered[params.taskIndex];
    const data = buildProgressData({
      run_id: state.run_id,
      phase: state.phase,
      iteration: state.iteration,
      max_iterations: state.max_iterations,
      branch: state.branch,
      task_slug: state.task_slug,
      started_at: state.started_at,
      stages: state.stages as Record<string, import('../types.js').StageInfo>,
      last_event: params.lastEvent,
      task_graph: {
        current_task_id: task?.id ?? null,
        current_task_title: task?.title ?? null,
        task_index: `Task ${params.taskIndex + 1} of ${total}`,
        task_status: params.taskStatus,
        overall_progress: `${params.taskIndex}/${total} complete`,
      },
    });
    await writeProgress(params.projectRoot, data);
    writeProgressMarkdown(params.projectRoot, data);
  } catch { /* progress writing is best-effort */ }
}
