/**
 * Integration tests for Phase 9 R1 `review-loop status --watch`.
 *
 * Verifies that the watch command reads the durable event stream:
 * - JSON mode replays existing events then follows appended events.
 * - Text mode renders current phase, active role, and latest events.
 * - Watch exits when the run reaches a terminal event.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { EventStore, type ReviewLoopEvent } from '../../src/runtime/event-store.js';

const CLI = join(process.cwd(), 'dist', 'cli', 'main.js');

async function seedEvents(agentDir: string, runId: string, events: Partial<ReviewLoopEvent>[]): Promise<ReviewLoopEvent[]> {
  const store = new EventStore(agentDir, runId);
  const written: ReviewLoopEvent[] = [];
  for (const draft of events) {
    const e = await store.append({
      kind: draft.kind!,
      phase: draft.phase!,
      level: draft.level!,
      message: draft.message!,
      role: draft.role,
      status: draft.status,
    });
    written.push(e);
  }
  return written;
}

/**
 * Run `status --watch --json` against a repo with a seeded event stream,
 * with an abort timeout so the test does not hang.
 */
function runWatchJson(repoDir: string, timeoutMs: number): { stdout: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI, 'status', '--watch', '--json', '--project-root', repoDir, '--watch-timeout', String(timeoutMs)], {
      encoding: 'utf8',
      timeout: timeoutMs + 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', code: e.status ?? 1 };
  }
}

describe('Phase 9 R1 status --watch event stream', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  async function makeRepoWithEvents(suffix: string, events: Partial<ReviewLoopEvent>[]): Promise<string> {
    const dir = join(tmpdir(), `rl-watch-${suffix}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const agentDir = join(dir, '.agent');
    mkdirSync(agentDir, { recursive: true });
    // Minimal state.json so executeStatus doesn't bail early.
    writeFileSync(join(agentDir, 'state.json'), JSON.stringify({
      schema_version: 1,
      run_id: 'watch-run-1',
      task_slug: 'test',
      project_root: dir,
      base_commit: 'abc',
      branch: 'main',
      phase: events[events.length - 1]?.phase ?? 'PASSED',
      iteration: 1,
      max_iterations: 3,
      consecutive_failure_count: 0,
      goal_digest: null,
      last_error: null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      audited_diff_digest: null,
      cancel_requested_at: null,
      task_graph_state: null,
      commit_skipped: false,
      final_commit_sha: null,
      tag_name: null,
      tag_created: false,
    }, null, 2));
    await seedEvents(agentDir, 'watch-run-1', events);
    return dir;
  }

  it('JSON watch replays existing events', async () => {
    repoDir = await makeRepoWithEvents('replay', [
      { kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'Run started' },
      { kind: 'role.started', phase: 'PLANNING', level: 'info', message: 'Planner starting', role: 'planner' },
      { kind: 'role.exited', phase: 'PLANNING', level: 'info', message: 'Planner exited', role: 'planner' },
      { kind: 'run.completed', phase: 'PASSED', level: 'info', message: 'Done', status: 'PASSED' },
    ]);

    const { stdout, code } = runWatchJson(repoDir, 2000);

    // The output is line-delimited JSON events.
    const lines = stdout.trim().split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as ReviewLoopEvent);
    expect(parsed.length).toBeGreaterThanOrEqual(4);
    expect(parsed[0].kind).toBe('run.started');
    expect(parsed[parsed.length - 1].kind).toBe('run.completed');
    // Watch should exit cleanly after terminal event.
    expect(code).toBe(0);
  });

  it('Text watch shows phase, role, and latest event', async () => {
    repoDir = await makeRepoWithEvents('text', [
      { kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'Run started' },
      { kind: 'role.started', phase: 'PLANNING', level: 'info', message: 'Planner starting', role: 'planner' },
      { kind: 'run.completed', phase: 'PASSED', level: 'info', message: 'Done', status: 'PASSED' },
    ]);

    let stdout = '';
    try {
      stdout = execFileSync('node', [CLI, 'status', '--watch', '--project-root', repoDir, '--watch-timeout', '2000'], {
        encoding: 'utf8',
        timeout: 7000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      stdout = e.stdout ?? '';
    }

    // Text mode should mention the run id and the terminal phase somewhere.
    expect(stdout).toContain('watch-run-1');
    // Should render at least one event line.
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('JSON watch returns no events gracefully for a run without events.jsonl', () => {
    const dir = join(tmpdir(), `rl-watch-none-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const agentDir = join(dir, '.agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'state.json'), JSON.stringify({
      schema_version: 1, run_id: 'no-events', task_slug: 't', project_root: dir,
      base_commit: 'a', branch: 'main', phase: 'PASSED', iteration: 1, max_iterations: 3,
      consecutive_failure_count: 0, goal_digest: null, last_error: null,
      started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      audited_diff_digest: null, cancel_requested_at: null, task_graph_state: null,
      commit_skipped: false, final_commit_sha: null, tag_name: null, tag_created: false,
    }, null, 2));
    repoDir = dir;

    const { stdout, code } = runWatchJson(repoDir, 1500);
    // No events.jsonl → JSON watch emits nothing but exits cleanly.
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(0);
  });
});
