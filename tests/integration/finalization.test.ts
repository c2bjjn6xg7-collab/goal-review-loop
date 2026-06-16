/**
 * Integration tests for Phase 5 Finalization.
 * §12.2: 18 scenarios using Fake Agent fixture.
 *
 * Each test creates a temporary git repo, configures the fake agent
 * (including final_auditor), and runs the orchestrator to verify
 * finalization behavior: commit, tag, digest checks, resume, cancel.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync, chmodSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';

/** Write review-loop.yaml config that uses the fake agent. */
function writeFakeAgentConfig(
  repoDir: string,
  roleBehaviors: Record<string, string>,
  overrides: { maxIterations?: number; commitOnPass?: boolean; push?: boolean; createTag?: boolean } = {},
): void {
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
      final_auditor: {
        command: ['node', fakeAgentPath, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', roleBehaviors.finalAuditor || 'audit-pass'],
        timeout_seconds: 60,
      },
    },
    loop: { max_iterations: overrides.maxIterations ?? 3 },
    git: {
      require_repository: true,
      require_head: true,
      require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: overrides.commitOnPass ?? true,
      commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
      create_tag: overrides.createTag ?? false,
      tag_template: 'agent-{run_id}-pass',
      push: overrides.push ?? false,
    },
    runtime: {
      kill_grace_seconds: 5,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
    },
  };

  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2));
}

/** Create prompts directory in test repo, including final-auditor.md. */
function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const f of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md']) {
    const src = join(srcPromptsDir, f);
    if (existsSync(src)) {
      copyFileSync(src, join(promptsDir, f));
    }
  }
  // Copy rework prompt if it exists
  const reworkPrompt = join(srcPromptsDir, 'rework.md');
  if (existsSync(reworkPrompt)) {
    copyFileSync(reworkPrompt, join(promptsDir, 'rework.md'));
  }
}

/** Create a temporary git repo for testing. */
function createTestRepo(
  suffix: string,
  roleBehaviors: Record<string, string> = {},
  overrides: { maxIterations?: number; commitOnPass?: boolean; push?: boolean; createTag?: boolean } = {},
): string {
  const repoDir = join(tmpdir(), `review-loop-p5-${suffix}-${Date.now()}`);
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
  writeFakeAgentConfig(repoDir, roleBehaviors, overrides);
  copyPrompts(repoDir);

  execSync('git add -A', { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });

  return repoDir;
}

describe('Phase 5 Finalization integration', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true }); } catch { /* ok */ }
    }
  });

  // ─── Scenario 1: First-round PASS → Final Audit PASS → commit → PASSED ──
  it('1: first-round PASS with final audit PASS commits and reaches PASSED', async () => {
    repoDir = createTestRepo('s1');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a hello function',
      task_slug: 'hello-func',
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_sha).toBeTruthy();
    expect(typeof result.commit_sha).toBe('string');
    expect(result.commit_sha!.length).toBeGreaterThan(0);
    expect(result.commit_skipped).toBe(false);

    // Verify commit exists in git log
    const logOutput = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' });
    expect(logOutput.trim().split('\n').length).toBe(2); // initial + agent commit
  });

  // ─── Scenario 2: Second-round rework PASS → Final Audit PASS → commit → PASSED ──
  it('2: rework PASS then final audit PASS commits and reaches PASSED', async () => {
    repoDir = createTestRepo('s2', { auditor: 'audit-fail-then-pass' }, { maxIterations: 3 });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      max_iterations: 3,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_sha).toBeTruthy();
    expect(typeof result.commit_sha).toBe('string');
  });

  // ─── Scenario 3: --no-commit → Final Audit PASS → PASSED, no commit ──
  it('3: --no-commit skips commit but reaches PASSED', async () => {
    repoDir = createTestRepo('s3');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      no_commit: true,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_skipped).toBe(true);
    expect(result.commit_sha).toBeNull();
    expect(result.skip_reason).toBe('--no-commit');

    // Verify git log still has only initial commit
    const logOutput = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' });
    expect(logOutput.trim().split('\n').length).toBe(1);
  });

  // ─── Scenario 4: --tag → commit success → tag points to that commit ──
  it('4: --tag creates tag pointing to commit', async () => {
    repoDir = createTestRepo('s4');

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      tag: true,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.commit_sha).toBeTruthy();
    expect(result.tag_created).toBe(true);
    expect(result.tag_name).toBeTruthy();

    // Verify tag exists in git
    const tagList = execSync('git tag -l', { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(tagList).toContain(result.tag_name!);

    // Verify tag points to the commit
    const tagTarget = execSync(`git rev-parse ${result.tag_name}`, { cwd: repoDir, encoding: 'utf8' }).trim();
    expect(tagTarget).toBe(result.commit_sha);
  });

  // ─── Scenario 5: final-audit FAIL → no commit ──
  it('5: final audit FAIL blocks commit', async () => {
    repoDir = createTestRepo('s5', { finalAuditor: 'audit-fail' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();
    expect(result.error?.code).toBe('FINAL_AUDIT_FAILED');
  });

  // ─── Scenario 6: final-audit schema error → no commit ──
  it('6: final audit missing artifact blocks commit', async () => {
    repoDir = createTestRepo('s6', { finalAuditor: 'no-artifact' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();
    // When the final auditor doesn't write the artifact, the agent adapter
    // detects the missing artifact and returns ARTIFACT_ERROR/AGENT_ERROR.
    // If the artifact exists but is malformed, it would be FINAL_AUDIT_SCHEMA_ERROR.
    expect(['FINAL_AUDIT_SCHEMA_ERROR', 'FINAL_AUDIT_FAILED', 'AGENT_ERROR', 'ARTIFACT_ERROR']).toContain(result.error?.code);
  });

  // ─── Scenario 7: Diff tampered → digest mismatch → no commit ──
  it('7: final audit with bad diff digest blocks commit', async () => {
    repoDir = createTestRepo('s7', { finalAuditor: 'audit-bad-digest' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();
    // Bad digests should be caught by final audit validation
    expect(['FINAL_AUDIT_SCHEMA_ERROR', 'FINAL_AUDIT_FAILED', 'PRE_COMMIT_DIGEST_MISMATCH']).toContain(result.error?.code);
  });

  // ─── Scenario 8: GOAL tampered → no commit ──
  it('8: final audit with bad goal digest blocks commit', async () => {
    // audit-bad-digest writes wrong goal_digest and diff_digest
    repoDir = createTestRepo('s8', { finalAuditor: 'audit-bad-digest' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();
    expect(['FINAL_AUDIT_SCHEMA_ERROR', 'FINAL_AUDIT_FAILED', 'PRE_COMMIT_DIGEST_MISMATCH']).toContain(result.error?.code);
  });

  // ─── Scenario 9: Verification manifest stale/fail → no commit ──
  it('9: tampered verification manifest blocks commit on resume', async () => {
    repoDir = createTestRepo('s9');

    // Run a full orchestrator to set up state and artifacts
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    expect(result.phase).toBe('PASSED');

    // Now simulate a resume scenario: modify state back to FINALIZING
    // and tamper with the verification manifest
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    // Clear final_commit_sha so the early-exit check doesn't skip finalization
    state.final_commit_sha = null;
    state.final_commit_message = null;
    state.tag_name = null;
    state.tag_created = false;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Tamper with verification manifest to make it stale
    const manifestPath = join(repoDir, '.agent', 'verification', 'manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.iteration = 999; // Wrong iteration
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }

    // Remove lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should detect the stale manifest and block
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(resumeResult.phase).toBe('BLOCKED');
    expect(resumeResult.commit_sha).toBeNull();
    expect(resumeResult.error?.code).toBe('PRE_COMMIT_DIGEST_MISMATCH');
  });

  // ─── Scenario 10: Scope Guard failure → no commit ──
  it('10: scope guard failure in finalization blocks commit', async () => {
    // Use a developer that creates a scope violation (modifies state.json)
    // and an auditor that still passes. The final scope guard should catch it.
    repoDir = createTestRepo('s10', { developer: 'scope-violation', auditor: 'audit-pass' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // The scope violation should be caught — either during regular scope check
    // or during finalization scope check. Either way, no commit.
    expect(result.phase).not.toBe('PASSED');
    expect(result.commit_sha).toBeNull();
  });

  // ─── Scenario 11: Local-only artifact tracked → no commit ──
  it('11: tracked local-only artifact blocks commit on resume', async () => {
    repoDir = createTestRepo('s11');

    // Run a full orchestrator to set up state and artifacts
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    expect(result.phase).toBe('PASSED');

    // Now simulate a resume scenario: modify state back to FINALIZING
    // and track a local-only artifact (state.json) in git
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    // Clear final_commit_sha so the early-exit check doesn't skip finalization
    state.final_commit_sha = null;
    state.final_commit_message = null;
    state.tag_name = null;
    state.tag_created = false;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Track .agent/state.json in git (it should be local-only)
    execSync('git add .agent/state.json', { cwd: repoDir });

    // Remove lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should detect the tracked local-only artifact and block
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(resumeResult.phase).toBe('BLOCKED');
    expect(resumeResult.commit_sha).toBeNull();
    expect(resumeResult.error?.code).toBe('PRE_COMMIT_STAGED_SET_VIOLATION');
  });

  // ─── Scenario 12: Final Audit FAIL → BLOCKED, lock released ──
  // Verifies that BLOCKED state always releases the lock file.
  // Real commit failure is covered by Scenario 21.
  it('12: BLOCKED state always releases lock after final audit failure', async () => {
    repoDir = createTestRepo('s12', { finalAuditor: 'audit-fail' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    // Final audit fail → BLOCKED, no commit
    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();

    // Verify lock is released
    expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
  });

  // ─── Scenario 13: Commit success but tag failure → BLOCKED, state records commit sha ──
  it('13: tag conflict after commit results in BLOCKED with commit sha preserved', async () => {
    repoDir = createTestRepo('s13');

    // Run with tag=true to get a PASSED result with commit and tag
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      tag: true,
    });
    expect(result.phase).toBe('PASSED');
    expect(result.commit_sha).toBeTruthy();
    expect(result.tag_created).toBe(true);
    const commitSha = result.commit_sha!;
    const tagName = result.tag_name!;

    // Get the initial commit (before the agent commit) to create a tag conflict
    const initialCommit = execSync('git rev-parse HEAD~1', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Delete the existing tag and create a conflicting one pointing to a different commit
    try { execSync(`git tag -d ${tagName}`, { cwd: repoDir, stdio: 'ignore' }); } catch { /* ok */ }
    execSync(`git tag ${tagName} ${initialCommit}`, { cwd: repoDir });

    // Set state to FINALIZING with commit sha, tag_name, and tag_created=false
    // This simulates a state where commit was created but tag failed
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    state.final_commit_sha = commitSha;
    state.tag_name = tagName;
    state.tag_created = false;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove lock
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should detect the tag conflict and remain BLOCKED
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
      tag: true,
    });

    expect(resumeResult.phase).toBe('BLOCKED');
    expect(resumeResult.commit_sha).toBeTruthy();
    expect(resumeResult.error?.code).toBe('GIT_TAG_ERROR');
  });

  // ─── Scenario 14: Resume to create tag → PASSED, no duplicate commit ──
  it('14: resume from BLOCKED with commit sha creates tag without duplicate commit', async () => {
    repoDir = createTestRepo('s14');

    // Run with tag=true to get a PASSED result with commit and tag
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      tag: true,
    });
    expect(result.phase).toBe('PASSED');
    expect(result.commit_sha).toBeTruthy();
    expect(result.tag_created).toBe(true);
    const originalCommitSha = result.commit_sha!;
    const originalTagName = result.tag_name!;

    // Count commits before resume
    const logBefore = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' }).trim();
    const commitCountBefore = logBefore.split('\n').length;

    // Simulate a state where commit was created but tag failed:
    // Set state back to FINALIZING with final_commit_sha set and tag_created=false
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    state.final_commit_sha = originalCommitSha;
    state.tag_created = false;
    state.tag_name = originalTagName; // F-502: tag_name must be saved for resume to detect tag-only path
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove the existing tag so resume can create it
    try { execSync(`git tag -d ${originalTagName}`, { cwd: repoDir, stdio: 'ignore' }); } catch { /* ok */ }

    // Remove lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should create the tag without creating a duplicate commit
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
      tag: true,
    });

    // Should reach PASSED with tag created
    expect(resumeResult.phase).toBe('PASSED');
    expect(resumeResult.tag_created).toBe(true);
    expect(resumeResult.tag_name).toBeTruthy();

    // No duplicate commit was created
    const logAfter = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' }).trim();
    const commitCountAfter = logAfter.split('\n').length;
    expect(commitCountAfter).toBe(commitCountBefore);
  });

  // ─── Scenario 15: Resume from FINALIZING without final-audit → re-runs final audit and commits ──
  it('15: resume from FINALIZING without final-audit re-runs final audit and commits', async () => {
    repoDir = createTestRepo('s15');

    // Run with --no-commit to reach PASSED without committing
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      no_commit: true,
    });
    expect(result.phase).toBe('PASSED');
    expect(result.commit_skipped).toBe(true);

    // Modify state back to FINALIZING
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove final-audit.md so the final auditor needs to re-run
    const finalAuditPath = join(repoDir, '.agent', 'final-audit.md');
    if (existsSync(finalAuditPath)) rmSync(finalAuditPath);

    // Remove lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should re-run final audit and commit
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(resumeResult.phase).toBe('PASSED');
    expect(resumeResult.commit_sha).toBeTruthy();
  });

  // ─── Scenario 16: Resume from FINALIZING with commit already → no duplicate commit ──
  it('16: resume from FINALIZING with existing commit does not create duplicate', async () => {
    repoDir = createTestRepo('s16');

    // Run to PASSED with commit
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    expect(result.phase).toBe('PASSED');
    expect(result.commit_sha).toBeTruthy();
    const originalCommitSha = result.commit_sha!;

    // Count commits before resume
    const logBefore = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' }).trim();
    const commitCountBefore = logBefore.split('\n').length;

    // Modify state back to FINALIZING
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    // Keep final_commit_sha so the early-exit check skips commit
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume should not create a duplicate commit
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    // Should reach PASSED again
    expect(resumeResult.phase).toBe('PASSED');

    // Verify no duplicate commit was created
    const logAfter = execSync('git log --oneline', { cwd: repoDir, encoding: 'utf8' }).trim();
    const commitCountAfter = logAfter.split('\n').length;
    expect(commitCountAfter).toBe(commitCountBefore);
  });

  // ─── Scenario 17: git.push: true → BLOCKED, no commit ──
  it('17: git.push=true blocks with CONFIG_ERROR (MVP constraint)', async () => {
    repoDir = createTestRepo('s17', {}, { push: true });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();
    // validateMvpConstraints throws ConfigError during config loading,
    // which the orchestrator catches and returns as CONFIG_ERROR.
    // The UNSUPPORTED_PUSH code in runFinalization is defense-in-depth
    // for when config validation is bypassed.
    expect(['CONFIG_ERROR', 'UNSUPPORTED_PUSH']).toContain(result.error?.code);
  });

  // ─── Scenario 18: Cancel during Final Auditor → CANCELLED, no commit ──
  it('18: abort signal during final auditor leads to CANCELLED', async () => {
    repoDir = createTestRepo('s18', { finalAuditor: 'timeout' });

    // Add .agent to .gitignore so pre-writing files doesn't dirty the worktree
    writeFileSync(join(repoDir, '.gitignore'), '.agent/\n', 'utf8');
    execSync('git add .gitignore && git commit -m "add gitignore"', { cwd: repoDir });

    // Create an AbortController and schedule abort after 2 seconds
    // (timeout behavior sleeps 300s, so 2s is enough to catch it mid-run)
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 2000);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
      signal: abortController.signal,
    });

    expect(result.phase).toBe('CANCELLED');
    expect(result.exit_code).toBe(4);
    expect(result.commit_sha).toBeNull();

    // Verify state.json reflects CANCELLED
    const statePath = join(repoDir, '.agent', 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.phase).toBe('CANCELLED');

    // Verify lock is released
    expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
  }, 120000);

  // ─── Scenario 19: Final Auditor tampers with business file → BLOCKED (SCOPE_VIOLATION) ──
  // F-501R1: The digest snapshot comparison must detect content-level modifications
  // to business files that path/status checks alone would miss.
  it('19: Final Auditor tampering with business file detected via digest snapshot', async () => {
    repoDir = createTestRepo('s19', { finalAuditor: 'audit-tamper-final' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();
    expect(result.error?.code).toBe('SCOPE_VIOLATION');
    expect(result.error?.message || result.summary).toMatch(/content modified|Final Auditor modified/);
  });

  // ─── Scenario 20: Resume with commit missing required artifacts → re-run finalization ──
  // F-503R1: commitExists() returns true but verifyCommitTree() finds missing artifacts.
  it('20: resume with commit missing versioned artifacts re-runs finalization', async () => {
    repoDir = createTestRepo('s20');

    // Run to PASSED with full commit
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    expect(result.phase).toBe('PASSED');
    expect(result.commit_sha).toBeTruthy();
    const originalCommitSha = result.commit_sha!;

    // Create a lightweight commit that's missing versioned artifacts.
    // We do this by amending the final commit to exclude .agent/final-audit.md.
    // Instead, create a new branch from the initial commit, add a partial set,
    // and point state.final_commit_sha to this incomplete commit.
    const incompleteCommitSha = execSync(
      'git rev-parse HEAD~1',
      { cwd: repoDir, encoding: 'utf8' },
    ).trim(); // This is the initial commit, which has no versioned artifacts

    // Modify state to reference the incomplete commit
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    state.final_commit_sha = incompleteCommitSha;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume — should detect missing artifacts and re-run finalization
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    // Should re-run finalization and reach PASSED with a new commit
    expect(resumeResult.phase).toBe('PASSED');
    expect(resumeResult.commit_sha).toBeTruthy();
    // The new commit should be different from the incomplete one
    expect(resumeResult.commit_sha).not.toBe(incompleteCommitSha);
  });

  // ─── Scenario 21: Real commit failure → BLOCKED, lock released ──
  // F-504R1: Simulate a real git commit failure by making .git/objects read-only.
  it('21: real commit failure results in BLOCKED with lock released', async () => {
    repoDir = createTestRepo('s21');

    // Add .agent to .gitignore so pre-writing files doesn't dirty the worktree
    writeFileSync(join(repoDir, '.gitignore'), '.agent/\n', 'utf8');
    execSync('git add .gitignore && git commit -m "add gitignore"', { cwd: repoDir });

    // Make .git/objects read-only so git commit fails to create new objects
    const objectsDir = join(repoDir, '.git', 'objects');
    chmodSync(objectsDir, 0o555);

    try {
      const result = await runOrchestrator({
        project_root: repoDir,
        request: 'Add feature',
      });

      // Commit should fail → BLOCKED or FAILED
      expect(['BLOCKED', 'FAILED']).toContain(result.phase);
      expect(result.commit_sha).toBeNull();

      // Verify lock is released
      expect(existsSync(join(repoDir, '.agent', 'run.lock'))).toBe(false);
    } finally {
      // Restore permissions for cleanup
      chmodSync(objectsDir, 0o755);
    }
  }, 120000);

  // ─── Scenario 22: Final Auditor deletes business file (revert-to-base) → BLOCKED ──
  // F-501R2: The file disappears from git diff but the pre-snapshot still recorded it.
  // The exhaustive digest check must detect the deletion.
  it('22: Final Auditor deleting business file detected by exhaustive digest check', async () => {
    repoDir = createTestRepo('s22', { finalAuditor: 'audit-revert-final' });

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.commit_sha).toBeNull();
    expect(result.error?.code).toBe('SCOPE_VIOLATION');
  });

  // ─── Scenario 23: Resume with commit whose final-audit.md has wrong run_id → re-run ──
  // F-503R2: Tree check passes (all paths present), but content verification fails.
  it('23: resume with stale run_id in commit final-audit.md re-runs finalization', async () => {
    repoDir = createTestRepo('s23');

    // Run to PASSED with full commit
    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add feature',
    });
    expect(result.phase).toBe('PASSED');
    expect(result.commit_sha).toBeTruthy();

    // Tamper: rewrite final-audit.md with a different run_id, amend the commit
    const finalAuditPath = join(repoDir, '.agent', 'final-audit.md');
    let content = readFileSync(finalAuditPath, 'utf8');
    content = content.replace(/run_id: "[^"]+"/, 'run_id: "wrong-run-id"');
    writeFileSync(finalAuditPath, content, 'utf8');
    execSync('git add .agent/final-audit.md && git commit --amend --no-edit --no-verify', { cwd: repoDir });
    const amendedSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();

    // Modify state to reference the amended commit
    const statePath = join(repoDir, '.agent', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    state.final_commit_sha = amendedSha;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    // Remove lock so resume can acquire it
    const lockPath = join(repoDir, '.agent', 'run.lock');
    if (existsSync(lockPath)) rmSync(lockPath);

    // Resume — should detect wrong run_id and re-run finalization
    const resumeResult = await runOrchestrator({
      project_root: repoDir,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: 'FINALIZING',
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(resumeResult.phase).toBe('PASSED');
    expect(resumeResult.commit_sha).toBeTruthy();
    // New commit should be different from the amended one
    expect(resumeResult.commit_sha).not.toBe(amendedSha);
  });
});
