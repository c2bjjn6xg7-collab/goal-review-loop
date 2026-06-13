/**
 * Integration tests for Run Orchestrator.
 * Phase 3 §16.3: 15 scenarios using Fake Agent fixture.
 *
 * Each test creates a temporary git repo, configures the fake agent,
 * and runs the orchestrator to verify state transitions and outputs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';

/** Write review-loop.yaml config that uses the fake agent. */
function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>): void {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));

  const config = {
    version: 1,
    agents: {
      planner: {
        command: ['node', fakeAgentPath, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.planner || 'success'],
        timeout_seconds: 60,
      },
      developer: {
        command: ['node', fakeAgentPath, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.developer || 'success'],
        timeout_seconds: 60,
      },
      auditor: {
        command: ['node', fakeAgentPath, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.auditor || 'audit-pass'],
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
    },
  };

  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2));
}

/** Create prompts directory in test repo. */
function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const f of ['planner.md', 'developer.md', 'auditor.md']) {
    copyFileSync(join(srcPromptsDir, f), join(promptsDir, f));
  }
}

/** Create a temporary git repo for testing. Config and prompts are committed so worktree is clean. */
function createTestRepo(suffix: string, roleBehaviors: Record<string, string> = {}): string {
  const repoDir = join(tmpdir(), `review-loop-test-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  // Init git repo
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });

  // Create project files
  writeFileSync(join(repoDir, 'README.md'), '# Test Project\n');
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
    scripts: { test: 'echo "ok"', typecheck: 'echo "ok"', lint: 'echo "ok"' },
  }, null, 2));
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const hello = () => "hello";\n');
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  writeFileSync(join(repoDir, 'tests', 'index.test.ts'), 'test("hello", () => {});\n');

  // Write config and prompts BEFORE initial commit so worktree is clean
  writeFakeAgentConfig(repoDir, roleBehaviors);
  copyPrompts(repoDir);

  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });

  return repoDir;
}

describe('Run Orchestrator integration', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  // ─── Scenario 1: First-round PASS → FINALIZING ─────────────
  it('completes first round PASS ending in FINALIZING without commit', async () => {
    repoDir = createTestRepo('pass');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });

    expect(result.phase).toBe('FINALIZING');
    expect(result.exit_code).toBe(0);
    expect(result.audit_decision).toBe('PASS');
    expect(result.artifact_paths.length).toBeGreaterThan(0);

    // Verify no commit was made
    const logOutput = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' });
    expect(logOutput.trim().split('\n').length).toBe(1); // Only initial commit

    // Verify artifacts exist
    expect(existsSync(join(repoDir, '.agent', 'plan.md'))).toBe(true);
    expect(existsSync(join(repoDir, '.agent', 'GOAL.md'))).toBe(true);
    expect(existsSync(join(repoDir, '.agent', 'developer-handoff.md'))).toBe(true);
    expect(existsSync(join(repoDir, '.agent', 'audit-report.md'))).toBe(true);
  });

  // ─── Scenario 2: Planner generates invalid GOAL → BLOCKED ──
  it('blocks when Planner generates invalid GOAL', async () => {
    repoDir = createTestRepo('invalid-goal', { planner: 'invalid-goal' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── Scenario 4: Developer BLOCKED handoff → BLOCKED ───────
  it('blocks when Developer reports BLOCKED', async () => {
    repoDir = createTestRepo('dev-blocked', { developer: 'blocked-handoff' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── Scenario 5: Developer modifies GOAL → BLOCKED ────────
  it('blocks when Developer modifies GOAL.md', async () => {
    repoDir = createTestRepo('dev-modify-goal', { developer: 'modify-goal' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── Scenario 10: Auditor FAIL → REWORKING ─────────────────
  it('enters REWORKING when Auditor returns FAIL', async () => {
    repoDir = createTestRepo('audit-fail', { auditor: 'audit-fail' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('REWORKING');
    expect(result.exit_code).toBe(2);
    expect(result.audit_decision).toBe('FAIL');
  });

  // ─── Scenario 11: Auditor BLOCKED → BLOCKED ───────────────
  it('blocks when Auditor returns BLOCKED', async () => {
    repoDir = createTestRepo('audit-blocked', { auditor: 'audit-blocked' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── Scenario 12: Auditor PASS with bad digest → not FINALIZING
  it('rejects Auditor PASS with wrong digest', async () => {
    repoDir = createTestRepo('bad-digest', { auditor: 'audit-bad-digest' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // Should NOT be FINALIZING — digest mismatch
    expect(result.phase).not.toBe('FINALIZING');
  });

  // ─── Scenario 14: Agent timeout → BLOCKED ──────────────────
  // F-311R1 fix: timeout fixture now uses active timer (setTimeout 300s),
  // so Process Runner actually exercises its timeout path instead of
  // Node exiting immediately with code 13 (unsettled top-level await).
  // Config minimum timeout is 60s, so this test takes ~65s.
  it('blocks on agent timeout', async () => {
    repoDir = createTestRepo('timeout', { planner: 'timeout' });

    const startTime = Date.now();
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    const elapsed = Date.now() - startTime;

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
    // Verify real timeout occurred (should take at least 60s, not exit instantly)
    expect(elapsed).toBeGreaterThanOrEqual(55000);
    // Verify the error indicates timeout
    expect(result.error?.message).toMatch(/timed out|timeout/i);
  }, 120000); // 120s Vitest timeout for real timeout test

  // ─── Scenario 15: Agent exit error → BLOCKED ───────────────
  it('blocks on agent non-zero exit', async () => {
    repoDir = createTestRepo('exit-error', { planner: 'exit-error' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── Scenario: No artifact produced → BLOCKED ──────────────
  it('blocks when agent produces no artifact', async () => {
    repoDir = createTestRepo('no-artifact', { planner: 'no-artifact' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── State and lock verification ────────────────────────────
  it('releases lock on all exit paths', async () => {
    repoDir = createTestRepo('lock-release', { planner: 'exit-error' });

    await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // Lock should be released
    expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
  });

  it('creates state.json with correct run_id', async () => {
    repoDir = createTestRepo('state');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    const statePath = join(repoDir, '.agent', 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.run_id).toBe(result.run_id);
    expect(state.phase).toBe(result.phase);
  });

  it('creates task branch', async () => {
    repoDir = createTestRepo('branch');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      task_slug: 'test-branch',
    });

    expect(result.branch).toContain('test-branch');
  });

  it('writes iteration log', async () => {
    repoDir = createTestRepo('log');

    await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    const logPath = join(repoDir, '.agent', 'iteration-log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, 'utf8');
    expect(logContent.length).toBeGreaterThan(0);
  });

  it('writes verification evidence', async () => {
    repoDir = createTestRepo('evidence');

    await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    const evidenceDir = join(repoDir, '.agent', 'evidence', 'iteration-01');
    expect(existsSync(evidenceDir)).toBe(true);
  });

  // ─── F-307R2: Developer evidence forgery → BLOCKED ───────────
  it('blocks when Developer forges evidence files', async () => {
    repoDir = createTestRepo('forge-evidence', { developer: 'forge-evidence' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // F-307R2: Forged evidence must be detected and result in BLOCKED
    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
    expect(result.error?.message).toMatch(/system-protected|unregistered|tampered/i);

    // Verify the forged file still exists (not cleaned up by orchestrator)
    expect(existsSync(join(repoDir, '.agent', 'evidence', 'forged.json'))).toBe(true);

    // Verify lock is released
    expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
  });

  // ─── F-307R2: Developer modifies state.json → BLOCKED ────────
  it('blocks when Developer modifies state.json', async () => {
    repoDir = createTestRepo('modify-state', { developer: 'scope-violation' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // F-307R2: State tampering must be detected
    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
    expect(result.error?.message).toMatch(/system-protected|tampered|digest_mismatch/i);

    // Verify lock is released
    expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
  });

  // ─── F-306R2: Prompt cleanup failure → BLOCKED ───────────────
  // This test verifies that if prompt file deletion fails, the orchestrator
  // enters BLOCKED rather than continuing silently. The Developer agent makes
  // the .agent/debug directory read-only so deletePromptFile() cannot unlink
  // the prompt file.
  it('blocks when prompt cleanup fails', async () => {
    repoDir = createTestRepo('prompt-cleanup-fail', { developer: 'break-prompt-cleanup' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // F-306R2: Prompt cleanup failure must result in BLOCKED
    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
    expect(result.error?.message).toMatch(/cleanup|prompt/i);

    // Restore permissions so afterEach cleanup can delete the repo
    try { execSync(`chmod -R 755 ${repoDir}/.agent/debug`, { stdio: 'ignore' }); } catch { /* ok */ }

    // Verify lock is released
    expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
  });
});
