/**
 * Phase 8D P6 Round 2: unit tests for the failure-guard orchestrator helper.
 * Uses a real StateStore against a temp state.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../../src/orchestrator/state-store.js';
import { recordSoftFailure, recordSoftFailurePass } from '../../src/orchestrator/failure-guard.js';
import type { ReviewLoopConfig } from '../../src/types.js';
import type { FailureClass } from '../../src/scheduler/failure-policy.js';

function makeConfig(maxConsecutiveFailures: number): ReviewLoopConfig {
  return {
    version: 1,
    agents: {},
    loop: {
      max_iterations: 5,
      archive_history: true,
      stop_on_infrastructure_error: true,
      max_consecutive_failures: maxConsecutiveFailures,
      max_agent_retries: 1,
    },
    git: {
      require_repository: false,
      require_head: false,
      require_clean_worktree: false,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: false,
      commit_template: '',
      create_tag: false,
      tag_template: '',
      push: false,
    },
    runtime: {
      kill_grace_seconds: 5,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
    },
  } as unknown as ReviewLoopConfig;
}

describe('failure-guard helper', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(async () => {
    dir = join(tmpdir(), `fg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    store = new StateStore(dir);
    await store.create({
      run_id: 'run-test',
      task_slug: 'test',
      project_root: dir,
      base_commit: 'abc123',
      branch: 'main',
      max_iterations: 5,
    });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch { /* ok */ }
  });

  it('H1: recordSoftFailure increments from 0 to 1', async () => {
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.consecutiveFailureCount).toBe(1);
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(1);
  });

  it('H2: persists across calls (second call reads first call value)', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.consecutiveFailureCount).toBe(2);
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(2);
  });

  it('H3: thresholdReached true when reaching max (2 -> 3, max=3)', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.thresholdReached).toBe(true);
    expect(outcome.consecutiveFailureCount).toBe(3);
  });

  it('H4: thresholdReached false below max (1 -> 2, max=3)', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    expect(outcome.thresholdReached).toBe(false);
    expect(outcome.consecutiveFailureCount).toBe(2);
  });

  it('H5: recordSoftFailurePass resets count to 0', async () => {
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const outcome = await recordSoftFailurePass(store, makeConfig(3));
    expect(outcome.consecutiveFailureCount).toBe(0);
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(0);
  });

  it('H6: no other state fields touched except consecutive_failure_count and updated_at', async () => {
    const before = await store.read();
    await recordSoftFailure(store, makeConfig(3), 'verification_failed');
    const after = await store.read();
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      if (key === 'consecutive_failure_count' || key === 'updated_at') continue;
      expect(after[key]).toEqual(before[key]);
    }
  });

  it('H7: all four FailureClass values accepted', async () => {
    const classes: FailureClass[] = ['auditor_block', 'developer_blocked', 'verification_failed', 'infrastructure_error'];
    let expected = 0;
    for (const cls of classes) {
      expected += 1;
      const outcome = await recordSoftFailure(store, makeConfig(10), cls);
      expect(outcome.consecutiveFailureCount).toBe(expected);
    }
    const state = await store.read();
    expect(state.consecutive_failure_count).toBe(4);
  });
});
