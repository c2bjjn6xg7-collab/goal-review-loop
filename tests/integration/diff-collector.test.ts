import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { collectDiff, writeDiffArtifacts } from '../../src/git/diff-collector.js';
import { runGit } from '../../src/git/git-manager.js';

describe('DiffCollector', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-collector-test-'));
    const projectPath = path.join(tmpDir, 'project');
    await fs.ensureDir(projectPath);
    await initGitRepo(projectPath);
    projectRoot = await fs.realpath(projectPath);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function initGitRepo(dir: string): Promise<void> {
    await runGit(['init'], dir);
    await runGit(['config', 'user.email', 'test@test.com'], dir);
    await runGit(['config', 'user.name', 'Test'], dir);
    await fs.writeFile(path.join(dir, 'README.md'), '# Test');
    await runGit(['add', 'README.md'], dir);
    await runGit(['commit', '-m', 'Initial commit'], dir);
  }

  it('should collect no changes for clean repo', async () => {
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);
    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result.changedFiles.files).toHaveLength(0);
    expect(result.untrackedFiles.files).toHaveLength(0);
    expect(result.diffMetadata.changed_files_summary.total).toBe(0);
  });

  it('should collect tracked modifications', async () => {
    await fs.writeFile(path.join(projectRoot, 'README.md'), '# Modified');
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result.changedFiles.files).toHaveLength(1);
    expect(result.changedFiles.files[0].path).toBe('README.md');
    expect(result.changedFiles.files[0].status).toBe('modified');
    expect(result.changedFiles.files[0].additions).toBeGreaterThan(0);
  });

  it('should collect tracked additions', async () => {
    await fs.writeFile(path.join(projectRoot, 'new-file.ts'), 'export const x = 1;');
    await runGit(['add', 'new-file.ts'], projectRoot);
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result.changedFiles.files).toHaveLength(1);
    expect(result.changedFiles.files[0].path).toBe('new-file.ts');
    expect(result.changedFiles.files[0].status).toBe('added');
  });

  it('should collect tracked deletions', async () => {
    await fs.remove(path.join(projectRoot, 'README.md'));
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result.changedFiles.files).toHaveLength(1);
    expect(result.changedFiles.files[0].path).toBe('README.md');
    expect(result.changedFiles.files[0].status).toBe('deleted');
  });

  it('should collect tracked renames', async () => {
    await fs.rename(
      path.join(projectRoot, 'README.md'),
      path.join(projectRoot, 'DOCS.md'),
    );
    await runGit(['add', '-A'], projectRoot);
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    const renamedFile = result.changedFiles.files.find((f) => f.status === 'renamed');
    expect(renamedFile).toBeTruthy();
    expect(renamedFile?.old_path).toBe('README.md');
    expect(renamedFile?.path).toBe('DOCS.md');
  });

  it('should collect untracked text files', async () => {
    await fs.writeFile(path.join(projectRoot, 'untracked.ts'), 'export const y = 2;');
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result.untrackedFiles.files).toHaveLength(1);
    expect(result.untrackedFiles.files[0].path).toBe('untracked.ts');
    expect(result.untrackedFiles.files[0].is_text).toBe(true);
    expect(result.untrackedFiles.files[0].has_content).toBe(true);
    expect(result.untrackedFiles.files[0].content).toBe('export const y = 2;');

    expect(result.changedFiles.files).toHaveLength(1);
    expect(result.changedFiles.files[0].path).toBe('untracked.ts');
    expect(result.changedFiles.files[0].status).toBe('untracked');
    expect(result.changedFiles.files[0].tracked).toBe(false);
  });

  it('should collect untracked binary files', async () => {
    const binaryData = Buffer.from([0, 1, 2, 3, 0, 4, 5]);
    await fs.writeFile(path.join(projectRoot, 'image.png'), binaryData);
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result.untrackedFiles.files).toHaveLength(1);
    expect(result.untrackedFiles.files[0].path).toBe('image.png');
    expect(result.untrackedFiles.files[0].is_text).toBe(false);
    expect(result.untrackedFiles.files[0].has_content).toBe(false);
    expect(result.untrackedFiles.files[0].sha256).toBeTruthy();
  });

  it('should write real diff to tracked.diff', async () => {
    await fs.writeFile(path.join(projectRoot, 'README.md'), '# Modified');
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    await writeDiffArtifacts(projectRoot, 1, result);

    const trackedDiff = await fs.readFile(
      path.join(projectRoot, '.agent', 'evidence', 'iteration-01', 'tracked.diff'),
      'utf8',
    );
    expect(trackedDiff).toContain('diff --git');
    expect(trackedDiff).toContain('README.md');
  });

  it('should produce stable digest for same state', async () => {
    await fs.writeFile(path.join(projectRoot, 'new.ts'), 'const x = 1;');
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result1 = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    const result2 = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result1.diffDigest).toBe(result2.diffDigest);
  });

  it('should change digest when content changes', async () => {
    await fs.writeFile(path.join(projectRoot, 'new.ts'), 'const x = 1;');
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result1 = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    await fs.writeFile(path.join(projectRoot, 'new.ts'), 'const x = 2;');
    const result2 = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    expect(result1.diffDigest).not.toBe(result2.diffDigest);
  });

  it('should write artifacts to evidence directory', async () => {
    await fs.writeFile(path.join(projectRoot, 'new.ts'), 'const x = 1;');
    const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

    const result = await collectDiff({
      projectRoot,
      baseCommit: headResult.stdout,
      iteration: 1,
    });

    await writeDiffArtifacts(projectRoot, 1, result);

    const evidenceDir = path.join(projectRoot, '.agent', 'evidence', 'iteration-01');
    expect(await fs.pathExists(path.join(evidenceDir, 'changed-files.json'))).toBe(true);
    expect(await fs.pathExists(path.join(evidenceDir, 'untracked-files.json'))).toBe(true);
    expect(await fs.pathExists(path.join(evidenceDir, 'diff-metadata.json'))).toBe(true);

    const changedFiles = await fs.readJSON(path.join(evidenceDir, 'changed-files.json'));
    expect(changedFiles.schema_version).toBe(1);
    expect(changedFiles.base_commit).toBeTruthy();
  });

    it('should handle files with special characters', async () => {
      await fs.writeFile(path.join(projectRoot, 'file with spaces.ts'), 'const x = 1;');
      await fs.writeFile(path.join(projectRoot, 'file-with-中文.ts'), 'const y = 2;');

      const headResult = await runGit(['rev-parse', 'HEAD'], projectRoot);

      const result = await collectDiff({
        projectRoot,
        baseCommit: headResult.stdout,
        iteration: 1,
      });

      expect(result.untrackedFiles.files).toHaveLength(2);
      const paths = result.untrackedFiles.files.map((f) => f.path);
      expect(paths).toContain('file with spaces.ts');
      expect(paths).toContain('file-with-中文.ts');
    });
});
