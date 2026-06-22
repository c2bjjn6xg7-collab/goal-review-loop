/**
 * Integration tests for Phase 9 R6 integration.* event emission from
 * `runTaskGraphWaveLoop`.
 *
 * Covers two scenarios:
 *   1. A 3-task parallel wave that PASSES — asserts `integration.started`
 *      and `integration.completed` are present in `.agent/events.jsonl`
 *      with the correct payload.
 *   2. A task-fail wave that BLOCKS before reaching the integration phase —
 *      asserts no `integration.*` events are emitted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { EventStore } from '../../src/runtime/event-store.js';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>): void {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const config = {
    version: 1,
    agents: {
      planner: {
        command: ['node', fakeAgentPath, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.planner || 'task-graph'],
        timeout_seconds: 60,
      },
      developer: {
        command: ['node', fakeAgentPath, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.developer || 'task-success'],
        timeout_seconds: 60,
      },
      auditor: {
        command: ['node', fakeAgentPath, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.auditor || 'audit-pass'],
        timeout_seconds: 60,
      },
      final_auditor: {
        command: ['node', fakeAgentPath, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.finalAuditor || 'audit-pass'],
        timeout_seconds: 60,
      },
    },
    loop: { max_iterations: 3 },
    git: {
      require_repository: true,
      require_head: true,
      require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: true,
      commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
      create_tag: false,
      tag_template: 'agent-{run_id}-pass',
      push: false,
    },
    runtime: {
      kill_grace_seconds: 5,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
      agent_idle_timeout_seconds: 30,
    },
  };
  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2), 'utf8');
}

function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const fileName of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const source = join(srcPromptsDir, fileName);
    if (existsSync(source)) {
      copyFileSync(source, join(promptsDir, fileName));
    }
  }
}

function createTestRepo(suffix: string, roleBehaviors: Record<string, string>): string {
  const repoDir = mkdtempSync(join(tmpdir(), `task-graph-integration-events-${suffix}-`));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'task-graph-integration-events-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  writeFileSync(join(repoDir, '.gitignore'), '.agent/**\n', 'utf8');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  writeFakeAgentConfig(repoDir, roleBehaviors);
  copyPrompts(repoDir);

  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  expect(git(repoDir, ['status', '--short', '--untracked-files=all'])).toBe('');
  return repoDir;
}

describe('Phase 9 R6 integration.* event emission', () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
      repoDir = undefined;
    }
  });

  it('emits integration.started and integration.completed on a passing 3-task parallel wave', async () => {
    repoDir = createTestRepo('all-pass', {
      planner: 'task-graph',
      developer: 'task-success',
    });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'integration-events-pass',
      parallel: true,
      max_parallel_workers: 2,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);

    const eventsPath = join(repoDir, '.agent', 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();

    const started = events.find((e) => e.kind === 'integration.started');
    expect(started, 'integration.started must be emitted').toBeDefined();
    expect(started?.payload?.integration_branch).toBe(`integration/${result.run_id}`);
    expect(started?.payload?.task_count).toBe(3);

    const completed = events.find((e) => e.kind === 'integration.completed');
    expect(completed, 'integration.completed must be emitted').toBeDefined();
    expect(completed?.payload?.integration_branch).toBe(`integration/${result.run_id}`);

    // integration.started must come before integration.completed.
    expect(started!.seq).toBeLessThan(completed!.seq);

    // No integration.blocked events on a passing run.
    const blocked = events.filter((e) => e.kind === 'integration.blocked');
    expect(blocked).toEqual([]);

    // task.started events must carry event-level provider (default 'claude'
    // when unset in config); model is undefined/omitted when not configured.
    const taskStarted = events.filter((e) => e.kind === 'task.started');
    expect(taskStarted).toHaveLength(3);
    for (const e of taskStarted) {
      expect(e.provider).toBe('claude');
      expect(e.model).toBeUndefined();
    }

    // task.completed events must carry a non-empty worktree_path.
    const taskCompleted = events.filter((e) => e.kind === 'task.completed');
    expect(taskCompleted.length).toBeGreaterThan(0);
    for (const e of taskCompleted) {
      expect(typeof e.payload?.worktree_path).toBe('string');
      expect((e.payload?.worktree_path as string).length).toBeGreaterThan(0);
    }
  }, 120000);

  it('does not emit integration.* events when the wave blocks before the integration phase', async () => {
    repoDir = createTestRepo('task-fail', {
      planner: 'task-graph',
      developer: 'blocked-handoff',
    });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a multi-part feature',
      task_slug: 'integration-events-fail',
      parallel: true,
      max_parallel_workers: 2,
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);

    const eventsPath = join(repoDir, '.agent', 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();

    const integrationEvents = events.filter((e) =>
      e.kind === 'integration.started' ||
      e.kind === 'integration.completed' ||
      e.kind === 'integration.blocked',
    );
    expect(integrationEvents).toEqual([]);

    // task.blocked events must still carry a non-empty worktree_path even
    // when the wave blocks before the integration phase.
    const taskBlocked = events.filter((e) => e.kind === 'task.blocked');
    expect(taskBlocked.length).toBeGreaterThan(0);
    for (const e of taskBlocked) {
      expect(typeof e.payload?.worktree_path).toBe('string');
      expect((e.payload?.worktree_path as string).length).toBeGreaterThan(0);
    }
  }, 120000);
});
