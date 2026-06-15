import { describe, it, expect, afterEach } from 'vitest';
import {
  renderCommitMessage,
  renderTagName,
  isLocalOnlyPath,
  findStagedSetViolations,
  buildAllowedCommitSet,
  VERSIONED_ARTIFACT_PATHS,
  createCommit,
  createTag,
  commitExists,
  verifyCommitTree,
  getHeadSha,
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
