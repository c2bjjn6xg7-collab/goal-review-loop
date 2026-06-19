/**
 * Task-run result handoff storage (Phase 8D P8).
 *
 * Provides a small, orchestration-neutral file API so future worktree workers
 * can write `.agent/task-runs/{task_id}/result.json` back to the main
 * scheduler. This module performs only path validation, atomic writes, and
 * structured reads — no scheduler/wave-executor wiring.
 */
import fs from 'fs-extra';
import path from 'node:path';
import { atomicWriteJSON } from '../runtime/atomic-file.js';

export type TaskRunResultStatus = 'passed' | 'failed' | 'blocked';

export interface TaskRunResult {
  schema_version: 1;
  run_id: string;
  task_id: string;
  status: TaskRunResultStatus;
  exit_code: number | null;
  final_commit_sha: string | null;
  diff_digest: string | null;
  branch: string | null;
  error: string | null;
  finished_at: string;
}

export interface MissingTaskRunResult {
  found: false;
  path: string;
  error: null;
}

export interface FoundTaskRunResult {
  found: true;
  path: string;
  result: TaskRunResult;
}

export interface InvalidTaskRunResult {
  found: false;
  path: string;
  error: TaskRunResultError;
}

export type ReadTaskRunResultOutcome =
  | MissingTaskRunResult
  | FoundTaskRunResult
  | InvalidTaskRunResult;

export type TaskRunResultErrorCode =
  | 'invalid-task-id'
  | 'invalid-result-json'
  | 'result-run-id-mismatch'
  | 'result-task-id-mismatch';

export class TaskRunResultError extends Error {
  public readonly code: TaskRunResultErrorCode;

  constructor(code: TaskRunResultErrorCode, message: string) {
    super(message);
    this.name = 'TaskRunResultError';
    this.code = code;
  }
}

const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Reject task IDs that could escape the `.agent/task-runs/` sandbox or contain
 * filesystem separators. This must run before any path construction or
 * filesystem call.
 */
function assertSafeTaskId(taskId: string): void {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TaskRunResultError('invalid-task-id', 'task_id must be a non-empty string');
  }
  if (taskId === '.' || taskId === '..') {
    throw new TaskRunResultError('invalid-task-id', `task_id "${taskId}" is not allowed`);
  }
  if (!SAFE_TASK_ID_PATTERN.test(taskId)) {
    throw new TaskRunResultError(
      'invalid-task-id',
      `task_id "${taskId}" must match /^[A-Za-z0-9._-]+$/`,
    );
  }
}

/**
 * Build the absolute on-disk path for a task's result.json under the
 * project's `.agent/task-runs/<taskId>/result.json`.
 */
export function taskRunResultPath(projectRoot: string, taskId: string): string {
  assertSafeTaskId(taskId);
  return path.join(projectRoot, '.agent', 'task-runs', taskId, 'result.json');
}

/**
 * Write a task-run result atomically. Returns the absolute path written.
 * Validates the embedded `task_id` so callers cannot smuggle traversal IDs
 * through the result body.
 */
export async function writeTaskRunResult(
  projectRoot: string,
  result: TaskRunResult,
): Promise<string> {
  assertSafeTaskId(result.task_id);
  const target = taskRunResultPath(projectRoot, result.task_id);
  await atomicWriteJSON(target, result);
  return target;
}

const VALID_STATUSES: ReadonlySet<TaskRunResultStatus> = new Set([
  'passed',
  'failed',
  'blocked',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Validate a parsed JSON body against the TaskRunResult contract. Returns the
 * narrowed value on success or a `TaskRunResultError('invalid-result-json')`
 * with a readable reason on failure.
 */
function validateTaskRunResult(value: unknown): TaskRunResult | TaskRunResultError {
  if (!isPlainObject(value)) {
    return new TaskRunResultError(
      'invalid-result-json',
      'result must be a JSON object',
    );
  }

  if (value.schema_version !== 1) {
    return new TaskRunResultError(
      'invalid-result-json',
      `schema_version must be 1, got ${JSON.stringify(value.schema_version)}`,
    );
  }
  if (typeof value.run_id !== 'string' || value.run_id.length === 0) {
    return new TaskRunResultError(
      'invalid-result-json',
      'run_id must be a non-empty string',
    );
  }
  if (typeof value.task_id !== 'string' || value.task_id.length === 0) {
    return new TaskRunResultError(
      'invalid-result-json',
      'task_id must be a non-empty string',
    );
  }
  if (
    typeof value.status !== 'string' ||
    !VALID_STATUSES.has(value.status as TaskRunResultStatus)
  ) {
    return new TaskRunResultError(
      'invalid-result-json',
      `status must be one of ${Array.from(VALID_STATUSES).join(', ')}, got ${JSON.stringify(
        value.status,
      )}`,
    );
  }
  if (!(value.exit_code === null || typeof value.exit_code === 'number')) {
    return new TaskRunResultError(
      'invalid-result-json',
      'exit_code must be a number or null',
    );
  }
  if (!isStringOrNull(value.final_commit_sha)) {
    return new TaskRunResultError(
      'invalid-result-json',
      'final_commit_sha must be a string or null',
    );
  }
  if (!isStringOrNull(value.diff_digest)) {
    return new TaskRunResultError(
      'invalid-result-json',
      'diff_digest must be a string or null',
    );
  }
  if (!isStringOrNull(value.branch)) {
    return new TaskRunResultError(
      'invalid-result-json',
      'branch must be a string or null',
    );
  }
  if (!isStringOrNull(value.error)) {
    return new TaskRunResultError(
      'invalid-result-json',
      'error must be a string or null',
    );
  }
  if (typeof value.finished_at !== 'string' || value.finished_at.length === 0) {
    return new TaskRunResultError(
      'invalid-result-json',
      'finished_at must be a non-empty string',
    );
  }

  return {
    schema_version: 1,
    run_id: value.run_id,
    task_id: value.task_id,
    status: value.status as TaskRunResultStatus,
    exit_code: value.exit_code as number | null,
    final_commit_sha: value.final_commit_sha as string | null,
    diff_digest: value.diff_digest as string | null,
    branch: value.branch as string | null,
    error: value.error as string | null,
    finished_at: value.finished_at,
  };
}

/**
 * Read a task-run result file and classify its outcome:
 *   - `found:true`   — file present, valid, and IDs match the request.
 *   - `found:false, error:null`     — file does not exist.
 *   - `found:false, error.code:...` — file present but malformed, invalid,
 *      or has mismatched run/task identifiers.
 */
export async function readTaskRunResult(
  projectRoot: string,
  runId: string,
  taskId: string,
): Promise<ReadTaskRunResultOutcome> {
  assertSafeTaskId(taskId);
  const target = taskRunResultPath(projectRoot, taskId);

  const exists = await fs.pathExists(target);
  if (!exists) {
    return { found: false, path: target, error: null };
  }

  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    return {
      found: false,
      path: target,
      error: new TaskRunResultError(
        'invalid-result-json',
        `failed to read result file: ${(err as Error).message}`,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      found: false,
      path: target,
      error: new TaskRunResultError(
        'invalid-result-json',
        `result is not valid JSON: ${(err as Error).message}`,
      ),
    };
  }

  const validated = validateTaskRunResult(parsed);
  if (validated instanceof TaskRunResultError) {
    return { found: false, path: target, error: validated };
  }

  if (validated.task_id !== taskId) {
    return {
      found: false,
      path: target,
      error: new TaskRunResultError(
        'result-task-id-mismatch',
        `stored task_id "${validated.task_id}" does not match requested task_id "${taskId}"`,
      ),
    };
  }
  if (validated.run_id !== runId) {
    return {
      found: false,
      path: target,
      error: new TaskRunResultError(
        'result-run-id-mismatch',
        `stored run_id "${validated.run_id}" does not match requested run_id "${runId}"`,
      ),
    };
  }

  return { found: true, path: target, result: validated };
}
