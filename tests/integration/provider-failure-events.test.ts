/**
 * Integration test for Phase 9 R1 provider.failure event emission.
 *
 * Runs a fake-agent developer that writes a quota-exhaustion stderr and
 * exits 1, then asserts the event stream contains a provider.failure event.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { EventStore } from '../../src/runtime/event-store.js';

function makeRepo(suffix: string, devBehavior: string): string {
  const dir = join(tmpdir(), `rl-pf-${suffix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "T"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# T\n');
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
      planner: { command: ['node', fake, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}'], timeout_seconds: 60 },
      developer: { command: ['node', fake, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', devBehavior], timeout_seconds: 60 },
      auditor: { command: ['node', fake, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'audit-pass'], timeout_seconds: 60 },
      final_auditor: { command: ['node', fake, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'audit-pass'], timeout_seconds: 60 },
    },
    loop: { max_iterations: 1, max_agent_retries: 1 },
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

describe('Phase 9 R1 provider.failure event', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('emits provider.failure when developer stderr contains quota signal', async () => {
    repoDir = makeRepo('quota', 'provider-quota');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add hello',
      task_slug: 'hello',
      max_iterations: 1,
    });

    // The developer fails, so the run blocks/fails.
    expect(['BLOCKED', 'FAILED']).toContain(result.phase);

    const store = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await store.readAll();
    const providerFailure = events.find((e) => e.kind === 'provider.failure');

    expect(providerFailure).toBeDefined();
    expect(providerFailure?.role).toBe('developer');
    expect(providerFailure?.level).toBe('error');
    expect(providerFailure?.payload?.classification).toBe('quota_exhausted');
    expect(providerFailure?.payload?.retry_recommended).toBe(false);
    expect(providerFailure?.artifact_refs?.[0]?.type).toBe('stderr');
  });
});
