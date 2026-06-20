import path from 'node:path';
import fs from 'fs-extra';
import { computeDigest } from '../runtime/digest.js';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import { runGit } from '../git/git-manager.js';
import { writeTaskRunResult, type TaskRunResultStatus } from '../scheduler/task-run-result.js';
import { initialTaskAttempts, initialTaskStatuses, orderedTasks } from '../scheduler/task-graph.js';
import { WorktreeManager } from '../scheduler/worktree-manager.js';
import { StateStore } from './state-store.js';
import {
  parseGoalSuccessCriteria,
  runTaskGraphTaskSerial,
} from './task-graph-loop.js';
import {
  OrchestratorFileRegistry,
  registerDirectoryFiles,
} from './run-orchestrator.js';
import {
  Phase as PhaseEnum,
  TaskStatus,
  type ReviewLoopConfig,
  type TaskGraph,
  type TaskGraphState,
  type TaskNode,
} from '../types.js';

export interface RunTaskInWorktreeParams {
  projectRoot: string;
  runId: string;
  taskGraph: TaskGraph;
  task: TaskNode;
  config: ReviewLoopConfig;
  baseCommit?: string;
  goalDigest?: string;
  maxIterations?: number;
  taskIndex?: number;
  taskTotal?: number;
  combinedSignal?: AbortSignal;
  slug?: string;
}

export interface RunTaskInWorktreeResult {
  taskId: string;
  status: TaskRunResultStatus;
  error: string | null;
  branch: string;
  worktreePath: string;
  finalCommitSha: string | null;
  diffDigest: string | null;
  resultPath: string;
}

interface GitStatusEntry {
  xy: string;
  path: string;
  originalPath: string | null;
}

interface CommitTaskChangesResult {
  finalCommitSha: string;
  diffDigest: string | null;
}

export async function runTaskInWorktree(
  params: RunTaskInWorktreeParams,
): Promise<RunTaskInWorktreeResult> {
  const projectRoot = path.resolve(params.projectRoot);
  const baseCommit = params.baseCommit ?? await readGitStdout(
    projectRoot,
    ['rev-parse', '--verify', 'HEAD'],
    'resolve base commit',
  );
  const ordered = orderedTasks(params.taskGraph);
  const discoveredTaskIndex = ordered.findIndex((task) => task.id === params.task.id);
  const taskIndex = params.taskIndex ?? (discoveredTaskIndex >= 0 ? discoveredTaskIndex : 0);
  const taskTotal = params.taskTotal ?? (ordered.length > 0 ? ordered.length : 1);
  const maxIterations = params.maxIterations ?? params.config.loop.max_iterations;
  const combinedSignal = params.combinedSignal ?? new AbortController().signal;
  const goalDigest = params.goalDigest ?? params.taskGraph.goal_digest;
  const slug = params.slug ?? params.task.title;

  const worktree = await new WorktreeManager(projectRoot).createForTask({
    runId: params.runId,
    taskId: params.task.id,
    slug,
    baseCommit,
  });

  const workerProjectRoot = worktree.worktreePath;
  const workerArtifactStore = new ArtifactStore(workerProjectRoot);
  await workerArtifactStore.init();
  const workerAgentDir = workerArtifactStore.agentDir;
  const workerStateStore = new StateStore(workerAgentDir);
  const workerRegistry = new OrchestratorFileRegistry();

  await copySchedulerArtifacts(projectRoot, workerProjectRoot, params.taskGraph);

  await bootstrapWorkerState({
    stateStore: workerStateStore,
    runId: params.runId,
    task: params.task,
    taskGraph: params.taskGraph,
    taskIndex,
    workerProjectRoot,
    baseCommit,
    branch: worktree.branch,
    maxIterations,
    goalDigest,
  });
  registerDirectoryFiles(workerAgentDir, workerRegistry);

  const goalPath = path.join(workerAgentDir, 'GOAL.md');
  const handoffPath = path.join(workerAgentDir, 'developer-handoff.md');
  const goalSuccessCriteria = parseGoalSuccessCriteria(goalPath);

  let status: TaskRunResultStatus = 'failed';
  let error: string | null = null;
  let finalCommitSha: string | null = null;
  let diffDigest: string | null = null;

  try {
    const tgState = await readRequiredTaskGraphState(workerStateStore);
    const taskExecution = await runTaskGraphTaskSerial({
      projectRoot: workerProjectRoot,
      agentDir: workerAgentDir,
      runId: params.runId,
      stateStore: workerStateStore,
      artifactStore: workerArtifactStore,
      orchestratorRegistry: workerRegistry,
      config: params.config,
      currentBranch: worktree.branch,
      baseCommit,
      taskGraph: params.taskGraph,
      task: params.task,
      taskIndex,
      taskTotal,
      tgState,
      maxIterations,
      combinedSignal,
      goalPath,
      handoffPath,
      goalSuccessCriteria,
    });

    if (taskExecution.terminalResult) {
      status = taskExecution.terminalResult.phase === PhaseEnum.BLOCKED ? 'blocked' : 'failed';
      error = taskExecution.error ?? taskExecution.terminalResult.message;
    } else if (taskExecution.passed) {
      const commit = await commitTaskChanges(workerProjectRoot, params.task);
      status = 'passed';
      error = null;
      finalCommitSha = commit.finalCommitSha;
      diffDigest = commit.diffDigest;
    } else {
      status = 'failed';
      error = taskExecution.error ?? 'Task failed';
    }
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  await updateWorkerTaskStatus(workerStateStore, params.task.id, status);

  const resultPath = await writeTaskRunResult(projectRoot, {
    schema_version: 1,
    run_id: params.runId,
    task_id: params.task.id,
    status,
    exit_code: status === 'passed' ? 0 : status === 'blocked' ? 3 : 1,
    final_commit_sha: finalCommitSha,
    diff_digest: diffDigest,
    branch: worktree.branch,
    error,
    finished_at: new Date().toISOString(),
  });

  return {
    taskId: params.task.id,
    status,
    error,
    branch: worktree.branch,
    worktreePath: workerProjectRoot,
    finalCommitSha,
    diffDigest,
    resultPath,
  };
}

async function copySchedulerArtifacts(
  projectRoot: string,
  workerProjectRoot: string,
  taskGraph: TaskGraph,
): Promise<void> {
  const schedulerAgentDir = path.join(projectRoot, '.agent');
  const workerAgentDir = path.join(workerProjectRoot, '.agent');
  const schedulerGoalPath = path.join(schedulerAgentDir, 'GOAL.md');
  const workerGoalPath = path.join(workerAgentDir, 'GOAL.md');
  const schedulerTaskGraphPath = path.join(schedulerAgentDir, 'task-graph.json');
  const workerTaskGraphPath = path.join(workerAgentDir, 'task-graph.json');

  if (!(await fs.pathExists(schedulerGoalPath))) {
    throw new Error(`Scheduler GOAL.md not found at ${schedulerGoalPath}`);
  }
  await fs.copy(schedulerGoalPath, workerGoalPath);

  if (await fs.pathExists(schedulerTaskGraphPath)) {
    await fs.copy(schedulerTaskGraphPath, workerTaskGraphPath);
  } else {
    await fs.writeJson(workerTaskGraphPath, taskGraph, { spaces: 2 });
  }
}

async function bootstrapWorkerState(params: {
  stateStore: StateStore;
  runId: string;
  task: TaskNode;
  taskGraph: TaskGraph;
  taskIndex: number;
  workerProjectRoot: string;
  baseCommit: string;
  branch: string;
  maxIterations: number;
  goalDigest: string;
}): Promise<void> {
  const taskGraphState = buildWorkerTaskGraphState(
    params.taskGraph,
    params.task.id,
    params.taskIndex,
  );

  if (!(await params.stateStore.exists())) {
    await params.stateStore.create({
      run_id: params.runId,
      task_slug: params.task.id,
      project_root: params.workerProjectRoot,
      base_commit: params.baseCommit,
      branch: params.branch,
      max_iterations: params.maxIterations,
    });
    await params.stateStore.transition(PhaseEnum.PLANNING);
    await params.stateStore.update(() => ({
      iteration: params.taskIndex + 1,
      goal_digest: params.goalDigest,
      task_graph_state: taskGraphState,
    }));
    await params.stateStore.transition(PhaseEnum.DEVELOPING);
    return;
  }

  const existing = await params.stateStore.read();
  await params.stateStore.update(() => ({
    iteration: params.taskIndex + 1,
    goal_digest: params.goalDigest,
    task_graph_state: taskGraphState,
  }));

  if (existing.phase === PhaseEnum.INITIALIZING) {
    await params.stateStore.transition(PhaseEnum.PLANNING);
    await params.stateStore.transition(PhaseEnum.DEVELOPING);
  } else if (existing.phase === PhaseEnum.PLANNING || existing.phase === PhaseEnum.REWORKING) {
    await params.stateStore.transition(PhaseEnum.DEVELOPING);
  } else if (existing.phase !== PhaseEnum.DEVELOPING) {
    throw new Error(`Worker state is in ${existing.phase}; cannot legally enter DEVELOPING`);
  }
}

function buildWorkerTaskGraphState(
  taskGraph: TaskGraph,
  taskId: string,
  taskIndex: number,
): TaskGraphState {
  return {
    current_task_index: taskIndex,
    task_statuses: {
      ...initialTaskStatuses(taskGraph),
      [taskId]: TaskStatus.RUNNING,
    },
    task_attempts: initialTaskAttempts(taskGraph),
  };
}

async function readRequiredTaskGraphState(stateStore: StateStore): Promise<TaskGraphState> {
  const state = await stateStore.read();
  if (!state.task_graph_state) {
    throw new Error('Worker state is missing task_graph_state');
  }
  return state.task_graph_state;
}

async function updateWorkerTaskStatus(
  stateStore: StateStore,
  taskId: string,
  status: TaskRunResultStatus,
): Promise<void> {
  const taskStatus = status === 'passed'
    ? TaskStatus.PASSED
    : status === 'blocked'
      ? TaskStatus.BLOCKED
      : TaskStatus.FAILED;
  await stateStore.update((state) => {
    if (!state.task_graph_state) return {};
    return {
      task_graph_state: {
        ...state.task_graph_state,
        task_statuses: {
          ...state.task_graph_state.task_statuses,
          [taskId]: taskStatus,
        },
      },
    };
  });
}

async function commitTaskChanges(
  worktreePath: string,
  task: TaskNode,
): Promise<CommitTaskChangesResult> {
  const statusResult = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    worktreePath,
  );
  assertGitOk(statusResult, 'git status');

  const entries = parseGitStatusPorcelainZ(statusResult.stdout);
  const pathsToStage = businessPathsFromStatus(entries);

  if (pathsToStage.length === 0) {
    return {
      finalCommitSha: await readGitStdout(worktreePath, ['rev-parse', '--verify', 'HEAD'], 'read HEAD'),
      diffDigest: null,
    };
  }

  const addResult = await runGit(['add', '--', ...pathsToStage], worktreePath);
  assertGitOk(addResult, 'git add explicit task paths');

  const diffCheck = await runGit(['diff', '--cached', '--quiet', '--', ...pathsToStage], worktreePath);
  if (diffCheck.exit_code === 0) {
    return {
      finalCommitSha: await readGitStdout(worktreePath, ['rev-parse', '--verify', 'HEAD'], 'read HEAD'),
      diffDigest: null,
    };
  }
  if (diffCheck.exit_code !== 1) {
    throw new Error(`git diff --cached --quiet failed: ${diffCheck.stderr || diffCheck.stdout}`);
  }

  const diffResult = await runGit(['diff', '--cached', '--binary', '--', ...pathsToStage], worktreePath);
  assertGitOk(diffResult, 'git diff --cached');
  const diffDigest = diffResult.stdout.length > 0 ? computeDigest(diffResult.stdout) : null;

  const commitMessage = `Task ${task.id}: ${task.title}`;
  const commitResult = await runGit(['commit', '-m', commitMessage, '--', ...pathsToStage], worktreePath);
  assertGitOk(commitResult, 'git commit task changes');

  return {
    finalCommitSha: await readGitStdout(worktreePath, ['rev-parse', '--verify', 'HEAD'], 'read HEAD'),
    diffDigest,
  };
}

function parseGitStatusPorcelainZ(output: string): GitStatusEntry[] {
  const parts = output.split('\0').filter((part) => part.length > 0);
  const entries: GitStatusEntry[] = [];

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (record.length < 4) continue;

    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    let originalPath: string | null = null;
    if (xy.includes('R') || xy.includes('C')) {
      originalPath = parts[i + 1] ?? null;
      i += 1;
    }

    entries.push({ xy, path: filePath, originalPath });
  }

  return entries;
}

function businessPathsFromStatus(entries: GitStatusEntry[]): string[] {
  const paths = new Set<string>();

  for (const entry of entries) {
    addBusinessPath(paths, entry.path);
    if (entry.originalPath) addBusinessPath(paths, entry.originalPath);
  }

  return Array.from(paths).sort();
}

function addBusinessPath(paths: Set<string>, filePath: string): void {
  const normalized = normalizeGitPath(filePath);
  if (!isAgentPath(normalized)) {
    paths.add(normalized);
  }
}

function isAgentPath(filePath: string): boolean {
  return filePath === '.agent' || filePath.startsWith('.agent/');
}

function normalizeGitPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

async function readGitStdout(
  cwd: string,
  args: string[],
  label: string,
): Promise<string> {
  const result = await runGit(args, cwd);
  assertGitOk(result, label);
  return result.stdout;
}

function assertGitOk(
  result: { stdout: string; stderr: string; exit_code: number },
  label: string,
): void {
  if (result.exit_code !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.exit_code}`}`);
  }
}
