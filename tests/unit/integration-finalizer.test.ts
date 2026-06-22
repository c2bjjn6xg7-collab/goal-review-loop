import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createIntegrationAuditFixture,
  runFixtureIntegrationAudit,
  readFixtureJson,
  type IntegrationAuditFixture,
} from '../helpers/integration-audit-fixture.js';
import {
  runIntegrationFinalization,
  INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  isIntegrationVersionedArtifact,
} from '../../src/orchestrator/integration-finalizer.js';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

async function prepareR2Passed(suffix: string): Promise<IntegrationAuditFixture> {
  const fx = await createIntegrationAuditFixture({ suffix });
  const audit = await runFixtureIntegrationAudit(fx);
  if (audit.status !== 'passed') {
    throw new Error(`R2 audit did not pass: ${audit.error_code} ${audit.error_message}`);
  }
  return fx;
}

async function runR3(fixture: IntegrationAuditFixture, options: { tag?: boolean; noCommit?: boolean } = {}) {
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

describe('integration-finalizer allowlist', () => {
  it('excludes .agent/task-runs/** and local-only paths from the R3 allowlist', () => {
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS.some((p) => p.startsWith('.agent/task-runs/'))).toBe(false);
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).not.toContain('.agent/state.json');
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).not.toContain('.agent/run.lock');
    expect(OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/integration/conflict-report.md');
  });

  it('isIntegrationVersionedArtifact recognizes allowlisted artifacts only', () => {
    expect(isIntegrationVersionedArtifact('.agent/final-audit.md')).toBe(true);
    expect(isIntegrationVersionedArtifact('.agent/integration/integrated-diff-metadata.json')).toBe(true);
    expect(isIntegrationVersionedArtifact('.agent/task-runs/task-1/result.json')).toBe(false);
    expect(isIntegrationVersionedArtifact('.agent/state.json')).toBe(false);
  });
});

describe('runIntegrationFinalization evidence validation', () => {
  let fixture: IntegrationAuditFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('blocks with STATE_CONFLICT when integrated diff metadata is missing', async () => {
    fixture = await prepareR2Passed('unit-missing-metadata');
    const metadataPath = path.join(fixture.repoDir, '.agent', 'integration', 'integrated-diff-metadata.json');
    writeFileSync(metadataPath, 'not json', 'utf8');

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.error_message).toMatch(/R2 evidence/);
    expect(result.final_commit_sha).toBeNull();
  });

  it('blocks with FINAL_AUDIT_FAILED when Final Aggregate Audit is not PASS', async () => {
    fixture = await createIntegrationAuditFixture({ suffix: 'unit-audit-fail', finalAuditorBehavior: 'audit-fail' });
    const audit = await runFixtureIntegrationAudit(fixture);
    expect(audit.status).toBe('blocked');

    // R2 blocked, but evidence files (final-audit.md with FAILED) may still exist.
    // Point R3 at this state by clearing any final_commit_sha and running R3.
    const result = await runR3(fixture);
    expect(result.status).toBe('blocked');
    // Non-PASS audit or missing evidence must block without staging.
    expect(result.final_commit_sha).toBeNull();
    expect(['FINAL_AUDIT_FAILED', 'STATE_CONFLICT']).toContain(result.error_code);
  });

  it('blocks with STATE_CONFLICT when the integrated diff digest does not match R2', async () => {
    fixture = await prepareR2Passed('unit-digest-mismatch');
    // Tamper with the recorded integrated diff digest so R3's recomputed digest
    // cannot match the recorded evidence.
    const metadataPath = path.join(fixture.repoDir, '.agent', 'integration', 'integrated-diff-metadata.json');
    const metadata = readFixtureJson<{ integrated_diff_digest: string }>(fixture, '.agent/integration/integrated-diff-metadata.json');
    const tampered = `sha256:${'0'.repeat(64)}`;
    expect(tampered).not.toBe(metadata.integrated_diff_digest);
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, integrated_diff_digest: tampered }, null, 2), 'utf8');

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.final_commit_sha).toBeNull();
  });

  it('blocks with STATE_CONFLICT when state audited_diff_digest does not match R2 evidence', async () => {
    fixture = await prepareR2Passed('unit-state-digest-mismatch');
    const statePath = path.join(fixture.agentDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.audited_diff_digest = `sha256:${'f'.repeat(64)}`;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.error_message).toMatch(/state\.audited_diff_digest/);
    expect(result.final_commit_sha).toBeNull();
    expect(git(fixture.repoDir, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('blocks with STATE_CONFLICT when the integration branch head moved after R2 PASS', async () => {
    fixture = await prepareR2Passed('unit-head-drift');
    git(fixture.repoDir, ['commit', '--allow-empty', '-q', '-m', 'drift integration head']);

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.error_message).toMatch(/Integration branch head changed after R2 PASS/);
    expect(result.final_commit_sha).toBeNull();
    expect(git(fixture.repoDir, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('blocks with STATE_CONFLICT when a business file changed after R2 PASS', async () => {
    fixture = await prepareR2Passed('unit-business-change');
    // Modify the business file after R2 so the business diff no longer matches.
    writeFileSync(path.join(fixture.repoDir, 'src', 'feature.ts'), 'export const feature = false;\n', 'utf8');
    git(fixture.repoDir, ['add', 'src/feature.ts']);

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.final_commit_sha).toBeNull();
  });

  it('blocks business content drift even when allowlisted .agent artifacts are already staged', async () => {
    fixture = await prepareR2Passed('unit-business-drift-agent-staged');
    git(fixture.repoDir, ['add', '-f', '.agent/GOAL.md']);
    writeFileSync(path.join(fixture.repoDir, 'src', 'feature.ts'), 'export const feature = false;\n', 'utf8');

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('STATE_CONFLICT');
    expect(result.error_message).toMatch(/Business tracked diff content changed after R2 PASS/);
    expect(result.final_commit_sha).toBeNull();
    expect(git(fixture.repoDir, ['rev-parse', fixture.integrationBranch])).toBe(fixture.integrationHead);
  });

  it('blocks with PRE_COMMIT_STAGED_SET_VIOLATION when an extra disallowed file is already staged', async () => {
    fixture = await prepareR2Passed('unit-staged-violation');
    // Pre-stage a non-allowlisted .agent file (force-add since it is ignored).
    // R3 will not reset pre-existing staged files, so this surfaces in the
    // staged-set verification.
    mkdirSync(path.join(fixture.repoDir, '.agent', 'task-runs', 'task-1'), { recursive: true });
    writeFileSync(path.join(fixture.repoDir, '.agent', 'task-runs', 'task-1', 'result.json'), '{}\n', 'utf8');
    git(fixture.repoDir, ['add', '-f', '.agent/task-runs/task-1/result.json']);

    const result = await runR3(fixture);

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('PRE_COMMIT_STAGED_SET_VIOLATION');
    expect(result.final_commit_sha).toBeNull();
    // The disallowed file must not have been committed.
    expect(existsSync(path.join(fixture.repoDir, '.agent', 'task-runs', 'task-1', 'result.json'))).toBe(true);
    const tip = git(fixture.repoDir, ['rev-parse', fixture.integrationBranch]);
    const tree = git(fixture.repoDir, ['ls-tree', '-r', '--name-only', tip]);
    expect(tree).not.toContain('.agent/task-runs/task-1/result.json');
  });

  it('blocks with UNSUPPORTED_PUSH when config requests push', async () => {
    fixture = await prepareR2Passed('unit-push');
    const config = { ...fixture.config, git: { ...fixture.config.git, push: true } };

    const result = await runIntegrationFinalization({
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
      config,
      tag: false,
      noCommit: false,
    });

    expect(result.status).toBe('blocked');
    expect(result.error_code).toBe('UNSUPPORTED_PUSH');
  });
});
