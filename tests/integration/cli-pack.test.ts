import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

/**
 * Integration test: pack, install, and run the real CLI binary.
 * This verifies that package.json bin, build lifecycle, and files whitelist
 * produce a working installed command.
 */
describe('CLI Integration: pack, install, and run', () => {
  const projectRoot = path.resolve(import.meta.dirname, '../..');
  let tmpDir: string;
  // Build and pack before tests
  const packResult = execFileSync('npm', ['pack', '--pack-destination=/tmp'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60000,
  });
  const tarballPath = path.join('/tmp', packResult.trim().split('\n').pop()!);

  afterAll(async () => {
    // Cleanup
    if (tarballPath) {
      await fs.remove(tarballPath).catch(() => {});
    }
    if (tmpDir) {
      await fs.remove(tmpDir).catch(() => {});
    }
  });

  it('should create a valid tarball', () => {
    expect(tarballPath).toMatch(/goal-review-loop-.*\.tgz$/);
    expect(fs.pathExistsSync(tarballPath)).toBe(true);
  });

  it('should install and run review-loop init in a temp git repo', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-integ-'));
    const testProject = path.join(tmpDir, 'test-project');

    // Create a git repo
    await fs.ensureDir(testProject);
    execFileSync('git', ['init'], { cwd: testProject, timeout: 10000 });

    // Install the tarball
    execFileSync('npm', ['install', tarballPath], {
      cwd: testProject,
      encoding: 'utf8',
      timeout: 120000,
    });

    // Run review-loop init
    const binPath = path.join(testProject, 'node_modules', '.bin', 'review-loop');
    const result = execFileSync(binPath, ['init'], {
      cwd: testProject,
      encoding: 'utf8',
      timeout: 30000,
    });

    // Verify output
    expect(result).toContain('Goal Review Loop initialized successfully');

    // Verify files created
    expect(await fs.pathExists(path.join(testProject, '.agent'))).toBe(true);
    expect(await fs.pathExists(path.join(testProject, '.agent', 'verification'))).toBe(true);
    expect(await fs.pathExists(path.join(testProject, '.agent', 'history'))).toBe(true);
    expect(await fs.pathExists(path.join(testProject, 'review-loop.yaml'))).toBe(true);
    expect(await fs.pathExists(path.join(testProject, '.gitignore'))).toBe(true);

    // Verify .gitignore content (init adds .agent local runtime files)
    const gitignore = await fs.readFile(path.join(testProject, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.agent/state.json');
    expect(gitignore).toContain('.agent/verification');
  });
});