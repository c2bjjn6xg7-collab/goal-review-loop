import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import {
  runWaveExecutorCore,
  type WaveTaskRunnerResult,
  type WaveTerminalTaskStatus,
} from '../scheduler/wave-executor.js';
import { orderedTasks, initialTaskAttempts, initialTaskStatuses } from '../scheduler/task-graph.js';
import { runTaskInWorktree } from './task-graph-worktree-runner.js';
import type { IEventBus } from '../runtime/event-bus.js';
import {
  loadTaskResults,
  upsertTaskResult,
  writeTaskResults,
  emitTaskProgress,
} from './task-graph-loop.js';
import type { StateStore } from './state-store.js';
import type { OrchestratorFileRegistry, OrchestratorResult } from './run-orchestrator.js';
import {
  appendLog,
  emitProgress,
  makeBlockedResult,
  makeResult,
  computeDigest,
  registerDirectoryFiles,
} from './run-orchestrator.js';
import { buildIntegrationPlan } from './integration-plan.js';
import {
  integrationArtifactDir,
  integrationArtifactPaths,
  runIntegrationMerge,
  writeIntegrationPlanEvidence,
} from './integration-runner.js';
import { runIntegrationAudit } from './integration-audit.js';
import { runIntegrationFinalization } from './integration-finalizer.js';
import {
  Phase as PhaseEnum,
  TaskStatus,
  type ReviewLoopConfig,
  type GoalFrontMatter,
  type TaskGraph,
  type TaskGraphState,
  type TaskResult,
  type VerificationCommand,
} from '../types.js';

export interface TaskGraphWaveLoopParams {
  projectRoot: string;
  agentDir: string;
  runId: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  goalDigest: string;
  goalFm: GoalFrontMatter;
  verificationCommands: VerificationCommand[];
  taskGraph: TaskGraph;
  maxIterations: number;
  maxParallelWorkers: number;
  combinedSignal: AbortSignal;
  noCommit: boolean;
  tag: boolean;
  eventBus: IEventBus;
}

export async function runTaskGraphWaveLoop(
  params: TaskGraphWaveLoopParams,
): Promise<OrchestratorResult> {
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
    goalDigest,
    goalFm,
    verificationCommands,
    taskGraph,
    maxIterations,
    maxParallelWorkers,
    combinedSignal,
    noCommit,
    tag,
    eventBus,
  } = params;

  const tasks = orderedTasks(taskGraph);
  const taskIndexById = new Map(tasks.map((task, index) => [task.id, index]));
  const taskResultsPath = join(agentDir, 'task-results.json');

  await ensureWaveTaskGraphState(stateStore, taskGraph);
  await appendLog(
    artifactStore,
    runId,
    1,
    'DEVELOPING',
    'parallel wave execution start',
    'PASS',
    `maxParallelWorkers=${maxParallelWorkers}`,
  );
  await emitProgress({
    projectRoot,
    stateStore,
    lastEvent: `Starting worktree-backed wave execution (${maxParallelWorkers} workers)`,
    registry: orchestratorRegistry,
  });

  const trackedFiles = listGitTrackedFiles(projectRoot);
  const startedAtByTask = new Map<string, string>();

  const waveResult = await runWaveExecutorCore({
    tasks,
    trackedFiles,
    maxParallelWorkers,
    onEvent: (event) => {
      // The runner (runTask below) emits task.started/completed/blocked with
      // richer data (worker_branch, error, batch_index). To avoid double
      // emission of task events, this bridge only forwards wave-level
      // lifecycle events. Task-level events come from the runner.
      if (event.type !== 'wave-start' && event.type !== 'wave-finish') return;
      const kind = event.type === 'wave-start' ? 'wave.started' : 'wave.completed';
      void eventBus.emit({
        kind,
        phase: 'DEVELOPING',
        level: 'info',
        message: `wave ${event.waveIndex + 1} ${event.type === 'wave-start' ? 'started' : 'completed'}`,
        wave_index: event.waveIndex,
      }).catch(() => { /* fail-soft */ });
    },
    runTask: async (task, context): Promise<WaveTaskRunnerResult> => {
      const taskIndex = taskIndexById.get(task.id) ?? 0;
      startedAtByTask.set(task.id, new Date().toISOString());
      await updateMainTaskStatus(stateStore, taskGraph, task.id, TaskStatus.RUNNING, 1, taskIndex);
      await emitTaskProgress({
        projectRoot,
        stateStore,
        taskGraph,
        taskIndex,
        taskStatus: 'running',
        lastEvent: `Wave ${context.waveIndex + 1} batch ${context.batchIndex + 1}: starting ${task.id}`,
      });
      const developerAgent = config.agents.developer;
      await eventBus.emit({
        kind: 'task.started',
        phase: 'DEVELOPING',
        level: 'info',
        message: `Wave ${context.waveIndex + 1}: starting ${task.id}`,
        task_id: task.id,
        wave_index: context.waveIndex,
        provider: developerAgent.provider ?? 'claude',
        model: developerAgent.model,
        payload: {
          task_index: taskIndex,
          batch_index: context.batchIndex,
        },
      });

      const result = await runTaskInWorktree({
        projectRoot,
        runId,
        taskGraph,
        task,
        config,
        baseCommit,
        goalDigest,
        maxIterations,
        taskIndex,
        taskTotal: tasks.length,
        combinedSignal,
        slug: task.title,
        mainEventBus: eventBus,
      });

      const status = toTaskStatus(result.status);
      await updateMainTaskStatus(stateStore, taskGraph, task.id, status, 1, taskIndex);
      await emitTaskProgress({
        projectRoot,
        stateStore,
        taskGraph,
        taskIndex,
        taskStatus: status === TaskStatus.PASSED ? 'passed' : 'failed',
        lastEvent: `Wave ${context.waveIndex + 1} batch ${context.batchIndex + 1}: ${task.id} ${status}`,
      });
      await eventBus.emit({
        kind: status === TaskStatus.PASSED ? 'task.completed' : 'task.blocked',
        phase: 'DEVELOPING',
        level: status === TaskStatus.PASSED ? 'info' : 'warn',
        message: `Wave ${context.waveIndex + 1}: ${task.id} ${status}`,
        task_id: task.id,
        wave_index: context.waveIndex,
        status,
        payload: {
          worker_branch: result.branch ?? null,
          error: result.error ?? null,
          worktree_path: result.worktreePath,
        },
      });
      await appendLog(
        artifactStore,
        runId,
        taskIndex + 1,
        'DEVELOPING',
        `wave task ${task.id}`,
        status === TaskStatus.PASSED ? 'PASS' : 'FAIL',
        result.error ?? `branch=${result.branch}`,
      );

      return {
        taskId: result.taskId,
        status,
        error: result.error,
      };
    },
  });

  let taskResults = loadTaskResults(taskResultsPath);
  const resultsByTaskId = new Map(waveResult.results.map((result) => [result.taskId, result]));
  for (const task of tasks) {
    const result = resultsByTaskId.get(task.id);
    if (!result) continue;
    const now = new Date().toISOString();
    const taskResult: TaskResult = {
      task_id: task.id,
      status: result.status,
      attempts: 1,
      started_at: startedAtByTask.get(task.id) ?? now,
      finished_at: now,
      verification_passed: result.status === TaskStatus.PASSED,
      error: result.error,
    };
    taskResults = upsertTaskResult(taskResults, runId, taskResult);
  }
  await writeTaskResults(taskResultsPath, taskResults);
  if (existsSync(taskResultsPath)) {
    orchestratorRegistry.register(taskResultsPath, computeDigest(readFileSync(taskResultsPath, 'utf8')));
  }
  registerDirectoryFiles(join(agentDir, 'task-runs'), orchestratorRegistry);

  const failed = waveResult.results.filter((result) => result.status !== TaskStatus.PASSED);
  if (failed.length > 0) {
    const summary = failed
      .map((result) => `${result.taskId}: ${result.status}${result.error ? ` (${result.error})` : ''}`)
      .join('; ');
    await stateStore.transition(PhaseEnum.BLOCKED);
    await appendLog(artifactStore, runId, tasks.length + 1, 'DEVELOPING', 'parallel wave execution completed', 'BLOCKED', summary);
    return makeBlockedResult(
      runId,
      projectRoot,
      `Parallel wave execution completed with non-passing task(s): ${summary}`,
      'VERIFICATION_FAILED',
      currentBranch,
    );
  }

  await appendLog(
    artifactStore,
    runId,
    tasks.length + 1,
    'DEVELOPING',
    'parallel wave execution completed',
    'PASS',
    'all task branches passed; assembling Phase 8E R1 integration branch',
  );

  const integrationPlan = await buildIntegrationPlan({
    projectRoot,
    runId,
    baseCommit,
    taskGraph,
  });
  const integrationBranch = integrationPlan.integration_branch;
  void eventBus.emit({
    kind: 'integration.started',
    phase: 'DEVELOPING',
    level: 'info',
    message: `Integration phase started for ${integrationBranch}`,
    payload: {
      integration_branch: integrationBranch,
      task_count: integrationPlan.tasks.length,
    },
  }).catch(() => { /* fail-soft */ });
  if (integrationPlan.excluded_tasks.length > 0) {
    const integrationArtifacts = await writeIntegrationPlanEvidence({
      projectRoot,
      plan: integrationPlan,
    });
    const integrationPaths = integrationArtifactPaths(projectRoot);
    writeFileSync(integrationPaths.cherryPickLog, '', 'utf8');
    rmSync(integrationPaths.conflictReport, { force: true });
    integrationArtifacts.push(integrationPaths.cherryPickLog);
    registerDirectoryFiles(integrationArtifactDir(projectRoot), orchestratorRegistry);

    const summary = integrationPlan.excluded_tasks
      .map((task) => `${task.task_id}: ${task.status} (${task.reason})`)
      .join('; ');
    await stateStore.transition(PhaseEnum.BLOCKED);
    await appendLog(
      artifactStore,
      runId,
      tasks.length + 2,
      'DEVELOPING',
      'integration planning',
      'BLOCKED',
      summary,
    );
    await emitProgress({
      projectRoot,
      stateStore,
      lastEvent: 'Integration planning BLOCKED by excluded task-run result(s)',
      registry: orchestratorRegistry,
    });
    void eventBus.emit({
      kind: 'integration.blocked',
      phase: 'DEVELOPING',
      level: 'warn',
      message: 'Integration blocked: excluded task-run result(s)',
      payload: {
        integration_branch: integrationBranch,
        error: 'excluded task-run result(s)',
        reason: 'excluded_tasks',
        excluded_task_count: integrationPlan.excluded_tasks.length,
      },
    }).catch(() => { /* fail-soft */ });
    return makeResult(
      runId,
      PhaseEnum.BLOCKED,
      3,
      currentBranch,
      null,
      uniquePaths([taskResultsPath, join(agentDir, 'task-runs'), integrationArtifactDir(projectRoot), ...integrationArtifacts]),
      'Resolve excluded task-run result(s), then rerun integration',
      `Phase 8E R1 integration BLOCKED because not every task can be safely integrated: ${summary}`,
      {
        code: 'VERIFICATION_FAILED',
        message: `Phase 8E R1 integration BLOCKED because not every task can be safely integrated: ${summary}`,
        resumable: false,
        suggested_action: 'Review .agent/integration/excluded-tasks.md and rerun missing, failed, or blocked tasks before integration.',
      },
      null,
      true,
      null,
      false,
      'Phase 8E R1 integration was blocked before cherry-pick because task-run results were incomplete.',
    );
  }

  const integrationResult = await runIntegrationMerge({
    projectRoot,
    runId,
    baseCommit,
    plan: integrationPlan,
  });
  registerDirectoryFiles(integrationArtifactDir(projectRoot), orchestratorRegistry);

  if (integrationResult.status === 'blocked') {
    await stateStore.update(() => ({ branch: integrationResult.integration_branch }));
    await stateStore.transition(PhaseEnum.BLOCKED);
    await appendLog(
      artifactStore,
      runId,
      tasks.length + 2,
      'DEVELOPING',
      'integration merge',
      'BLOCKED',
      integrationResult.error_message ?? 'integration merge blocked',
    );
    await emitProgress({
      projectRoot,
      stateStore,
      lastEvent: 'Integration merge BLOCKED',
      registry: orchestratorRegistry,
    });
    const message = integrationResult.error_message ?? 'Phase 8E R1 integration merge BLOCKED';
    void eventBus.emit({
      kind: 'integration.blocked',
      phase: 'DEVELOPING',
      level: 'warn',
      message: `Integration merge blocked: ${message}`,
      payload: {
        integration_branch: integrationResult.integration_branch,
        error: message,
        reason: 'merge_blocked',
      },
    }).catch(() => { /* fail-soft */ });
    return makeResult(
      runId,
      PhaseEnum.BLOCKED,
      3,
      integrationResult.integration_branch,
      null,
      uniquePaths([taskResultsPath, join(agentDir, 'task-runs'), integrationArtifactDir(projectRoot), ...integrationResult.artifact_paths]),
      'Resolve integration conflict/precondition, then retry',
      message,
      {
        code: integrationResult.error_code ?? 'VERIFICATION_FAILED',
        message,
        resumable: false,
        suggested_action: 'Review .agent/integration evidence before retrying integration.',
      },
      null,
      true,
      null,
      false,
      'Phase 8E R1 integration was blocked before Final Aggregate Audit or final commit.',
    );
  }

  const integrationAuditResult = await runIntegrationAudit({
    projectRoot,
    agentDir,
    runId,
    baseCommit,
    goalDigest,
    goalFrontMatter: goalFm,
    verificationCommands,
    integrationBranch: integrationResult.integration_branch,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    config,
    combinedSignal,
    iteration: tasks.length + 2,
  });
  return makeResult(
    ...(await mapIntegrationAuditResult({
      projectRoot,
      agentDir,
      runId,
      baseCommit,
      goalDigest,
      stateStore,
      artifactStore,
      orchestratorRegistry,
      taskResultsPath,
      integrationResult,
      integrationAuditResult,
      config,
      noCommit,
      tag,
      iteration: tasks.length + 2,
      eventBus,
    })),
  );
}

async function mapIntegrationAuditResult(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  baseCommit: string;
  goalDigest: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  taskResultsPath: string;
  integrationResult: Awaited<ReturnType<typeof runIntegrationMerge>>;
  integrationAuditResult: Awaited<ReturnType<typeof runIntegrationAudit>>;
  config: ReviewLoopConfig;
  noCommit: boolean;
  tag: boolean;
  iteration: number;
  eventBus: IEventBus;
}): Promise<Parameters<typeof makeResult>> {
  const {
    projectRoot,
    agentDir,
    runId,
    baseCommit,
    goalDigest,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    taskResultsPath,
    integrationResult,
    integrationAuditResult,
    config,
    noCommit,
    tag,
    iteration,
    eventBus,
  } = params;
  registerDirectoryFiles(integrationArtifactDir(projectRoot), orchestratorRegistry);
  const artifactPaths = uniquePaths([
    taskResultsPath,
    join(agentDir, 'task-runs'),
    integrationArtifactDir(projectRoot),
    ...integrationResult.artifact_paths,
    ...integrationAuditResult.artifact_paths,
  ]);

  if (integrationAuditResult.status === 'blocked') {
    const message = integrationAuditResult.error_message ?? 'Phase 8E R2 integrated audit BLOCKED';
    await stateStore.update(() => ({
      branch: integrationAuditResult.integration_branch,
      commit_skipped: true,
      skip_reason: 'Phase 8E R2 blocked before final project commit/tag.',
      tag_name: null,
      tag_created: false,
    }));
    await stateStore.transition(PhaseEnum.BLOCKED);
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'FINALIZING',
      'integration audit',
      'BLOCKED',
      message,
    );
    await emitProgress({
      projectRoot,
      stateStore,
      lastEvent: 'Phase 8E R2 integrated audit BLOCKED',
      registry: orchestratorRegistry,
      finalAuditDecision: integrationAuditResult.audit_decision,
    });
    void eventBus.emit({
      kind: 'integration.blocked',
      phase: 'FINALIZING',
      level: 'warn',
      message: `Integration audit blocked: ${message}`,
      payload: {
        integration_branch: integrationAuditResult.integration_branch,
        error: message,
        reason: 'audit_blocked',
      },
    }).catch(() => { /* fail-soft */ });
    return [
      runId,
      PhaseEnum.BLOCKED,
      3,
      integrationAuditResult.integration_branch,
      integrationAuditResult.audit_decision,
      artifactPaths,
      'Review .agent/integration evidence and resolve the integrated audit blocker',
      message,
      {
        code: integrationAuditResult.error_code ?? 'FINAL_AUDIT_FAILED',
        message,
        resumable: false,
        suggested_action: 'Review .agent/integration evidence and retry after fixing the blocker.',
      },
      null,
      true,
      null,
      false,
      'Phase 8E R2 blocked before final project commit/tag.',
    ];
  }

  // R2 PASS → run Phase 8E R3 finalization (commit/tag). R3 owns the
  // FINALIZING → PASSED/BLOCKED transition; the wave loop only maps the result.
  const finalization = await runIntegrationFinalization({
    projectRoot,
    agentDir,
    runId,
    baseCommit,
    goalDigest,
    integrationBranch: integrationAuditResult.integration_branch,
    iteration,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    config,
    tag,
    noCommit,
  });

  registerDirectoryFiles(integrationArtifactDir(projectRoot), orchestratorRegistry);

  if (finalization.status === 'blocked') {
    const message = finalization.error_message ?? 'Phase 8E R3 finalization BLOCKED';
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'FINALIZING',
      'integration finalization',
      'BLOCKED',
      message,
    );
    await emitProgress({
      projectRoot,
      stateStore,
      lastEvent: 'Phase 8E R3 finalization BLOCKED',
      registry: orchestratorRegistry,
      finalAuditDecision: 'PASS',
    });
    void eventBus.emit({
      kind: 'integration.blocked',
      phase: 'FINALIZING',
      level: 'warn',
      message: `Integration finalization blocked: ${message}`,
      payload: {
        integration_branch: integrationAuditResult.integration_branch,
        error: message,
        reason: 'finalization_blocked',
      },
    }).catch(() => { /* fail-soft */ });
    return [
      runId,
      PhaseEnum.BLOCKED,
      3,
      integrationAuditResult.integration_branch,
      'PASS',
      uniquePaths([...artifactPaths, ...finalization.artifact_paths]),
      'Resolve Phase 8E R3 finalization blocker, then resume',
      message,
      {
        code: finalization.error_code ?? 'GIT_COMMIT_ERROR',
        message,
        resumable: true,
        suggested_action: 'Review .agent/integration evidence and retry Phase 8E R3 finalization.',
      },
      finalization.final_commit_sha,
      false,
      finalization.tag_name,
      finalization.tag_created,
      null,
    ];
  }

  await emitProgress({
    projectRoot,
    stateStore,
    lastEvent: `Phase 8E R3 finalization PASSED: ${integrationAuditResult.integration_branch}`,
    registry: orchestratorRegistry,
    commitSha: finalization.final_commit_sha,
    finalAuditDecision: 'PASS',
  });

  void eventBus.emit({
    kind: 'integration.completed',
    phase: 'FINALIZING',
    level: 'info',
    message: `Integration completed on ${integrationAuditResult.integration_branch}`,
    payload: {
      integration_branch: integrationAuditResult.integration_branch,
    },
  }).catch(() => { /* fail-soft */ });

  return [
    runId,
    PhaseEnum.PASSED,
    0,
    integrationAuditResult.integration_branch,
    'PASS',
    uniquePaths([...artifactPaths, ...finalization.artifact_paths]),
    `Phase 8E R3 finalized integration branch ${integrationAuditResult.integration_branch}`,
    `Parallel wave task execution PASSED. Phase 8E R2 verified and Final Aggregate Audited; Phase 8E R3 created the final project commit ${finalization.final_commit_sha?.slice(0, 8) ?? ''} on ${integrationAuditResult.integration_branch}.`,
    null,
    finalization.final_commit_sha,
    finalization.commit_skipped,
    finalization.tag_name,
    finalization.tag_created,
    finalization.skip_reason,
  ];
}

async function ensureWaveTaskGraphState(
  stateStore: StateStore,
  taskGraph: TaskGraph,
): Promise<void> {
  const state = await stateStore.read();
  if (state.task_graph_state) return;
  await stateStore.update(() => ({
    task_graph_state: {
      current_task_index: 0,
      task_statuses: initialTaskStatuses(taskGraph),
      task_attempts: initialTaskAttempts(taskGraph),
    } as TaskGraphState,
  }));
}

async function updateMainTaskStatus(
  stateStore: StateStore,
  taskGraph: TaskGraph,
  taskId: string,
  status: TaskStatus,
  attempts: number,
  taskIndex: number,
): Promise<void> {
  await stateStore.update((state) => {
    const current = state.task_graph_state ?? {
      current_task_index: taskIndex,
      task_statuses: initialTaskStatuses(taskGraph),
      task_attempts: initialTaskAttempts(taskGraph),
    };
    return {
      task_graph_state: {
        ...current,
        current_task_index: taskIndex,
        task_statuses: {
          ...current.task_statuses,
          [taskId]: status,
        },
        task_attempts: {
          ...current.task_attempts,
          [taskId]: attempts,
        },
      },
    };
  });
}

function toTaskStatus(status: string): WaveTerminalTaskStatus {
  if (status === TaskStatus.PASSED) return TaskStatus.PASSED;
  if (status === TaskStatus.BLOCKED) return TaskStatus.BLOCKED;
  return TaskStatus.FAILED;
}

function listGitTrackedFiles(projectRoot: string): string[] {
  try {
    return execSync('git ls-files -z', { cwd: projectRoot, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .map((filePath) => filePath.split('\\').join('/'));
  } catch {
    return [];
  }
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}
