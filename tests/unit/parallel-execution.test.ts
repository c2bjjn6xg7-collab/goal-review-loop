import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/artifacts/config.js';
import {
  ParallelExecutionConfigError,
  resolveParallelExecution,
} from '../../src/scheduler/parallel-execution.js';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import type { ReviewLoopConfig } from '../../src/types.js';

function cfg(parallel: ReviewLoopConfig['parallel']): ReviewLoopConfig {
  return { ...DEFAULT_CONFIG, parallel };
}

describe('resolveParallelExecution', () => {
  it('defaults to serial with one worker when parallel config is absent', () => {
    const config = { ...DEFAULT_CONFIG, parallel: undefined };
    expect(resolveParallelExecution(config)).toEqual({
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'default',
      reason: 'parallel execution disabled',
    });
  });

  it('does not enable parallelism from max_parallel_workers alone', () => {
    expect(resolveParallelExecution(cfg({ enabled: false, max_parallel_workers: 4 }))).toEqual({
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'config',
      reason: 'parallel execution disabled',
    });
  });

  it('treats enabled true with one worker as explicit serial', () => {
    expect(resolveParallelExecution(cfg({ enabled: true, max_parallel_workers: 1 }))).toEqual({
      enabled: true,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'config',
      reason: 'parallel requested but maxParallelWorkers is 1',
    });
  });

  it('selects wave mode from config only when enabled and workers exceed one', () => {
    expect(resolveParallelExecution(cfg({ enabled: true, max_parallel_workers: 3 }))).toEqual({
      enabled: true,
      mode: 'wave',
      maxParallelWorkers: 3,
      source: 'config',
      reason: 'parallel wave execution requested',
    });
  });

  it('selects wave mode when CLI --parallel uses the config worker count', () => {
    expect(resolveParallelExecution(
      cfg({ enabled: false, max_parallel_workers: 4 }),
      { parallel: true },
    )).toMatchObject({
      enabled: true,
      mode: 'wave',
      maxParallelWorkers: 4,
      source: 'cli',
    });
  });

  it('does not enable parallelism from CLI maxParallelWorkers alone', () => {
    expect(resolveParallelExecution(
      cfg({ enabled: false, max_parallel_workers: 1 }),
      { maxParallelWorkers: 5 },
    )).toEqual({
      enabled: false,
      mode: 'serial',
      maxParallelWorkers: 1,
      source: 'cli',
      reason: 'parallel execution disabled',
    });
  });

  it('lets CLI maxParallelWorkers override config when parallel is enabled', () => {
    expect(resolveParallelExecution(
      cfg({ enabled: true, max_parallel_workers: 2 }),
      { maxParallelWorkers: 6 },
    )).toMatchObject({
      enabled: true,
      mode: 'wave',
      maxParallelWorkers: 6,
      source: 'cli',
    });
  });

  it.each([0, -1, 1.5, 17, Number.NaN])(
    'rejects invalid worker count %s',
    (value) => {
      expect(() => resolveParallelExecution(
        cfg({ enabled: true, max_parallel_workers: 2 }),
        { maxParallelWorkers: value },
      )).toThrow(ParallelExecutionConfigError);
    },
  );

  it('rejects invalid configured worker counts even when parallel is disabled', () => {
    expect(() => resolveParallelExecution(cfg({ enabled: false, max_parallel_workers: 0 }))).toThrow(
      ParallelExecutionConfigError,
    );
  });

  it('marks explicit wave requests so orchestrator can fail closed until wiring exists', () => {
    const decision = resolveParallelExecution(
      cfg({ enabled: true, max_parallel_workers: 2 }),
    );
    expect(decision.mode).toBe('wave');
    expect(decision.reason).toBe('parallel wave execution requested');
  });
});

/**
 * Phase 8D P5 Round 2B: orchestrator fail-closed guard.
 *
 * `runOrchestrator` resolves the parallel decision immediately after
 * `loadConfigWithDefaults`. Wave-mode requests (resolver returns `mode: 'wave'`)
 * must be rejected with a clear `CONFIG_ERROR` blocked result before any
 * preflight, lock, or agent work runs — Round 2B does not wire worktree-backed
 * wave execution. Invalid worker counts must surface as the same
 * `CONFIG_ERROR` rather than crashing the orchestrator.
 */
describe('runOrchestrator parallel opt-in guard', () => {
  let projectRoot: string;

  beforeEach(() => {
    // A bare directory with no review-loop.yaml is enough — `loadConfigWithDefaults`
    // returns DEFAULT_CONFIG, and the parallel guard runs before any git/preflight
    // work, so the directory needn't be a git repository.
    projectRoot = mkdtempSync(join(tmpdir(), 'parallel-guard-'));
    mkdirSync(join(projectRoot, '.agent'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('blocks wave-mode CLI requests with CONFIG_ERROR before preflight', async () => {
    const result = await runOrchestrator({
      project_root: projectRoot,
      request: 'noop',
      parallel: true,
      max_parallel_workers: 4,
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
    expect(result.error?.code).toBe('CONFIG_ERROR');
    expect(result.message).toMatch(/wave/i);
    expect(result.message).toMatch(/Round 2C/);
    // No git work: branch must be empty (preflight never ran).
    expect(result.branch).toBe('');
    expect(result.commit_sha).toBeNull();
  });

  it('converts invalid CLI worker counts into CONFIG_ERROR', async () => {
    const result = await runOrchestrator({
      project_root: projectRoot,
      request: 'noop',
      parallel: true,
      max_parallel_workers: 99,
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.error?.code).toBe('CONFIG_ERROR');
    expect(result.message).toMatch(/parallel execution configuration error/i);
    expect(result.message).toMatch(/--max-parallel-workers/);
  });

  it('does not block when no parallel opt-in is provided (default serial path)', async () => {
    // With no parallel flag and no config file, the resolver returns disabled
    // serial. The orchestrator must NOT short-circuit on a CONFIG_ERROR for
    // parallelism — it should continue past the guard. Without a git repo it
    // will fail at preflight (PREFLIGHT_ERROR), not at the parallel guard.
    const result = await runOrchestrator({
      project_root: projectRoot,
      request: 'noop',
    });

    expect(result.phase).toBe('BLOCKED');
    // The resolver path is silent when not opting in; the next failure must be
    // preflight, not parallel configuration.
    expect(result.message).not.toMatch(/wave/i);
    expect(result.message).not.toMatch(/parallel execution/i);
  });

  it('does not block when --max-parallel-workers is set without --parallel', async () => {
    // A worker count without explicit opt-in resolves to disabled serial.
    // Guard must not fire even though a worker count was supplied.
    const result = await runOrchestrator({
      project_root: projectRoot,
      request: 'noop',
      max_parallel_workers: 4,
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.message).not.toMatch(/wave/i);
    expect(result.message).not.toMatch(/parallel execution/i);
  });
});
