/**
 * Unit tests for the task-run result handoff storage module
 * (Phase 8D P8).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readTaskRunResult,
  taskRunResultPath,
  TaskRunResultError,
  writeTaskRunResult,
  type TaskRunResult,
} from '../../src/scheduler/task-run-result.js';

function makeProjectRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'task-run-result-'));
}

function makeResult(overrides: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    schema_version: 1,
    run_id: 'run-1',
    task_id: 'task-1',
    status: 'passed',
    exit_code: 0,
    final_commit_sha: 'abc123',
    diff_digest: 'sha256:abc',
    branch: 'agent/run-1/task-1-demo',
    error: null,
    finished_at: '2026-06-19T12:00:00.000Z',
    ...overrides,
  };
}

describe('taskRunResultPath', () => {
  it('builds the expected result.json path for a safe task id', () => {
    const root = makeProjectRoot();
    expect(taskRunResultPath(root, 'task-1')).toBe(
      path.join(root, '.agent', 'task-runs', 'task-1', 'result.json'),
    );
  });

  it('accepts dotted, underscored, and dashed task ids', () => {
    const root = makeProjectRoot();
    expect(taskRunResultPath(root, 'core_result.api-1')).toBe(
      path.join(root, '.agent', 'task-runs', 'core_result.api-1', 'result.json'),
    );
  });

  it('rejects every variant of unsafe task id with code "invalid-task-id"', () => {
    const root = makeProjectRoot();
    const unsafe = [
      '',
      '../x',
      '../../escape',
      'a/b',
      'a\\b',
      '.',
      '..',
      'task id',
      'tas$k',
      'task:1',
      'task\n1',
      'task' + String.fromCharCode(0),
      'café',
    ];
    for (const bad of unsafe) {
      try {
        taskRunResultPath(root, bad);
        throw new Error(`expected throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err, `case ${JSON.stringify(bad)}`).toBeInstanceOf(TaskRunResultError);
        expect((err as TaskRunResultError).code, `case ${JSON.stringify(bad)}`).toBe(
          'invalid-task-id',
        );
      }
    }
  });

  it('refuses non-string task ids defensively', () => {
    const root = makeProjectRoot();
    for (const bad of [undefined, null, 123, {}, []] as unknown[]) {
      expect(() => taskRunResultPath(root, bad as string)).toThrow(TaskRunResultError);
    }
  });
});

describe('writeTaskRunResult', () => {
  it('writes and reads a valid result atomically', async () => {
    const root = makeProjectRoot();
    const writtenPath = await writeTaskRunResult(root, makeResult());
    expect(writtenPath).toBe(taskRunResultPath(root, 'task-1'));
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(true);
    if (outcome.found) {
      expect(outcome.result).toEqual(makeResult());
      expect(outcome.path).toBe(writtenPath);
    }
  });

  it('rejects writing a result with an unsafe task_id and writes nothing to disk', async () => {
    const root = makeProjectRoot();
    let caught: unknown;
    try {
      await writeTaskRunResult(root, makeResult({ task_id: '../escape' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TaskRunResultError);
    expect((caught as TaskRunResultError).code).toBe('invalid-task-id');
    // No filesystem mutation should have happened — the .agent/task-runs dir
    // must not exist after a rejected write.
    expect(await fs.pathExists(path.join(root, '.agent', 'task-runs'))).toBe(false);
  });
});

describe('readTaskRunResult', () => {
  it('returns found:false with error:null for a missing result file', async () => {
    const root = makeProjectRoot();
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.error).toBeNull();
      expect(outcome.path).toBe(taskRunResultPath(root, 'task-1'));
    }
  });

  it('returns invalid-result-json for malformed JSON', async () => {
    const root = makeProjectRoot();
    const target = taskRunResultPath(root, 'task-1');
    await fs.outputFile(target, '{not valid json');
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.error).toBeInstanceOf(TaskRunResultError);
      expect(outcome.error?.code).toBe('invalid-result-json');
    }
  });

  it('returns invalid-result-json for an invalid status value', async () => {
    const root = makeProjectRoot();
    await writeTaskRunResult(root, makeResult());
    const target = taskRunResultPath(root, 'task-1');
    await fs.outputJson(target, { ...makeResult(), status: 'unknown-status' });
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.error).toBeInstanceOf(TaskRunResultError);
      expect(outcome.error?.code).toBe('invalid-result-json');
    }
  });

  it('returns invalid-result-json for an unsupported schema_version', async () => {
    const root = makeProjectRoot();
    const target = taskRunResultPath(root, 'task-1');
    await fs.outputJson(target, { ...makeResult(), schema_version: 2 });
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.error?.code).toBe('invalid-result-json');
    }
  });

  it('returns invalid-result-json when a required field has the wrong type', async () => {
    const root = makeProjectRoot();
    const target = taskRunResultPath(root, 'task-1');
    await fs.outputJson(target, { ...makeResult(), exit_code: 'oops' });
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.error?.code).toBe('invalid-result-json');
    }
  });

  it.each([
    ['root is an array', () => [makeResult()] as unknown],
    ['root is null', () => null as unknown],
    ['root is a string', () => 'not an object' as unknown],
    ['missing run_id', () => ({ ...makeResult(), run_id: undefined })],
    ['empty run_id', () => ({ ...makeResult(), run_id: '' })],
    ['missing task_id', () => ({ ...makeResult(), task_id: undefined })],
    ['numeric task_id', () => ({ ...makeResult(), task_id: 42 })],
    ['empty finished_at', () => ({ ...makeResult(), finished_at: '' })],
    ['missing finished_at', () => ({ ...makeResult(), finished_at: undefined })],
    ['final_commit_sha number', () => ({ ...makeResult(), final_commit_sha: 0 })],
    ['diff_digest number', () => ({ ...makeResult(), diff_digest: 0 })],
    ['branch number', () => ({ ...makeResult(), branch: 0 })],
    ['error number', () => ({ ...makeResult(), error: 0 })],
    ['status uppercase', () => ({ ...makeResult(), status: 'Passed' })],
    ['status null', () => ({ ...makeResult(), status: null })],
  ])(
    'returns invalid-result-json when %s',
    async (_label, build) => {
      const root = makeProjectRoot();
      const target = taskRunResultPath(root, 'task-1');
      await fs.outputJson(target, build());
      const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
      expect(outcome.found).toBe(false);
      if (!outcome.found) {
        expect(outcome.error).toBeInstanceOf(TaskRunResultError);
        expect(outcome.error?.code).toBe('invalid-result-json');
        expect(outcome.path).toBe(target);
      }
    },
  );

  it('returns result-run-id-mismatch when the stored run id does not match', async () => {
    const root = makeProjectRoot();
    await writeTaskRunResult(root, makeResult({ run_id: 'run-other' }));
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.error).toBeInstanceOf(TaskRunResultError);
      expect(outcome.error?.code).toBe('result-run-id-mismatch');
    }
  });

  it('returns result-task-id-mismatch when the stored task id does not match', async () => {
    const root = makeProjectRoot();
    const target = taskRunResultPath(root, 'task-1');
    // Write a JSON body whose task_id does not match the file location.
    await fs.outputJson(target, makeResult({ task_id: 'task-other' }));
    const outcome = await readTaskRunResult(root, 'run-1', 'task-1');
    expect(outcome.found).toBe(false);
    if (!outcome.found) {
      expect(outcome.error).toBeInstanceOf(TaskRunResultError);
      expect(outcome.error?.code).toBe('result-task-id-mismatch');
    }
  });

  it('rejects unsafe task ids before touching the filesystem', async () => {
    const root = makeProjectRoot();
    for (const bad of ['', '../x', 'a/b', 'a\\b', '.', '..', 'task id']) {
      let caught: unknown;
      try {
        await readTaskRunResult(root, 'run-1', bad);
      } catch (err) {
        caught = err;
      }
      expect(caught, `case ${JSON.stringify(bad)}`).toBeInstanceOf(TaskRunResultError);
      expect((caught as TaskRunResultError).code, `case ${JSON.stringify(bad)}`).toBe(
        'invalid-task-id',
      );
    }
    // Reading should not have created any artefacts.
    expect(await fs.pathExists(path.join(root, '.agent', 'task-runs'))).toBe(false);
  });
});
