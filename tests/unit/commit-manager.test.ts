import { describe, it, expect, afterEach } from 'vitest';
import {
  renderCommitMessage,
  renderTagName,
  isLocalOnlyPath,
  findStagedSetViolations,
  buildAllowedCommitSet,
  VERSIONED_ARTIFACT_PATHS,
  INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  isIntegrationVersionedArtifact,
  stageFiles,
  stageFilesControlled,
  createCommit,
  createTag,
  commitExists,
  verifyCommitTree,
  getHeadSha,
  getStagedFiles,
} from '../../src/git/commit-manager.js';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createTestRepo(suffix: string): string {
  const repoDir = join(tmpdir(), `commit-mgr-test-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Test\n');
  execSync('git add -A && git commit -m "initial"', { cwd: repoDir });
  return repoDir;
}

let cleanupDirs: string[] = [];

describe('renderCommitMessage', () => {
  it('replaces all known placeholders', () => {
    const template = 'feat(agent): complete {task_slug} [{run_id}] iter={iteration} digest={short_goal_digest}';
    const result = renderCommitMessage(template, {
      task_slug: 'my-task',
      run_id: 'run-001',
      iteration: 2,
      short_goal_digest: 'abc123def456',
    });
    expect(result).toBe('feat(agent): complete my-task [run-001] iter=2 digest=abc123def456');
  });

  it('throws on unknown placeholder', () => {
    const template = 'feat: {unknown_placeholder}';
    expect(() => renderCommitMessage(template, {
      task_slug: 't',
      run_id: 'r',
      iteration: 1,
      short_goal_digest: 'abc',
    })).toThrow(/Unknown commit message placeholder/);
  });

  it('handles template with no placeholders', () => {
    const template = 'feat: simple commit';
    const result = renderCommitMessage(template, {
      task_slug: 't',
      run_id: 'r',
      iteration: 1,
      short_goal_digest: 'abc',
    });
    expect(result).toBe('feat: simple commit');
  });

  it('handles repeated placeholders', () => {
    const template = '{run_id}-{run_id}';
    const result = renderCommitMessage(template, {
      task_slug: 't',
      run_id: 'abc',
      iteration: 1,
      short_goal_digest: 'def',
    });
    expect(result).toBe('abc-abc');
  });
});

describe('renderTagName', () => {
  it('replaces known placeholders', () => {
    const template = 'agent-{run_id}-pass';
    const result = renderTagName(template, {
      run_id: 'run-001',
      task_slug: 'my-task',
    });
    expect(result).toBe('agent-run-001-pass');
  });

  it('throws on unknown placeholder', () => {
    const template = 'tag-{unknown}';
    expect(() => renderTagName(template, {
      run_id: 'r',
      task_slug: 't',
    })).toThrow(/Unknown tag name placeholder/);
  });
});

describe('isLocalOnlyPath', () => {
  it('identifies state.json as local-only', () => {
    expect(isLocalOnlyPath('.agent/state.json')).toBe(true);
  });

  it('identifies run.lock as local-only', () => {
    expect(isLocalOnlyPath('.agent/run.lock')).toBe(true);
  });

  it('identifies cancel-request.json as local-only', () => {
    expect(isLocalOnlyPath('.agent/cancel-request.json')).toBe(true);
  });

  it('identifies iteration-log.md as local-only', () => {
    expect(isLocalOnlyPath('.agent/iteration-log.md')).toBe(true);
  });

  it('identifies verification/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/verification/manifest.json')).toBe(true);
    expect(isLocalOnlyPath('.agent/verification')).toBe(true);
  });

  it('identifies evidence/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/evidence/scope-report.json')).toBe(true);
  });

  it('identifies history/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/history/iteration-01/handoff.md')).toBe(true);
  });

  it('identifies debug/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/debug/prompt.md')).toBe(true);
  });

  it('identifies node_modules/ as local-only', () => {
    expect(isLocalOnlyPath('node_modules/foo/index.js')).toBe(true);
  });

  it('identifies dist/ as local-only', () => {
    expect(isLocalOnlyPath('dist/index.js')).toBe(true);
  });

  it('does not flag versioned artifacts', () => {
    expect(isLocalOnlyPath('.agent/plan.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/GOAL.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/developer-handoff.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/audit-report.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/final-audit.md')).toBe(false);
  });

  it('does not flag business files', () => {
    expect(isLocalOnlyPath('src/index.ts')).toBe(false);
    expect(isLocalOnlyPath('tests/foo.test.ts')).toBe(false);
  });
});

describe('findStagedSetViolations', () => {
  it('returns empty for all-allowed files', () => {
    const allowed = new Set(['src/foo.ts', '.agent/plan.md']);
    const staged = ['src/foo.ts', '.agent/plan.md'];
    expect(findStagedSetViolations(staged, allowed)).toEqual([]);
  });

  it('returns violations for disallowed files', () => {
    const allowed = new Set(['src/foo.ts']);
    const staged = ['src/foo.ts', '.agent/state.json'];
    expect(findStagedSetViolations(staged, allowed)).toEqual(['.agent/state.json']);
  });

  it('returns empty for empty staged set', () => {
    const allowed = new Set(['src/foo.ts']);
    expect(findStagedSetViolations([], allowed)).toEqual([]);
  });
});

describe('buildAllowedCommitSet', () => {
  it('combines versioned artifacts and business files', () => {
    const versioned = ['.agent/plan.md', '.agent/GOAL.md'];
    const business = ['src/foo.ts', 'tests/bar.test.ts'];
    const allowed = buildAllowedCommitSet(versioned, business);
    expect(allowed.has('.agent/plan.md')).toBe(true);
    expect(allowed.has('.agent/GOAL.md')).toBe(true);
    expect(allowed.has('src/foo.ts')).toBe(true);
    expect(allowed.has('tests/bar.test.ts')).toBe(true);
    expect(allowed.has('.agent/state.json')).toBe(false);
  });
});

describe('VERSIONED_ARTIFACT_PATHS', () => {
  it('includes all required versioned artifacts', () => {
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/plan.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/GOAL.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/developer-handoff.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/audit-report.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/final-audit.md');
  });
});

afterEach(() => {
  for (const dir of cleanupDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
  cleanupDirs = [];
});

describe('createCommit', () => {
  it('creates a commit and returns a valid SHA', async () => {
    const repoDir = createTestRepo('cc-ok');
    cleanupDirs.push(repoDir);

    writeFileSync(join(repoDir, 'src.ts'), 'export const x = 1;\n');
    execSync('git add src.ts', { cwd: repoDir });

    const result = await createCommit(repoDir, 'feat: add src');
    expect(result.success).toBe(true);
    expect(result.commitSha).toBeTruthy();
    expect(result.commitSha!.length).toBe(40);

    const exists = await commitExists(repoDir, result.commitSha!);
    expect(exists).toBe(true);
  });

  it('returns failure when git commit fails', async () => {
    const repoDir = createTestRepo('cc-fail');
    cleanupDirs.push(repoDir);

    // Nothing staged → git commit with --no-verify still succeeds with "nothing to commit"
    // but returns exit code 1 on some git versions. To force failure,
    // make .git/objects read-only so object creation fails.
    const objectsDir = join(repoDir, '.git', 'objects');
    writeFileSync(join(repoDir, 'new-file.ts'), 'export const y = 2;\n');
    execSync('git add new-file.ts', { cwd: repoDir });
    chmodSync(objectsDir, 0o555);

    try {
      const result = await createCommit(repoDir, 'feat: should fail');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      chmodSync(objectsDir, 0o755);
    }
  });
});

describe('createTag', () => {
  it('creates a tag pointing to the specified commit', async () => {
    const repoDir = createTestRepo('ct-ok');
    cleanupDirs.push(repoDir);

    const sha = await getHeadSha(repoDir);
    expect(sha).toBeTruthy();

    const result = await createTag(repoDir, 'v1.0.0', sha!);
    expect(result.success).toBe(true);
  });

  it('returns failure when tag name is invalid or duplicate', async () => {
    const repoDir = createTestRepo('ct-fail');
    cleanupDirs.push(repoDir);

    const sha = await getHeadSha(repoDir);

    // Create tag first
    await createTag(repoDir, 'v1.0.0', sha!);

    // Creating same tag again should fail
    const result = await createTag(repoDir, 'v1.0.0', sha!);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('commitExists', () => {
  it('returns true for an existing commit', async () => {
    const repoDir = createTestRepo('ce-ok');
    cleanupDirs.push(repoDir);

    const sha = await getHeadSha(repoDir);
    expect(await commitExists(repoDir, sha!)).toBe(true);
  });

  it('returns false for a non-existent commit', async () => {
    const repoDir = createTestRepo('ce-missing');
    cleanupDirs.push(repoDir);

    const fakeSha = 'a'.repeat(40);
    expect(await commitExists(repoDir, fakeSha)).toBe(false);
  });
});

describe('verifyCommitTree', () => {
  it('returns valid when all required paths exist in the commit tree', async () => {
    const repoDir = createTestRepo('vct-ok');
    cleanupDirs.push(repoDir);

    // Add required files
    mkdirSync(join(repoDir, '.agent'), { recursive: true });
    writeFileSync(join(repoDir, '.agent', 'plan.md'), '# Plan\n');
    writeFileSync(join(repoDir, '.agent', 'GOAL.md'), '# Goal\n');
    execSync('git add -A && git commit -m "add artifacts"', { cwd: repoDir });

    const sha = await getHeadSha(repoDir);
    const result = await verifyCommitTree(repoDir, sha!, ['.agent/plan.md', '.agent/GOAL.md']);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns missing paths when required files are absent', async () => {
    const repoDir = createTestRepo('vct-missing');
    cleanupDirs.push(repoDir);

    const sha = await getHeadSha(repoDir);
    const result = await verifyCommitTree(repoDir, sha!, ['.agent/plan.md', '.agent/GOAL.md', '.agent/final-audit.md']);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain('.agent/plan.md');
    expect(result.missing).toContain('.agent/GOAL.md');
    expect(result.missing).toContain('.agent/final-audit.md');
  });
});

describe('INTEGRATION_VERSIONED_ARTIFACT_PATHS allowlist', () => {
  it('includes core R3 versioned artifacts and excludes task-runs', () => {
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/GOAL.md');
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/plan.md');
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/final-audit.md');
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/integration/integration-plan.json');
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/integration/integrated-diff-metadata.json');
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/integration/final-audit-context.json');
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS).not.toContain('.agent/state.json');
    // .agent/task-runs/** must never be allowlisted
    expect(INTEGRATION_VERSIONED_ARTIFACT_PATHS.some((p) => p.startsWith('.agent/task-runs/'))).toBe(false);
  });

  it('optional artifacts include conflict-report and excluded-tasks', () => {
    expect(OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/integration/conflict-report.md');
    expect(OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS).toContain('.agent/integration/excluded-tasks.md');
  });
});

describe('isIntegrationVersionedArtifact', () => {
  it('recognizes allowlisted artifacts', () => {
    expect(isIntegrationVersionedArtifact('.agent/final-audit.md')).toBe(true);
    expect(isIntegrationVersionedArtifact('.agent/integration/integration-plan.json')).toBe(true);
    expect(isIntegrationVersionedArtifact('.agent/integration/conflict-report.md')).toBe(true);
  });

  it('rejects non-allowlisted paths', () => {
    expect(isIntegrationVersionedArtifact('.agent/state.json')).toBe(false);
    expect(isIntegrationVersionedArtifact('.agent/task-runs/task-1/result.json')).toBe(false);
    expect(isIntegrationVersionedArtifact('.agent/audit-report.md')).toBe(false);
    expect(isIntegrationVersionedArtifact('src/index.ts')).toBe(false);
  });
});

function createTestRepoWithAgentIgnore(suffix: string): string {
  const repoDir = join(tmpdir(), `commit-mgr-force-${suffix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, '.gitignore'), '.agent/**\nnode_modules/**\ndist/**\n', 'utf8');
  writeFileSync(join(repoDir, 'README.md'), '# Test\n');
  execSync('git add -A && git commit -m "initial"', { cwd: repoDir });
  return repoDir;
}

describe('stageFilesControlled (Phase 8E R3 force-add)', () => {
  it('stages ordinary business files with precise pathspecs (no force)', async () => {
    const repoDir = createTestRepoWithAgentIgnore('biz');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const x = 1;\n');

    const result = await stageFilesControlled(repoDir, [
      { path: 'src/feature.ts', force: false },
    ]);
    expect(result.success).toBe(true);

    const staged = await getStagedFiles(repoDir);
    expect(staged).toContain('src/feature.ts');
  });

  it('stages allowlisted ignored .agent artifacts with force mode', async () => {
    const repoDir = createTestRepoWithAgentIgnore('force-ok');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.agent', 'integration'), { recursive: true });
    writeFileSync(join(repoDir, '.agent', 'final-audit.md'), '# final\n');
    writeFileSync(join(repoDir, '.agent', 'integration', 'integration-plan.json'), '{}\n');

    // Sanity: plain git add would refuse the ignored file
    expect(execSync('git check-ignore .agent/final-audit.md', { cwd: repoDir }).toString().trim()).toBe('.agent/final-audit.md');

    const result = await stageFilesControlled(repoDir, [
      { path: '.agent/final-audit.md', force: true },
      { path: '.agent/integration/integration-plan.json', force: true },
    ]);
    expect(result.success).toBe(true);

    const staged = await getStagedFiles(repoDir);
    expect(staged).toContain('.agent/final-audit.md');
    expect(staged).toContain('.agent/integration/integration-plan.json');
  });

  it('stages allowlisted .agent artifacts even with force:false (ignored files require -f)', async () => {
    const repoDir = createTestRepoWithAgentIgnore('force-implicit');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.agent'), { recursive: true });
    writeFileSync(join(repoDir, '.agent', 'plan.md'), '# plan\n');

    const result = await stageFilesControlled(repoDir, [
      { path: '.agent/plan.md', force: false },
    ]);
    expect(result.success).toBe(true);
    expect(await getStagedFiles(repoDir)).toContain('.agent/plan.md');
  });

  it('rejects non-allowlisted .agent paths before invoking git', async () => {
    const repoDir = createTestRepoWithAgentIgnore('reject-agent');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.agent', 'task-runs', 'task-1'), { recursive: true });
    writeFileSync(join(repoDir, '.agent', 'task-runs', 'task-1', 'result.json'), '{}\n');
    writeFileSync(join(repoDir, '.agent', 'audit-report.md'), '# audit\n');

    const taskRuns = await stageFilesControlled(repoDir, [
      { path: '.agent/task-runs/task-1/result.json', force: true },
    ]);
    expect(taskRuns.success).toBe(false);
    expect(taskRuns.error).toMatch(/non-allowlisted .agent path/);

    const auditReport = await stageFilesControlled(repoDir, [
      { path: '.agent/audit-report.md', force: true },
    ]);
    expect(auditReport.success).toBe(false);
    expect(auditReport.error).toMatch(/non-allowlisted .agent path/);

    // Nothing was staged
    expect(await getStagedFiles(repoDir)).toEqual([]);
  });

  it('prevalidates the full batch so a later invalid entry leaves no partial staged files', async () => {
    const repoDir = createTestRepoWithAgentIgnore('prevalidate-batch');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    mkdirSync(join(repoDir, '.agent'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const x = 1;\n');
    writeFileSync(join(repoDir, '.agent', 'state.json'), '{}\n');

    const result = await stageFilesControlled(repoDir, [
      { path: 'src/feature.ts', force: false },
      { path: '.agent/state.json', force: false },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/local-only/);
    expect(await getStagedFiles(repoDir)).toEqual([]);
  });

  it('rejects local-only runtime artifacts before invoking git', async () => {
    const repoDir = createTestRepoWithAgentIgnore('reject-local');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.agent'), { recursive: true });
    writeFileSync(join(repoDir, '.agent', 'state.json'), '{}\n');
    mkdirSync(join(repoDir, 'dist'), { recursive: true });
    writeFileSync(join(repoDir, 'dist', 'index.js'), '/* built */\n');

    const stateResult = await stageFilesControlled(repoDir, [
      { path: '.agent/state.json', force: false },
    ]);
    expect(stateResult.success).toBe(false);
    expect(stateResult.error).toMatch(/local-only|non-allowlisted/);

    const distResult = await stageFilesControlled(repoDir, [
      { path: 'dist/index.js', force: false },
    ]);
    expect(distResult.success).toBe(false);
    expect(distResult.error).toMatch(/local-only/);

    expect(await getStagedFiles(repoDir)).toEqual([]);
  });

  it('rejects force:true for business paths (force only for allowlisted .agent)', async () => {
    const repoDir = createTestRepoWithAgentIgnore('reject-force-biz');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const x = 1;\n');

    const result = await stageFilesControlled(repoDir, [
      { path: 'src/feature.ts', force: true },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Force-add is only permitted for allowlisted/);
    expect(await getStagedFiles(repoDir)).toEqual([]);
  });

  it('never uses git add -A / git add . (precise pathspecs only)', async () => {
    const repoDir = createTestRepoWithAgentIgnore('precise');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'a.ts'), 'a;\n');
    writeFileSync(join(repoDir, 'src', 'b.ts'), 'b;\n');

    const result = await stageFilesControlled(repoDir, [
      { path: 'src/a.ts', force: false },
    ]);
    expect(result.success).toBe(true);
    // Only the requested file is staged, not src/b.ts
    const staged = await getStagedFiles(repoDir);
    expect(staged).toEqual(['src/a.ts']);
  });
});

describe('stageFiles (compatibility)', () => {
  it('remains compatible with existing callers (plain path array)', async () => {
    const repoDir = createTestRepoWithAgentIgnore('compat');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const x = 1;\n');

    const result = await stageFiles(repoDir, ['src/feature.ts']);
    expect(result.success).toBe(true);
    expect(await getStagedFiles(repoDir)).toContain('src/feature.ts');
  });

  it('force-adds ignored versioned .agent artifacts for existing finalization callers', async () => {
    const repoDir = createTestRepoWithAgentIgnore('compat-agent-artifacts');
    cleanupDirs.push(repoDir);

    mkdirSync(join(repoDir, '.agent'), { recursive: true });
    writeFileSync(join(repoDir, '.agent', 'plan.md'), '# plan\n');
    writeFileSync(join(repoDir, '.agent', 'GOAL.md'), '# goal\n');
    writeFileSync(join(repoDir, '.agent', 'developer-handoff.md'), '# handoff\n');
    writeFileSync(join(repoDir, '.agent', 'audit-report.md'), '# audit\n');
    writeFileSync(join(repoDir, '.agent', 'final-audit.md'), '# final\n');

    const result = await stageFiles(repoDir, [
      '.agent/plan.md',
      '.agent/GOAL.md',
      '.agent/developer-handoff.md',
      '.agent/audit-report.md',
      '.agent/final-audit.md',
    ]);

    expect(result.success).toBe(true);
    expect(await getStagedFiles(repoDir)).toEqual([
      '.agent/GOAL.md',
      '.agent/audit-report.md',
      '.agent/developer-handoff.md',
      '.agent/final-audit.md',
      '.agent/plan.md',
    ]);
  });

  it('returns success for an empty path list without invoking git', async () => {
    const repoDir = createTestRepoWithAgentIgnore('empty');
    cleanupDirs.push(repoDir);
    const result = await stageFiles(repoDir, []);
    expect(result.success).toBe(true);
  });
});
