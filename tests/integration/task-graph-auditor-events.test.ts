/**
 * Regression test for Phase 9 R1 bug: task-graph integration auditor must
 * emit role.started / role.exited / audit.decision events.
 *
 * Symptom: a task-graph run (planner → developer per task → integration
 * auditor → final auditor) only showed 3 roles in events.jsonl. The
 * integration Auditor (codex) actually ran (audit-report.md was produced)
 * but no role.started/role.exited/audit.decision events were emitted for it.
 *
 * Root cause: task-graph-loop.ts integration auditor path (lines ~692-768)
 * was never wired to emit events, unlike the serial path in run-orchestrator.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { EventStore } from '../../src/runtime/event-store.js';

function makeRepo(suffix: string): string {
  const dir = join(tmpdir(), `rl-tg-audit-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "T"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# T\n');
  writeFileSync(join(dir, '.gitignore'), '.agent/\nnode_modules/\ndist/\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 't', version: '1.0.0',
    scripts: { test: 'echo ok', typecheck: 'echo ok', lint: 'echo ok' },
  }, null, 2));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const h = () => "h";\n');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests', 'i.test.ts'), 'test("h", () => {});\n');
  const fake = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const cfg = {
    version: 1,
    agents: {
      planner: { command: ['node', fake, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'task-graph'], timeout_seconds: 60 },
      developer: { command: ['node', fake, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}'], timeout_seconds: 60 },
      auditor: { command: ['node', fake, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'audit-pass'], timeout_seconds: 60 },
      final_auditor: { command: ['node', fake, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'audit-pass'], timeout_seconds: 60 },
    },
    loop: { max_iterations: 3 },
    git: {
      require_repository: true, require_head: true, require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: true, commit_template: 'feat: {task_slug}',
      create_tag: false, tag_template: 'agent-{run_id}-pass', push: false,
    },
    runtime: { kill_grace_seconds: 5, max_log_bytes: 10485760, lock_stale_seconds: 86400 },
  };
  writeFileSync(join(dir, 'review-loop.yaml'), JSON.stringify(cfg, null, 2));
  const p = join(dir, 'prompts');
  mkdirSync(p);
  for (const f of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const s = join(process.cwd(), 'prompts', f);
    if (existsSync(s)) copyFileSync(s, join(p, f));
  }
  execSync('git add -A', { cwd: dir });
  execSync('git commit -m init', { cwd: dir });
  return dir;
}

describe('Phase 9 R1 task-graph auditor events', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('emits role.started, role.exited, and audit.decision for the integration auditor', async () => {
    repoDir = makeRepo('events');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      task_slug: 'feat-a',
    });
    expect(result.phase).toBe('PASSED');

    const agentDir = join(repoDir, '.agent');
    const store = new EventStore(agentDir, result.run_id);
    const events = await store.readAll();

    // All four roles must be visible in the event stream.
    const rolesStarted = events
      .filter((e) => e.kind === 'role.started')
      .map((e) => e.role);
    expect(rolesStarted).toContain('auditor');
    expect(rolesStarted).toContain('final-auditor');

    const rolesExited = events
      .filter((e) => e.kind === 'role.exited')
      .map((e) => e.role);
    expect(rolesExited).toContain('auditor');

    // The integration auditor must emit an audit.decision event.
    const auditDecision = events.find((e) => e.kind === 'audit.decision');
    expect(auditDecision).toBeDefined();
    expect(auditDecision?.role).toBe('auditor');
  });
});
