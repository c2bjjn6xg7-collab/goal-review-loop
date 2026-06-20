/**
 * Unit tests for resume decision logic.
 * Phase 4 §9.3 / Phase 8D P7: Consistency checks and phase-specific recovery.
 *
 * These tests exercise the real `determineRecoveryAction()` helper exported
 * from the resume command. The BLOCKED branches are the focus of Phase 8D P7:
 *   - BLOCKED + task_graph_state        → continue (resume from failed task)
 *   - BLOCKED + tag-only finalization   → continue (retry tag) — most specific
 *   - BLOCKED monolithic (no task graph)→ blocked  (manual intervention)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, TaskGraphState } from '../../src/types.js';
import { Phase as PhaseEnum } from '../../src/types.js';
import { determineRecoveryAction } from '../../src/cli/resume.js';

function makeTaskGraphState(overrides: Partial<TaskGraphState> = {}): TaskGraphState {
  return {
    current_task_index: 1,
    task_statuses: { 'task-1': 'failed', 'task-2': 'pending' },
    task_attempts: { 'task-1': 1, 'task-2': 0 },
    ...overrides,
  };
}

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: 1,
    run_id: 'run-001',
    task_slug: 'test',
    phase: PhaseEnum.VERIFYING,
    iteration: 1,
    max_iterations: 3,
    consecutive_failure_count: 0,
    project_root: '/project',
    base_commit: 'abc123',
    branch: 'main',
    goal_digest: 'sha256:' + 'a'.repeat(64),
    audited_diff_digest: null,
    started_at: '2026-06-13T10:00:00.000Z',
    updated_at: '2026-06-13T10:00:00.000Z',
    last_error: null,
    cancel_requested_at: null,
    final_commit_sha: null,
    final_commit_message: null,
    finalized_at: null,
    commit_skipped: false,
    skip_reason: null,
    tag_name: null,
    tag_created: false,
    stages: {},
    task_graph_state: null,
    ...overrides,
  };
}

describe('determineRecoveryAction — BLOCKED recovery (Phase 8D P7)', () => {
  it('continues a BLOCKED task-graph run so it can resume from the failed task', () => {
    const state = makeState({
      phase: PhaseEnum.BLOCKED,
      task_graph_state: makeTaskGraphState(),
    });

    const action = determineRecoveryAction(state);

    expect(action.action).toBe('continue');
    expect(action.reason).toBeTruthy();
  });

  it('rejects a monolithic BLOCKED run with no task graph state', () => {
    const state = makeState({
      phase: PhaseEnum.BLOCKED,
      task_graph_state: null,
      final_commit_sha: null,
      tag_name: null,
    });

    const action = determineRecoveryAction(state);

    expect(action.action).toBe('blocked');
    expect(action.reason).toBeTruthy();
  });

  it('continues a tag-only finalization BLOCKED run (commit exists, tag missing)', () => {
    const state = makeState({
      phase: PhaseEnum.BLOCKED,
      final_commit_sha: 'deadbeef',
      tag_created: false,
      tag_name: 'v1.0.0',
      task_graph_state: null,
    });

    const action = determineRecoveryAction(state);

    expect(action.action).toBe('continue');
    expect(action.reason).toMatch(/tag/i);
  });

  it('keeps tag-only finalization recovery more specific than task-graph recovery', () => {
    // A run that somehow has both a pending tag retry AND task-graph state
    // must take the tag-only branch — finalization recovery is more specific.
    const state = makeState({
      phase: PhaseEnum.BLOCKED,
      final_commit_sha: 'deadbeef',
      tag_created: false,
      tag_name: 'v1.0.0',
      task_graph_state: makeTaskGraphState(),
    });

    const action = determineRecoveryAction(state);

    expect(action.action).toBe('continue');
    expect(action.reason).toMatch(/tag/i);
  });

  it('does not mutate the supplied state', () => {
    const state = makeState({
      phase: PhaseEnum.BLOCKED,
      task_graph_state: makeTaskGraphState({ current_task_index: 2 }),
    });
    const snapshot = JSON.stringify(state);

    determineRecoveryAction(state);

    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('determineRecoveryAction — phase-specific recovery', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'resume-decision-'));
    mkdirSync(join(projectRoot, '.agent'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('requires a restart when interrupted during INITIALIZING', () => {
    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.INITIALIZING, project_root: projectRoot }));
    expect(action.action).toBe('restart');
  });

  it('continues PLANNING when plan.md and GOAL.md already exist', () => {
    writeFileSync(join(projectRoot, '.agent', 'plan.md'), '# plan');
    writeFileSync(join(projectRoot, '.agent', 'GOAL.md'), '# goal');

    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.PLANNING, project_root: projectRoot }));
    expect(action.action).toBe('continue');
  });

  it('restarts PLANNING when the plan is missing', () => {
    writeFileSync(join(projectRoot, '.agent', 'GOAL.md'), '# goal');

    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.PLANNING, project_root: projectRoot }));
    expect(action.action).toBe('restart');
  });

  it('continues DEVELOPING when a developer handoff exists', () => {
    writeFileSync(join(projectRoot, '.agent', 'developer-handoff.md'), '# handoff');

    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.DEVELOPING, project_root: projectRoot }));
    expect(action.action).toBe('continue');
  });

  it('continues DEVELOPING even without a handoff (re-run Developer)', () => {
    expect(existsSync(join(projectRoot, '.agent', 'developer-handoff.md'))).toBe(false);
    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.DEVELOPING, project_root: projectRoot }));
    expect(action.action).toBe('continue');
  });

  it('continues REWORKING to re-run the Developer', () => {
    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.REWORKING, project_root: projectRoot }));
    expect(action.action).toBe('continue');
  });

  it('re-runs full verification from VERIFYING', () => {
    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.VERIFYING, project_root: projectRoot }));
    expect(action.action).toBe('continue');
  });

  it('re-runs or validates from AUDITING', () => {
    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.AUDITING, project_root: projectRoot }));
    expect(action.action).toBe('continue');
  });

  it('resumes finalization from FINALIZING', () => {
    const action = determineRecoveryAction(makeState({ phase: PhaseEnum.FINALIZING, project_root: projectRoot }));
    expect(action.action).toBe('continue');
  });
});

describe('determineRecoveryAction — terminal phase guarding', () => {
  // Non-BLOCKED terminal phases are never reached via the resume path
  // (executeResume rejects them earlier), but the helper itself must still
  // treat an unknown/unhandled phase as blocked rather than continuing.
  it('blocks an unrecognized phase', () => {
    const state = makeState({ phase: 'UNKNOWN' as never });
    const action = determineRecoveryAction(state);
    expect(action.action).toBe('blocked');
  });
});
