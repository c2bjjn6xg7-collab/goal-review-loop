import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createIntegrationAuditFixture,
  runFixtureIntegrationAudit,
  type IntegrationAuditFixture,
} from '../helpers/integration-audit-fixture.js';
import { runIntegrationFinalization } from '../../src/orchestrator/integration-finalizer.js';
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function writeFile(repoDir: string, relativePath: string, content: string): void {
  const fullPath = path.join(repoDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

interface R3Options {
  tag?: boolean;
  noCommit?: boolean;
}

async function runR3(fixture: IntegrationAuditFixture, options: R3Options = {}) {
  return runIntegrationFinalization({
    projectRoot: fixture.repoDir,
    agentDir: fixture.agentDir,
    runId: fixture.runId,
    baseCommit: fixture.baseCommit,
    goalDigest: fixture.goalDigest,
    integrationBranch: fixture.integrationBranch,
    iteration: 3,
    stateStore: fixture.stateStore,
    artifactStore: fixture.artifactStore,
    orchestratorRegistry: fixture.registry,
    config: fixture.config,
    tag: options.tag ?? false,
    noCommit: options.noCommit ?? false,
  });
}

/**
 * Create a fixture and run Phase 8E R2 to PASS, leaving the integration branch
 * checked out with all R2 evidence written and state at FINALIZING.
 */
async function prepareR2Passed(suffix: string, finalAuditorBehavior?: 'audit-pass'): Promise<IntegrationAuditFixture> {
  const fx = await createIntegrationAuditFixture({ suffix, finalAuditorBehavior });
  const audit = await runFixtureIntegrationAudit(fx);
  if (audit.status !== 'passed') {
    throw new Error(`R2 audit did not pass: ${audit.error_code} ${audit.error_message}`);
  }
  return fx;
}

/**
 * Reset state.json phase back to FINALIZING while preserving final_commit_sha,
 * simulating a crash between R3 commit creation and the PASSED transition.
 * StateStore.transition() cannot move out of PASSED, so we write the file
 * directly (the schema still validates).
 */
function resetStateToFinalizing(fixture: IntegrationAuditFixture): void {
  const statePath = path.join(fixture.agentDir, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.phase = 'FINALIZING';
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function commitTreeFiles(repoDir: string, ref: string): string[] {
  return git(repoDir, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
}

describe('Phase 8E R3 integration finalization', () => {
  let fixture: IntegrationAuditFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('creates the final commit on integration/{run_id} with business files and R3 artifacts', async () => {
    fixture = await prepareR2Passed('r3-commit');
    // The fixture's original branch (main) must not move during R3.
    const originalBranchSha = git(fixture.repoDir, ['rev-parse', 'main']);
    const preIntegrationHead = git(fixture.repoDir, ['rev-parse', fixture.integrationBranch]);

    const result = await runR3(fixture);

    expect(result.status).toBe('passed');
    expect(result.final_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.commit_skipped).toBe(false);
    expect(result.skip_reason).toBeNull();
    expect(result.tag_created).toBe(false);
    expect(result.error_code).toBeNull();

    // Commit is on integration/{run_id} and is the new tip.
    expect(git(fixture.repoDir, ['branch', '--show-current'])).toBe(fixture.integrationBranch);
    expect(git(fixture.repoDir, ['rev-parse', fixture.integrationBranch])).toBe(result.final_commit_sha);
    // A new commit was created on top of the R2 integration head.
    expect(result.final_commit_sha).not.toBe(preIntegrationHead);

    // Original branch is NOT moved.
    expect(git(fixture.repoDir, ['rev-parse', 'main'])).toBe(originalBranchSha);

    // Committed tree includes the business file and R3 artifacts.
    const tree = commitTreeFiles(fixture.repoDir, fixture.integrationBranch);
    expect(tree).toContain('src/feature.ts');
    expect(tree).toContain('.agent/final-audit.md');
    expect(tree).toContain('.agent/integration/integration-plan.json');
    expect(tree).toContain('.agent/integration/integrated-diff-metadata.json');
    expect(tree).toContain('.agent/integration/final-audit-context.json');

    // Committed tree excludes .agent/task-runs/** and local-only runtime files.
    expect(tree.some((p) => p.startsWith('.agent/task-runs/'))).toBe(false);
    expect(tree).not.toContain('.agent/state.json');
    expect(tree).not.toContain('.agent/run.lock');

    // State records the final commit.
    const state = JSON.parse(readFileSync(path.join(fixture.agentDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('PASSED');
    expect(state.branch).toBe(fixture.integrationBranch);
    expect(state.final_commit_sha).toBe(result.final_commit_sha);
    expect(state.commit_skipped).toBe(false);
    expect(state.skip_reason).toBeNull();
    expect(state.finalized_at).toBeTruthy();
  }, 120000);

  it('creates the final commit when the audited business diff deletes a file', async () => {
    fixture = await createIntegrationAuditFixture({
      suffix: 'r3-delete',
      integrationChange: 'delete-base',
    });
    const audit = await runFixtureIntegrationAudit(fixture);
    expect(audit.status, `${audit.error_code ?? ''} ${audit.error_message ?? ''}`).toBe('passed');

    const result = await runR3(fixture);

    expect(result.status).toBe('passed');
    expect(result.final_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    const tree = commitTreeFiles(fixture.repoDir, fixture.integrationBranch);
    expect(tree).not.toContain('src/base.ts');
    expect(tree).toContain('.agent/final-audit.md');
    expect(tree).toContain('.agent/task-results.json');
  }, 120000);

  it('creates a local tag when requested', async () => {
    fixture = await prepareR2Passed('r3-tag');

    const result = await runR3(fixture, { tag: true });

    expect(result.status).toBe('passed');
    expect(result.tag_created).toBe(true);
    expect(result.tag_name).toBe(`agent-${fixture.runId}-pass`);
    const target = git(fixture.repoDir, ['rev-list', '-n', '1', result.tag_name!]);
    expect(target).toBe(result.final_commit_sha);
  }, 120000);

  it('resume with a valid final_commit_sha and no tag returns PASSED without a duplicate commit', async () => {
    fixture = await prepareR2Passed('r3-resume-notag');

    const first = await runR3(fixture);
    expect(first.status).toBe('passed');
    const firstSha = first.final_commit_sha;
    const tipAfterFirst = git(fixture.repoDir, ['rev-parse', fixture.integrationBranch]);

    resetStateToFinalizing(fixture);

    const second = await runR3(fixture);

    expect(second.status).toBe('passed');
    expect(second.final_commit_sha).toBe(firstSha);
    // No duplicate commit: branch tip unchanged.
    expect(git(fixture.repoDir, ['rev-parse', fixture.integrationBranch])).toBe(tipAfterFirst);
  }, 120000);

  it('resume with a valid final_commit_sha and tag requested creates only the tag', async () => {
    fixture = await prepareR2Passed('r3-resume-tag');

    const first = await runR3(fixture); // no tag
    expect(first.tag_created).toBe(false);
    const firstSha = first.final_commit_sha;
    const tipAfterFirst = git(fixture.repoDir, ['rev-parse', fixture.integrationBranch]);

    resetStateToFinalizing(fixture);

    const second = await runR3(fixture, { tag: true });

    expect(second.status).toBe('passed');
    expect(second.final_commit_sha).toBe(firstSha);
    expect(second.tag_created).toBe(true);
    expect(second.tag_name).toBe(`agent-${fixture.runId}-pass`);
    // No duplicate commit.
    expect(git(fixture.repoDir, ['rev-parse', fixture.integrationBranch])).toBe(tipAfterFirst);
    expect(git(fixture.repoDir, ['rev-list', '-n', '1', second.tag_name!])).toBe(firstSha);
  }, 120000);

  it('resume with an existing matching tag returns PASSED', async () => {
    fixture = await prepareR2Passed('r3-resume-match');

    const first = await runR3(fixture);
    // Pre-create the matching tag.
    git(fixture.repoDir, ['tag', `agent-${fixture.runId}-pass`, first.final_commit_sha!]);

    resetStateToFinalizing(fixture);

    const second = await runR3(fixture, { tag: true });

    expect(second.status).toBe('passed');
    expect(second.tag_created).toBe(true);
    expect(second.final_commit_sha).toBe(first.final_commit_sha);
  }, 120000);

  it('resume with an existing conflicting tag returns BLOCKED and preserves final_commit_sha', async () => {
    fixture = await prepareR2Passed('r3-resume-conflict');

    const first = await runR3(fixture);
    // Pre-create a conflicting tag pointing elsewhere (the pre-integration head).
    const elsewhere = git(fixture.repoDir, ['rev-parse', `${fixture.integrationBranch}~1`]);
    git(fixture.repoDir, ['tag', `agent-${fixture.runId}-pass`, elsewhere]);

    resetStateToFinalizing(fixture);

    const second = await runR3(fixture, { tag: true });

    expect(second.status).toBe('blocked');
    expect(second.error_code).toBe('GIT_TAG_ERROR');
    expect(second.final_commit_sha).toBe(first.final_commit_sha);
    const state = JSON.parse(readFileSync(path.join(fixture.agentDir, 'state.json'), 'utf8'));
    expect(state.final_commit_sha).toBe(first.final_commit_sha);
  }, 120000);

  it('persists BLOCKED state when an R3 pre-commit blocker is hit', async () => {
    fixture = await prepareR2Passed('r3-block-state');
    fixture.config.git.push = true;

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('UNSUPPORTED_PUSH');
    const state = JSON.parse(readFileSync(path.join(fixture.agentDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('BLOCKED');
    expect(state.last_error).toMatch(/git\.push is not supported/);
  }, 120000);

  it('checks the audited business diff before honoring noCommit', async () => {
    fixture = await prepareR2Passed('r3-nocommit-drift');
    writeFile(fixture.repoDir, 'src/feature.ts', 'export const feature = false;\n');

    const result = await runR3(fixture, { noCommit: true });

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.error_message).toMatch(/Business tracked diff content changed|Business changed-file metadata changed/);
    const state = JSON.parse(readFileSync(path.join(fixture.agentDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('BLOCKED');
    expect(state.commit_skipped).toBe(false);
  }, 120000);

  it('blocks fresh finalization when a required R3 artifact is missing', async () => {
    fixture = await prepareR2Passed('r3-missing-required-artifact');
    rmSync(path.join(fixture.repoDir, '.agent', 'task-results.json'));

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.error_message).toMatch(/Required R3 artifact/);
    expect(result.final_commit_sha).toBeNull();
    const state = JSON.parse(readFileSync(path.join(fixture.agentDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('BLOCKED');
    expect(git(fixture.repoDir, ['rev-parse', fixture.integrationBranch])).toBe(fixture.integrationHead);
  }, 120000);

  it('clears a stale final_commit_sha and reruns finalization when R2 evidence still validates', async () => {
    fixture = await prepareR2Passed('r3-resume-stale');
    const preTip = git(fixture.repoDir, ['rev-parse', fixture.integrationBranch]);

    // Simulate a crashed prior R3 that recorded a final_commit_sha which does
    // not exist in git. The integration branch is still at the R2 head and the
    // .agent artifacts are still untracked, so R2 evidence still validates.
    const fakeSha = 'a'.repeat(40);
    const statePath = path.join(fixture.agentDir, 'state.json');
    const staleState = JSON.parse(readFileSync(statePath, 'utf8'));
    staleState.phase = 'FINALIZING';
    staleState.final_commit_sha = fakeSha;
    writeFileSync(statePath, JSON.stringify(staleState, null, 2), 'utf8');

    const result = await runR3(fixture);

    expect(result.status).toBe('passed');
    expect(result.final_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.final_commit_sha).not.toBe(fakeSha);
    // A fresh commit was created on top of the R2 integration head.
    expect(result.final_commit_sha).not.toBe(preTip);
    expect(git(fixture.repoDir, ['rev-parse', fixture.integrationBranch])).toBe(result.final_commit_sha);
  }, 120000);

  it('does not accept a recorded final_commit_sha that is no longer the integration branch tip', async () => {
    fixture = await prepareR2Passed('r3-resume-not-tip');

    const first = await runR3(fixture);
    expect(first.status).toBe('passed');
    resetStateToFinalizing(fixture);

    writeFile(fixture.repoDir, 'src/after-final.ts', 'export const afterFinal = true;\n');
    git(fixture.repoDir, ['add', 'src/after-final.ts']);
    git(fixture.repoDir, ['commit', '-q', '-m', 'unaudited extra commit']);

    const second = await runR3(fixture);

    expect(second.status).toBe('blocked');
    expect(second.error_code).toBe('STATE_CONFLICT');
    expect(second.error_message).toMatch(/Integration branch head changed after R2 PASS/);
    const state = JSON.parse(readFileSync(path.join(fixture.agentDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('BLOCKED');
    expect(state.final_commit_sha).toBeNull();
  }, 120000);

  it('does not resume from a final_commit_sha missing required R3 artifacts', async () => {
    fixture = await prepareR2Passed('r3-resume-missing-artifact');
    const incompleteArtifacts = [
      '.agent/GOAL.md',
      '.agent/plan.md',
      '.agent/task-graph.json',
      '.agent/final-audit.md',
      '.agent/integration/integration-plan.json',
      '.agent/integration/cherry-pick-log.jsonl',
      '.agent/integration/integrated-diff-metadata.json',
      '.agent/integration/changed-files.json',
      '.agent/integration/untracked-files.json',
      '.agent/integration/diff-metadata.json',
      '.agent/integration/scope-report.json',
      '.agent/integration/verification-manifest.json',
      '.agent/integration/final-audit-context.json',
    ];
    git(fixture.repoDir, ['add', '-f', '--', ...incompleteArtifacts]);
    git(fixture.repoDir, ['commit', '-q', '-m', 'incomplete final commit']);
    const incompleteSha = git(fixture.repoDir, ['rev-parse', 'HEAD']);
    const statePath = path.join(fixture.agentDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    state.final_commit_sha = incompleteSha;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.final_commit_sha).toBeNull();
    expect(result.error_code).toBe('STATE_CONFLICT');
    const updatedState = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(updatedState.final_commit_sha).toBeNull();
  }, 120000);

  it('top-level task-graph FINALIZING resume uses R3 evidence instead of rerunning Final Auditor', async () => {
    fixture = await prepareR2Passed('r3-top-level-resume');
    const resumeConfig = structuredClone(fixture.config);
    resumeConfig.loop.max_agent_retries = 1;
    resumeConfig.parallel = { enabled: true, max_parallel_workers: 2 };
    const finalAuditorCommand = resumeConfig.agents.final_auditor.command;
    const behaviorIndex = finalAuditorCommand.indexOf('--behavior');
    expect(behaviorIndex).toBeGreaterThanOrEqual(0);
    finalAuditorCommand[behaviorIndex + 1] = 'audit-fail';
    const resumeConfigPath = path.join(fixture.agentDir, 'resume-review-loop.yaml');
    writeFileSync(resumeConfigPath, JSON.stringify(resumeConfig, null, 2), 'utf8');

    const statePath = path.join(fixture.agentDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    state.iteration = 1;
    state.final_commit_sha = null;
    state.final_commit_message = null;
    state.commit_skipped = false;
    state.skip_reason = null;
    state.finalized_at = null;
    state.task_graph_state = {
      current_task_index: 0,
      task_statuses: { 'task-1': 'passed' },
      task_attempts: { 'task-1': 1 },
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    const result = await runOrchestrator({
      project_root: fixture.repoDir,
      config_path: resumeConfigPath,
      task_slug: fixture.runId,
      max_iterations: 3,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: state.phase,
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(result.phase, result.message).toBe('PASSED');
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.branch).toBe(fixture.integrationBranch);
    const finalAudit = readFileSync(path.join(fixture.agentDir, 'final-audit.md'), 'utf8');
    expect(finalAudit).toContain('decision: "PASS"');
  }, 180000);

  it('top-level task-graph BLOCKED resume retries R3 tag handling instead of rerunning tasks', async () => {
    fixture = await prepareR2Passed('r3-top-level-tag-retry');
    const tagName = `agent-${fixture.runId}-pass`;
    git(fixture.repoDir, ['tag', tagName, fixture.baseCommit]);

    const first = await runR3(fixture, { tag: true });
    expect(first.status).toBe('blocked');
    expect(first.error_code).toBe('GIT_TAG_ERROR');
    expect(first.final_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.tag_name).toBe(tagName);

    git(fixture.repoDir, ['tag', '-d', tagName]);

    const resumeConfig = structuredClone(fixture.config);
    resumeConfig.loop.max_agent_retries = 1;
    resumeConfig.parallel = { enabled: true, max_parallel_workers: 2 };
    const finalAuditorCommand = resumeConfig.agents.final_auditor.command;
    const behaviorIndex = finalAuditorCommand.indexOf('--behavior');
    expect(behaviorIndex).toBeGreaterThanOrEqual(0);
    finalAuditorCommand[behaviorIndex + 1] = 'audit-fail';
    const resumeConfigPath = path.join(fixture.agentDir, 'resume-review-loop.yaml');
    writeFileSync(resumeConfigPath, JSON.stringify(resumeConfig, null, 2), 'utf8');

    const statePath = path.join(fixture.agentDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.phase).toBe('BLOCKED');
    expect(state.final_commit_sha).toBe(first.final_commit_sha);
    expect(state.tag_name).toBe(tagName);
    state.task_graph_state = {
      current_task_index: 0,
      task_statuses: { 'task-1': 'passed' },
      task_attempts: { 'task-1': 1 },
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    const result = await runOrchestrator({
      project_root: fixture.repoDir,
      config_path: resumeConfigPath,
      task_slug: fixture.runId,
      max_iterations: 3,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: state.phase,
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(result.phase, result.message).toBe('PASSED');
    expect(result.commit_sha).toBe(first.final_commit_sha);
    expect(result.tag_name).toBe(tagName);
    expect(result.tag_created).toBe(true);
    expect(git(fixture.repoDir, ['rev-list', '-n', '1', tagName])).toBe(first.final_commit_sha);
    const finalAudit = readFileSync(path.join(fixture.agentDir, 'final-audit.md'), 'utf8');
    expect(finalAudit).toContain('decision: "PASS"');
  }, 180000);

  it('top-level wave FINALIZING resume blocks missing R2 evidence without rerunning Final Auditor', async () => {
    fixture = await prepareR2Passed('r3-top-level-missing-evidence');
    const resumeConfig = structuredClone(fixture.config);
    resumeConfig.loop.max_agent_retries = 1;
    resumeConfig.parallel = { enabled: true, max_parallel_workers: 2 };
    const finalAuditorCommand = resumeConfig.agents.final_auditor.command;
    const behaviorIndex = finalAuditorCommand.indexOf('--behavior');
    expect(behaviorIndex).toBeGreaterThanOrEqual(0);
    finalAuditorCommand[behaviorIndex + 1] = 'audit-fail';
    const resumeConfigPath = path.join(fixture.agentDir, 'resume-review-loop.yaml');
    writeFileSync(resumeConfigPath, JSON.stringify(resumeConfig, null, 2), 'utf8');

    const metadataPath = path.join(fixture.repoDir, '.agent', 'integration', 'integrated-diff-metadata.json');
    rmSync(metadataPath);

    const statePath = path.join(fixture.agentDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.phase = 'FINALIZING';
    state.iteration = 1;
    state.final_commit_sha = null;
    state.final_commit_message = null;
    state.commit_skipped = false;
    state.skip_reason = null;
    state.finalized_at = null;
    state.task_graph_state = {
      current_task_index: 0,
      task_statuses: { 'task-1': 'passed' },
      task_attempts: { 'task-1': 1 },
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    const result = await runOrchestrator({
      project_root: fixture.repoDir,
      config_path: resumeConfigPath,
      task_slug: fixture.runId,
      max_iterations: 3,
      resume_from: {
        run_id: state.run_id,
        iteration: state.iteration,
        phase: state.phase,
        branch: state.branch,
        base_commit: state.base_commit,
        task_slug: state.task_slug,
        goal_digest: state.goal_digest,
      },
    });

    expect(result.phase).toBe('BLOCKED');
    expect(result.error?.code).toBe('STATE_CONFLICT');
    expect(result.message).toMatch(/R2 (integration )?evidence missing/);
    const finalAudit = readFileSync(path.join(fixture.agentDir, 'final-audit.md'), 'utf8');
    expect(finalAudit).toContain('decision: "PASS"');
    expect(git(fixture.repoDir, ['diff', '--cached', '--name-only'])).toBe('');
  }, 180000);

  it('does not commit when noCommit is requested', async () => {
    fixture = await prepareR2Passed('r3-nocommit');
    const preTip = git(fixture.repoDir, ['rev-parse', fixture.integrationBranch]);

    const result = await runR3(fixture, { noCommit: true });

    expect(result.status).toBe('passed');
    expect(result.final_commit_sha).toBeNull();
    expect(result.commit_skipped).toBe(true);
    expect(result.skip_reason).toMatch(/--no-commit|commit_on_pass/);
    // No new commit on the integration branch.
    expect(git(fixture.repoDir, ['rev-parse', fixture.integrationBranch])).toBe(preTip);
  }, 120000);
});
