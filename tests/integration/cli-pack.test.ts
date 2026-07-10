import { describe, it, expect, afterAll } from 'vitest';
import crossSpawn from 'cross-spawn';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

function runChecked(command: string, args: string[], cwd: string, timeout: number): string {
  const result = crossSpawn.sync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr ?? `Command exited with ${result.status}`));
  }
  return String(result.stdout ?? '');
}

/**
 * Integration test: pack, install, and run the real CLI binary.
 * This verifies that package.json bin, build lifecycle, and files whitelist
 * produce a working installed command.
 */
describe('CLI Integration: pack, install, and run', () => {
  const projectRoot = path.resolve(import.meta.dirname, '../..');
  let tmpDir: string;
  // Build and pack before tests
  const packDestination = os.tmpdir();
  const packResult = runChecked(
    'npm', ['pack', '--pack-destination', packDestination], projectRoot, 60_000,
  );
  const tarballPath = path.join(packDestination, packResult.trim().split(/\r?\n/).pop()!);

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
    runChecked('git', ['init', '-b', 'main'], testProject, 10_000);

    // Install the tarball
    runChecked('npm', ['install', tarballPath], testProject, 120_000);

    // Run review-loop init
    const binName = process.platform === 'win32' ? 'review-loop.cmd' : 'review-loop';
    const binPath = path.join(testProject, 'node_modules', '.bin', binName);
    const result = runChecked(binPath, ['init'], testProject, 30_000);

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
    expect(gitignore).toContain('.agent/**');
    expect(gitignore).toContain('!.agent/.gitkeep');
  });
});
