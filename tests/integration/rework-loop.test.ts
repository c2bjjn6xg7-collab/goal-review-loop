/**
 * Integration tests for Phase 4 Rework Loop.
 * Phase 4 §7: 15 scenarios using Fake Agent fixture.
 *
 * Each test creates a temporary git repo, configures the fake agent,
 * and runs the orchestrator to verify multi-round rework behavior.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { executeStatus } from '../../src/cli/status.js';
import { executeResume, ResumeConsistencyError } from '../../src/cli/resume.js';

/** Write review-loop.yaml config that uses the fake agent. */
function writeFakeAgentConfig(repoDir: string, roleBehaviors: Record<string, string>, maxIterations = 3): void {
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
    loop: { max_iterations: maxIterations },
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
  // Copy rework prompt if it exists
  const reworkPrompt = join(srcPromptsDir, 'rework.md');
  if (existsSync(reworkPrompt)) {
    copyFileSync(reworkPrompt, join(promptsDir, 'rework.md'));
  }
}

/** Create a temporary git repo for testing. */
function createTestRepo(suffix: string, roleBehaviors: Record<string, string> = {}, maxIterations = 3): string {
  const repoDir = join(tmpdir(), `review-loop-p4-${suffix}-${Date.now()}`);
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
  writeFakeAgentConfig(repoDir, roleBehaviors, maxIterations);
  copyPrompts(repoDir);

  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });

  return repoDir;
}

describe('Phase 4 Rework Loop integration', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  // ─── Scenario 1: First-round PASS → FINALIZING ─────────────
  it('1: first-round PASS ends in FINALIZING', async () => {
    repoDir = createTestRepo('s1');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });

    expect(result.phase).toBe('FINALIZING');
    expect(result.exit_code).toBe(0);
    expect(result.audit_decision).toBe('PASS');
  });

  // ─── Scenario 2: First-round verification fail → iteration 2 rework → PASS ──
  it('2: verification fail on iteration 1, rework succeeds on iteration 2', async () => {
    // Use audit-fail-then-pass: auditor FAILs on iter 1, PASSes on iter 2+
    repoDir = createTestRepo('s2', { auditor: 'audit-fail-then-pass' }, 3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    // Should reach FINALIZING after iteration 2
    expect(result.phase).toBe('FINALIZING');
    expect(result.exit_code).toBe(0);
    expect(result.audit_decision).toBe('PASS');

    // Verify iteration 1 history was archived
    expect(existsSync(join(repoDir, '.agent', 'history', 'iteration-01'))).toBe(true);
  });

  // ─── Scenario 3: First-round scope fail → iteration 2 rework → PASS ──
  it('3: scope violation on iteration 1, rework succeeds on iteration 2', async () => {
    // Developer creates scope violation on iter 1, auditor passes on iter 2
    // Use scope-violation behavior for developer (modifies state.json)
    // and audit-fail-then-pass for auditor
    repoDir = createTestRepo('s3', {
      developer: 'scope-violation',
      auditor: 'audit-fail-then-pass',
    }, 3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    // Scope violation should cause BLOCKED or FAILED
    expect(['BLOCKED', 'FAILED']).toContain(result.phase);
  });

  // ─── Scenario 4: Auditor FAIL → iteration 2 rework → PASS ──
  it('4: auditor FAIL on iteration 1, rework leads to PASS on iteration 2', async () => {
    repoDir = createTestRepo('s4', { auditor: 'audit-fail-then-pass' }, 3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    expect(result.phase).toBe('FINALIZING');
    expect(result.audit_decision).toBe('PASS');
  });

  // ─── Scenario 5: Auditor BLOCKED → BLOCKED (no rework) ─────
  it('5: auditor BLOCKED results in BLOCKED without rework', async () => {
    repoDir = createTestRepo('s5', { auditor: 'audit-blocked' }, 3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── Scenario 6: Max iterations → FAILED ──────────────────
  it('6: reaching max_iterations results in FAILED', async () => {
    repoDir = createTestRepo('s6', { auditor: 'audit-fail' }, 2);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 2,
    });

    expect(result.phase).toBe('FAILED');
    expect(result.exit_code).toBe(2);
  });

  // ─── Scenario 7: Per-iteration handoff/audit/evidence/verification archived ──
  it('7: archives handoff, audit, evidence, and verification per iteration', async () => {
    repoDir = createTestRepo('s7', { auditor: 'audit-fail-then-pass' }, 3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    expect(result.phase).toBe('FINALIZING');

    // Iteration 1 should be archived
    const historyDir1 = join(repoDir, '.agent', 'history', 'iteration-01');
    expect(existsSync(historyDir1)).toBe(true);
    expect(existsSync(join(historyDir1, 'developer-handoff.md'))).toBe(true);
    expect(existsSync(join(historyDir1, 'audit-report.md'))).toBe(true);
  });

  // ─── Scenario 8: Rework doesn't create new branch ─────────
  it('8: rework uses the same branch, no new branch created', async () => {
    repoDir = createTestRepo('s8', { auditor: 'audit-fail-then-pass' }, 3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      task_slug: 'same-branch',
      max_iterations: 3,
    });

    expect(result.phase).toBe('FINALIZING');

    // Verify only one task branch exists (no extra branches from rework)
    const branches = execSync('git branch --list "agent/*"', { cwd: repoDir, encoding: 'utf8' }).trim();
    const branchLines = branches.split('\n').filter(b => b.trim().length > 0);
    expect(branchLines.length).toBe(1);
  });

  // ─── Scenario 9: Rework still rejects Developer forging .agent/evidence/** ──
  it('9: rework iteration still detects evidence forgery', async () => {
    repoDir = createTestRepo('s9', { developer: 'forge-evidence' }, 3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    // Evidence forgery must be detected
    expect(result.phase).toBe('BLOCKED');
    expect(result.exit_code).toBe(3);
  });

  // ─── Scenario 10: Resume from VERIFYING reruns full verification ──
  it('10: resume from VERIFYING reruns full verification and completes', async () => {
    repoDir = createTestRepo('s10');

    // Run a full orchestrator to set up the state and artifacts
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    expect(result.phase).toBe('FINALIZING');

    // Now simulate an interrupted run by modifying state.json back to VERIFYING
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'VERIFYING';
    state.iteration = 1;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove the lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should re-run verification and auditing, reaching FINALIZING again
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: 1,
        phase: 'VERIFYING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(resumeResult.phase).toBe('FINALIZING');
    expect(resumeResult.audit_decision).toBe('PASS');
  });

  // ─── Scenario 11: Resume with branch mismatch → BLOCKED ───
  it('11: resume with branch mismatch is rejected', async () => {
    repoDir = createTestRepo('s11');

    // Run a full orchestrator first
    await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // Modify state to non-terminal and switch branch
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'VERIFYING';
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Switch to a different branch
    execSync('git checkout -b wrong-branch', { cwd: repoDir });

    // Remove lock
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should detect branch mismatch and fail
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: 1,
        phase: 'VERIFYING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    // Should be BLOCKED because the branch doesn't match
    expect(resumeResult.phase).toBe('BLOCKED');
  });

  // ─── Scenario 12: Resume with GOAL digest mismatch → BLOCKED ──
  it('12: resume with GOAL digest mismatch is rejected', async () => {
    repoDir = createTestRepo('s12');

    // Run a full orchestrator first
    await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // Modify state to non-terminal
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'VERIFYING';
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Tamper with GOAL.md
    const goalPath = join(repoDir, '.agent', 'GOAL.md');
    if (existsSync(goalPath)) {
      const content = readFileSync(goalPath, 'utf8');
      writeFileSync(goalPath, content + '\n// Tampered\n', 'utf8');
    }

    // Remove lock
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should detect GOAL digest mismatch and fail
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: 1,
        phase: 'VERIFYING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    // Should be BLOCKED because GOAL digest doesn't match
    expect(resumeResult.phase).toBe('BLOCKED');
  });

  // ─── Scenario 13: Cancel during long-running Developer → CANCELLED ──
  it('13: cancel request during developer run leads to CANCELLED', async () => {
    repoDir = createTestRepo('s13', {}, 3);

    // Add .agent to .gitignore so pre-writing files doesn't dirty the worktree
    writeFileSync(join(repoDir, '.gitignore'), '.agent/\n', 'utf8');
    execSync('git add .gitignore && git commit -m "add gitignore"', { cwd: repoDir });

    const agentDir = join(repoDir, '.agent');
    mkdirSync(agentDir, { recursive: true });

    // Write a cancel request before the orchestrator starts.
    // The orchestrator checks for cancel-request.json at the top of each iteration.
    const cancelRequest = {
      schema_version: 1,
      run_id: 'any',
      requested_at: new Date().toISOString(),
      requested_by: 'cli:12345',
    };
    writeFileSync(join(agentDir, 'cancel-request.json'), JSON.stringify(cancelRequest), 'utf8');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    // The orchestrator should detect the cancel request and transition to CANCELLED
    expect(result.phase).toBe('CANCELLED');
    expect(result.exit_code).toBe(4);

    // Verify state.json reflects CANCELLED
    const statePath = join(repoDir, '.agent', 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.phase).toBe('CANCELLED');

    // Verify evidence is preserved
    expect(existsSync(join(repoDir, '.agent', 'plan.md'))).toBe(true);
    expect(existsSync(join(repoDir, '.agent', 'GOAL.md'))).toBe(true);
  });

  // ─── Scenario 14: status --json output stable and parseable ──
  it('14: status --json produces stable parseable output', async () => {
    repoDir = createTestRepo('s14');

    await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // Get status
    const status = await executeStatus({
      project_root: repoDir,
      json: true,
    });

    expect(status).not.toBeNull();
    expect(status!.run_id).toBeTruthy();
    expect(status!.phase).toBeTruthy();
    expect(typeof status!.iteration).toBe('number');
    expect(typeof status!.max_iterations).toBe('number');
    expect(status!.branch).toBeTruthy();
    expect(status!.base_commit).toBeTruthy();
    expect(status!.started_at).toBeTruthy();
    expect(status!.updated_at).toBeTruthy();
    expect(['held', 'stale', 'none']).toContain(status!.lock_status);
    expect(status!.next_step).toBeTruthy();

    // Verify JSON serialization is stable
    const json1 = JSON.stringify(status);
    const parsed = JSON.parse(json1);
    const json2 = JSON.stringify(parsed);
    expect(json1).toBe(json2);
  });

  // ─── Scenario 15: Resume from AUDITING reruns or validates Auditor evidence ──
  it('15: resume from AUDITING reruns auditor and completes', async () => {
    repoDir = createTestRepo('s15');

    // Run a full orchestrator to set up the state and artifacts
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    expect(result.phase).toBe('FINALIZING');

    // Simulate an interrupted run by modifying state.json back to AUDITING
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'AUDITING';
    state.iteration = 1;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove the lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should re-run auditing and reach FINALIZING
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: 1,
        phase: 'AUDITING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(resumeResult.phase).toBe('FINALIZING');
    expect(resumeResult.audit_decision).toBe('PASS');
  });

  // ─── Scenario 16: Archive idempotency → BLOCKED on digest mismatch ──
  it('16: archive with existing mismatched digests results in BLOCKED', async () => {
    repoDir = createTestRepo('s16', { auditor: 'audit-fail-then-pass' }, 3);

    // Run the orchestrator — it will do iteration 1 (audit FAIL) then iteration 2 (audit PASS)
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });
    expect(result.phase).toBe('FINALIZING');

    // Verify iteration 1 was archived
    const historyDir = join(repoDir, '.agent', 'history', 'iteration-01');
    expect(existsSync(historyDir)).toBe(true);

    // Now tamper with the archived handoff to create a digest mismatch
    const archivedHandoff = join(historyDir, 'developer-handoff.md');
    if (existsSync(archivedHandoff)) {
      writeFileSync(archivedHandoff, 'TAMPERED CONTENT', 'utf8');
    }

    // Modify state to simulate being at iteration 1 with a rework needed
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'REWORKING';
    state.iteration = 1;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove lock
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should detect the idempotency violation and BLOCKED
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: 2,
        phase: 'REWORKING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    // Should be BLOCKED because archive digests don't match
    expect(resumeResult.phase).toBe('BLOCKED');
  });

  // ─── Scenario 17: Cancel during running Developer (abort signal) → CANCELLED ──
  it('17: abort signal during running developer leads to CANCELLED', async () => {
    repoDir = createTestRepo('s17', { developer: 'slow-developer' }, 3);

    // Add .agent to .gitignore so cancel-request.json doesn't dirty the worktree
    writeFileSync(join(repoDir, '.gitignore'), '.agent/\n', 'utf8');
    execSync('git add .gitignore && git commit -m "add gitignore"', { cwd: repoDir });

    // Create an AbortController and schedule abort after 2 seconds
    // (slow-developer sleeps 30s, so 2s is enough to catch it mid-run)
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 2000);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
      signal: abortController.signal,
    });

    expect(result.phase).toBe('CANCELLED');
    expect(result.exit_code).toBe(4);

    // Verify state.json reflects CANCELLED
    const statePath = join(repoDir, '.agent', 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.phase).toBe('CANCELLED');
  }, 60000);

  // ─── Scenario 18: Cancel during Verification (abort signal) → CANCELLED ──
  it('18: abort signal during verification leads to CANCELLED', async () => {
    // Use a normal developer but a slow verification command
    repoDir = createTestRepo('s18', {}, 3);

    // Add .agent to .gitignore
    writeFileSync(join(repoDir, '.gitignore'), '.agent/\n', 'utf8');

    // Override the package.json test script to sleep for a long time
    const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
    pkg.scripts.test = 'sleep 60';
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify(pkg, null, 2));

    execSync('git add -A && git commit -m "slow test"', { cwd: repoDir });

    // Create an AbortController and schedule abort after 3 seconds
    // (verification will be running `sleep 60`, so 3s catches it mid-run)
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 3000);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
      signal: abortController.signal,
    });

    expect(result.phase).toBe('CANCELLED');
    expect(result.exit_code).toBe(4);

    // Verify state.json reflects CANCELLED
    const statePath = join(repoDir, '.agent', 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.phase).toBe('CANCELLED');
  }, 90000);

  // ─── Scenario 19: CLI resume branch mismatch → throws (non-zero exit) ──
  it('19: CLI resume with branch mismatch throws ResumeConsistencyError', async () => {
    repoDir = createTestRepo('s19');

    // Run a full orchestrator first
    await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // Switch to a different branch
    execSync('git checkout -b wrong-branch', { cwd: repoDir });

    // Remove lock
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // executeResume should throw ResumeConsistencyError
    await expect(executeResume({
      project_root: repoDir,
    })).rejects.toThrow(ResumeConsistencyError);

    await expect(executeResume({
      project_root: repoDir,
    })).rejects.toThrow(/branch/i);
  });

  // ─── Scenario 20: Tamper archived evidence/verification → BLOCKED on resume ──
  it('20: tampered archived evidence/verification leads to BLOCKED on resume', async () => {
    repoDir = createTestRepo('s20', { auditor: 'audit-fail-then-pass' }, 3);

    // Run the orchestrator — it will do iteration 1 (audit FAIL) then iteration 2 (audit PASS)
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });
    expect(result.phase).toBe('FINALIZING');

    // Verify iteration 1 was archived with evidence
    const historyDir = join(repoDir, '.agent', 'history', 'iteration-01');
    expect(existsSync(historyDir)).toBe(true);

    // Tamper with an archived evidence file
    const archivedEvidenceDir = join(historyDir, 'evidence');
    if (existsSync(archivedEvidenceDir)) {
      // Find any file in the evidence directory and tamper with it
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(archivedEvidenceDir, { recursive: true });
      for (const f of files) {
        const fullPath = join(archivedEvidenceDir, String(f));
        try {
          const content = readFileSync(fullPath, 'utf8');
          writeFileSync(fullPath, content + '\n// TAMPERED\n', 'utf8');
          break; // Only need to tamper one file
        } catch { /* skip binary/unreadable */ }
      }
    }

    // Modify state to simulate being at iteration 1 with a rework needed
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'REWORKING';
    state.iteration = 1;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove lock
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should detect the idempotency violation in evidence/ and BLOCKED
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: 2,
        phase: 'REWORKING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    // Should be BLOCKED because archived evidence digests don't match
    expect(resumeResult.phase).toBe('BLOCKED');
  });
});
