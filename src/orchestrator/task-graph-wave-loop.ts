import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import {
  runWaveExecutorCore,
  type WaveTaskRunnerResult,
  type WaveTerminalTaskStatus,
} from '../scheduler/wave-executor.js';
import { orderedTasks, initialTaskAttempts, initialTaskStatuses } from '../scheduler/task-graph.js';
import { runTaskInWorktree } from './task-graph-worktree-runner.js';
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
  computeDigest,
  registerDirectoryFiles,
} from './run-orchestrator.js';
import {
  Phase as PhaseEnum,
  TaskStatus,
  type ReviewLoopConfig,
  type TaskGraph,
  type TaskGraphState,
  type TaskResult,
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
  taskGraph: TaskGraph;
  maxIterations: number;
  maxParallelWorkers: number;
  combinedSignal: AbortSignal;
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
    taskGraph,
    maxIterations,
    maxParallelWorkers,
    combinedSignal,
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
    'all task branches passed; Phase 8D does not merge or finalize',
  );
  await stateStore.transition(PhaseEnum.VERIFYING);
  await stateStore.transition(PhaseEnum.AUDITING);
  await stateStore.transition(PhaseEnum.FINALIZING);
  await stateStore.transition(PhaseEnum.PASSED);
  await emitProgress({
    projectRoot,
    stateStore,
    lastEvent: 'Parallel wave execution PASSED (Phase 8D: no merge/finalization)',
    registry: orchestratorRegistry,
  });

  const message = 'Parallel wave task execution PASSED. Phase 8D recorded task branches and task-run artifacts only; merge, integration verification, and Final Aggregate Audit are owned by Phase 8E.';
  return {
    run_id: runId,
    phase: PhaseEnum.PASSED,
    exit_code: 0,
    branch: currentBranch,
    audit_decision: null,
    artifact_paths: [taskResultsPath, join(agentDir, 'task-runs')],
    next_action: 'Proceed to Phase 8E integration merge when ready',
    message,
    error: null,
    commit_sha: null,
    commit_skipped: true,
    tag_name: null,
    tag_created: false,
    skip_reason: 'Phase 8D wave mode does not merge task branches, run Final Aggregate Audit, or create a final commit.',
  };
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
