import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { runVerification, VerificationRunnerError } from '../../src/verification/verification-runner.js';
import { ProcessStatus } from '../../src/types.js';
import type { VerificationCommand } from '../../src/types.js';

describe('VerificationRunner', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-runner-test-'));
    projectRoot = tmpDir;
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  const createCommand = (overrides: Partial<VerificationCommand> = {}): VerificationCommand => ({
    id: 'test-cmd',
    argv: ['echo', 'hello'],
    cwd: '.',
    required: true,
    timeout_seconds: 10,
    ...overrides,
  });

  it('should run a successful command', async () => {
    const result = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [createCommand()],
    });

    expect(result.passed).toBe(true);
    expect(result.manifest.commands).toHaveLength(1);
    expect(result.manifest.commands[0].status).toBe('success');
    expect(result.manifest.commands[0].exit_code).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it('should fail on required command failure', async () => {
    const result = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [createCommand({ argv: ['bash', '-c', 'exit 1'] })],
    });

    expect(result.passed).toBe(false);
    expect(result.manifest.commands[0].status).toBe('failed');
    expect(result.manifest.commands[0].exit_code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].command_id).toBe('test-cmd');
  });

  it('should pass when optional command fails', async () => {
    const result = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [
        createCommand({ id: 'required-cmd', required: true }),
        createCommand({
          id: 'optional-cmd',
          required: false,
          argv: ['bash', '-c', 'exit 1'],
        }),
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.manifest.commands).toHaveLength(2);
    expect(result.manifest.commands[0].status).toBe('success');
    expect(result.manifest.commands[1].status).toBe('failed');
    expect(result.findings).toHaveLength(0);
  });

  it('should handle timeout', async () => {
    const result = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [createCommand({
        argv: ['bash', '-c', 'sleep 30'],
        timeout_seconds: 1,
      })],
    });

    expect(result.passed).toBe(false);
    expect(result.manifest.commands[0].status).toBe('timeout');
    expect(result.manifest.commands[0].timed_out).toBe(true);
  }, 10000);

  it('should handle cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [
        createCommand({ argv: ['bash', '-c', 'sleep 30'] }),
        createCommand({ id: 'cmd-2', argv: ['echo', 'hello'] }),
      ],
      signal: controller.signal,
    });

    expect(result.passed).toBe(false);
  }, 10000);

  it('should reject duplicate command ids', async () => {
    await expect(
      runVerification({
        projectRoot,
        runId: 'run-1',
        iteration: 1,
        commands: [
          createCommand({ id: 'same-id' }),
          createCommand({ id: 'same-id' }),
        ],
      }),
    ).rejects.toThrow(VerificationRunnerError);
  });

  it('should reject command id with path separators', async () => {
    await expect(
      runVerification({
        projectRoot,
        runId: 'run-1',
        iteration: 1,
        commands: [createCommand({ id: '../escaped' })],
      }),
    ).rejects.toThrow(VerificationRunnerError);
  });

  it('should reject command id with absolute path', async () => {
    await expect(
      runVerification({
        projectRoot,
        runId: 'run-1',
        iteration: 1,
        commands: [createCommand({ id: '/etc/passwd' })],
      }),
    ).rejects.toThrow(VerificationRunnerError);
  });

  it('should reject empty command id', async () => {
    await expect(
      runVerification({
        projectRoot,
        runId: 'run-1',
        iteration: 1,
        commands: [createCommand({ id: '' })],
      }),
    ).rejects.toThrow(VerificationRunnerError);
  });

  it('should reject empty argv', async () => {
    await expect(
      runVerification({
        projectRoot,
        runId: 'run-1',
        iteration: 1,
        commands: [createCommand({ argv: [] })],
      }),
    ).rejects.toThrow(VerificationRunnerError);
  });

  it('should reject cwd outside project', async () => {
    await expect(
      runVerification({
        projectRoot,
        runId: 'run-1',
        iteration: 1,
        commands: [createCommand({ cwd: '../../outside' })],
      }),
    ).rejects.toThrow(VerificationRunnerError);
  });

  it('should write manifest to verification directory', async () => {
    await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [createCommand()],
    });

    const manifestPath = path.join(projectRoot, '.agent', 'verification', 'manifest.json');
    expect(await fs.pathExists(manifestPath)).toBe(true);

    const manifest = await fs.readJSON(manifestPath);
    expect(manifest.schema_version).toBe(1);
    expect(manifest.run_id).toBe('run-1');
    expect(manifest.iteration).toBe(1);
    expect(manifest.passed).toBe(true);
  });

  it('should write logs to iteration directory', async () => {
    await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [createCommand()],
    });

    const logDir = path.join(projectRoot, '.agent', 'verification', 'iteration-01');
    expect(await fs.pathExists(path.join(logDir, 'test-cmd.stdout.log'))).toBe(true);
    expect(await fs.pathExists(path.join(logDir, 'test-cmd.stderr.log'))).toBe(true);

    const stdout = await fs.readFile(path.join(logDir, 'test-cmd.stdout.log'), 'utf8');
    expect(stdout.trim()).toBe('hello');
  });

  it('should re-run all required commands in new iteration', async () => {
    const result1 = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [
        createCommand({ id: 'cmd-1', argv: ['echo', 'first'] }),
        createCommand({ id: 'cmd-2', argv: ['bash', '-c', 'exit 1'] }),
      ],
    });

    expect(result1.passed).toBe(false);

    const result2 = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 2,
      commands: [
        createCommand({ id: 'cmd-1', argv: ['echo', 'first'] }),
        createCommand({ id: 'cmd-2', argv: ['echo', 'second'] }),
      ],
    });

    expect(result2.passed).toBe(true);
    expect(result2.manifest.iteration).toBe(2);
  });

  // --- EISDIR / log I/O error integration (F-217R5) ---

  it('should fail required command when log path is a directory', async () => {
    // Pre-create the stdout log path as a directory to trigger EISDIR
    const logDir = path.join(projectRoot, '.agent', 'verification', 'iteration-01');
    await fs.ensureDir(logDir);
    const badPath = path.join(logDir, 'eisdir-cmd.stdout.log');
    await fs.ensureDir(badPath); // create as directory instead of file

    const result = await runVerification({
      projectRoot,
      runId: 'run-1',
      iteration: 1,
      commands: [createCommand({ id: 'eisdir-cmd', argv: ['echo', 'hello'] })],
    });

    // Command must be failed in manifest
    expect(result.passed).toBe(false);
    expect(result.manifest.commands[0].status).toBe('failed');
    expect(result.manifest.commands[0].log_io_error).toBeDefined();
    expect(result.manifest.commands[0].log_io_error).toContain('EISDIR');

    // Finding must exist and status must be failed (not success)
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].command_id).toBe('eisdir-cmd');
    expect(result.findings[0].status).toBe(ProcessStatus.FAILED);
    expect(result.findings[0].log_io_error).toContain('EISDIR');
  });
});
