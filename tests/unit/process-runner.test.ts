import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { runProcess, runProcessRaw, ProcessRunnerError, KillResult } from '../../src/runtime/process-runner.js';
import { ProcessStatus } from '../../src/types.js';

describe('ProcessRunner', () => {
  let tmpDir: string;
  let stdoutPath: string;
  let stderrPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'process-runner-test-'));
    stdoutPath = path.join(tmpDir, 'stdout.log');
    stderrPath = path.join(tmpDir, 'stderr.log');
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should execute a simple command successfully', async () => {
    const result = await runProcess({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stdout_truncated).toBe(false);
    expect(result.stderr_truncated).toBe(false);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.log_io_error).toBeUndefined();

    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout.trim()).toBe('hello');
  });

  it('should return failed for non-zero exit code', async () => {
    const result = await runProcess({
      argv: ['bash', '-c', 'exit 42'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    });

    expect(result.status).toBe(ProcessStatus.FAILED);
    expect(result.exit_code).toBe(42);
  });

  it('should handle command not found', async () => {
    const result = await runProcess({
      argv: ['nonexistent-command-12345'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    });

    expect(result.status).toBe(ProcessStatus.FAILED);
    // exit_code may be null (error event) or a negative number (close event with signal)
    if (result.exit_code !== null) {
      expect(result.exit_code).toBeLessThan(0);
    }
  });

  it('should reject empty argv', async () => {
    await expect(
      runProcess({
        argv: [],
        cwd: tmpDir,
        timeout_ms: 5000,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
      }),
    ).rejects.toThrow(ProcessRunnerError);
  });

  it('should capture stdout and stderr separately', async () => {
    const result = await runProcess({
      argv: ['bash', '-c', 'echo stdout; echo stderr >&2'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    const stdout = await fs.readFile(stdoutPath, 'utf8');
    const stderr = await fs.readFile(stderrPath, 'utf8');
    expect(stdout.trim()).toBe('stdout');
    expect(stderr.trim()).toBe('stderr');
  });

  it('should timeout a long-running command', async () => {
    const result = await runProcess({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 100,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      kill_grace_seconds: 1,
    });

    expect(result.status).toBe(ProcessStatus.TIMEOUT);
    expect(result.timed_out).toBe(true);
  }, 10000);

  it('should handle cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runProcess({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 30000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      signal: controller.signal,
    });

    expect(result.status).toBe(ProcessStatus.CANCELLED);
    expect(result.cancelled).toBe(true);
  }, 10000);

  it('should handle pre-cancelled signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runProcess({
      argv: ['bash', '-c', 'echo hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      signal: controller.signal,
    });

    expect(result.status).toBe(ProcessStatus.CANCELLED);
    expect(result.cancelled).toBe(true);
    expect(result.duration_ms).toBe(0);
  });

  it('should truncate logs when exceeding max_log_bytes', async () => {
    const result = await runProcess({
      argv: ['bash', '-c', 'for i in $(seq 1 1000); do echo "line $i"; done'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      max_log_bytes: 100,
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    expect(result.stdout_truncated).toBe(true);

    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout).toContain('[LOG TRUNCATED]');
  });

  it('should pass real env to child but sanitize logs', async () => {
    const result = await runProcess({
      argv: ['bash', '-c', 'echo $MY_TOKEN; echo $SAFE_VAR'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      env: {
        MY_TOKEN: 'secret123',
        SAFE_VAR: 'visible',
      },
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout).toContain('***REDACTED***');
    expect(stdout).toContain('visible');
    expect(stdout).not.toContain('secret123');
  });

  it('should sanitize repeated secrets', async () => {
    const secret = 'bb';
    const result = await runProcess({
      argv: ['echo', '-n', 'bbbb'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      env: {
        MY_TOKEN: secret,
      },
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout).not.toContain(secret);
    expect(stdout).toContain('***REDACTED***');
  });

  it('should prevent cwd escape', async () => {
    const outsideDir = path.join(tmpDir, '..', 'outside');

    await expect(
      runProcess({
        argv: ['echo', 'hello'],
        cwd: outsideDir,
        timeout_ms: 5000,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
      }, tmpDir),
    ).rejects.toThrow(ProcessRunnerError);
  });

  // --- Log lifecycle tests (F-217R2/R3) ---

  it('should allow immediate file read after return', async () => {
    const result = await runProcess({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    expect(result.log_io_error).toBeUndefined();

    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout.trim()).toBe('hello');
    const stderr = await fs.readFile(stderrPath, 'utf8');
    expect(stderr.trim()).toBe('');
  });

  it('should allow immediate directory deletion after return', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-lifecycle-'));
    const logStdout = path.join(logDir, 'stdout.log');
    const logStderr = path.join(logDir, 'stderr.log');

    const result = await runProcess({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: logStdout,
      stderr_path: logStderr,
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    expect(result.log_io_error).toBeUndefined();

    await fs.remove(logDir);
    expect(await fs.pathExists(logDir)).toBe(false);
  });

  it('should handle pre-cancel without creating log files', async () => {
    const controller = new AbortController();
    controller.abort();

    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'precancel-'));
    const logStdout = path.join(logDir, 'stdout.log');
    const logStderr = path.join(logDir, 'stderr.log');

    const result = await runProcess({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: logStdout,
      stderr_path: logStderr,
      signal: controller.signal,
    });

    expect(result.status).toBe(ProcessStatus.CANCELLED);
    expect(result.cancelled).toBe(true);

    // Pre-cancel should not create log files
    expect(await fs.pathExists(logStdout)).toBe(false);
    expect(await fs.pathExists(logStderr)).toBe(false);

    await fs.remove(logDir);
  });

  // --- Log I/O error handling (F-217R3) ---

  it('should report log_io_error when stdout path is a directory', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-err-'));
    // Point stdout_path at a directory instead of a file
    const badPath = logDir; // this is a directory, not a file

    const result = await runProcess({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: badPath,
      stderr_path: stderrPath,
    });

    // The process should complete but report a log I/O error
    expect(result.log_io_error).toBeDefined();
    expect(result.log_io_error).toContain('EISDIR');

    await fs.remove(logDir);
  });

  it('should report log_io_error when stderr path is a directory', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-err2-'));
    const badPath = logDir;

    const result = await runProcess({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: badPath,
    });

    expect(result.log_io_error).toBeDefined();
    expect(result.log_io_error).toContain('EISDIR');

    await fs.remove(logDir);
  });

  it('should not throw unhandled exception on log I/O error', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-err3-'));

    // This should not throw — the error should be captured in log_io_error
    const result = await runProcess({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: logDir, // directory, not file
      stderr_path: stderrPath,
    });

    expect(result).toBeDefined();
    expect(result.log_io_error).toBeDefined();

    await fs.remove(logDir);
  });

  // --- Kill result propagation (F-206R12) ---

  it('should include kill_result on timeout', async () => {
    const result = await runProcess({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 100,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      kill_grace_seconds: 1,
    });

    expect(result.status).toBe(ProcessStatus.TIMEOUT);
    // kill_result must be present when a kill was attempted
    expect(result.kill_result).toBeDefined();
    expect(typeof result.kill_result!.success).toBe('boolean');
    expect(typeof result.kill_result!.method).toBe('string');
  }, 10000);

  it('should include kill_result on cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runProcess({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 30000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      signal: controller.signal,
    });

    expect(result.status).toBe(ProcessStatus.CANCELLED);
    // kill_result must be present when a kill was attempted
    expect(result.kill_result).toBeDefined();
    expect(typeof result.kill_result!.success).toBe('boolean');
    expect(typeof result.kill_result!.method).toBe('string');
  }, 10000);

  // --- Prefix-related secret integration test (F-210R11/R12) ---

  it('should sanitize prefix-related secrets correctly', async () => {
    const result = await runProcess({
      argv: ['echo', '-n', 'abcdef'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      env: {
        MY_TOKEN: 'a',
        MY_SECRET: 'abcdef',
      },
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout).not.toContain('abcdef');
    expect(stdout).not.toContain('bcdef');
    expect(stdout).toContain('***REDACTED***');
  });

  // --- Windows lifecycle: cancel child-close-first (F-206R13) ---

  it('should not re-kill after cancel when child closes before grace timer', async () => {
    const controller = new AbortController();
    // Abort quickly — child will close on its own after SIGTERM
    setTimeout(() => controller.abort(), 50);

    const result = await runProcess({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 30000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      kill_grace_seconds: 1,
      signal: controller.signal,
    });

    expect(result.status).toBe(ProcessStatus.CANCELLED);
    expect(result.cancelled).toBe(true);
    // kill_result must exist — exactly one kill was attempted
    expect(result.kill_result).toBeDefined();
    expect(typeof result.kill_result!.success).toBe('boolean');
  }, 10000);

  it('should not re-kill after timeout when child closes before grace timer', async () => {
    const result = await runProcess({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 100,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      kill_grace_seconds: 1,
    });

    expect(result.status).toBe(ProcessStatus.TIMEOUT);
    expect(result.timed_out).toBe(true);
    // kill_result must exist — exactly one kill was attempted
    expect(result.kill_result).toBeDefined();
    expect(typeof result.kill_result!.success).toBe('boolean');
  }, 10000);

  // --- Repeated execution stability ---

  it('should handle repeated execution without unhandled errors', async () => {
    for (let i = 0; i < 5; i++) {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), `repeat-${i}-`));
      const logStdout = path.join(logDir, 'stdout.log');
      const logStderr = path.join(logDir, 'stderr.log');

      const result = await runProcess({
        argv: ['echo', 'hello'],
        cwd: tmpDir,
        timeout_ms: 5000,
        stdout_path: logStdout,
        stderr_path: logStderr,
      });

      expect(result.status).toBe(ProcessStatus.SUCCESS);
      expect(result.log_io_error).toBeUndefined();

      await fs.readFile(logStdout, 'utf8');
      await fs.remove(logDir);
    }
  });
});

describe('runProcessRaw', () => {
  let tmpDir: string;
  let stdoutPath: string;
  let stderrPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'process-raw-test-'));
    stdoutPath = path.join(tmpDir, 'stdout.log');
    stderrPath = path.join(tmpDir, 'stderr.log');
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should not sanitize stdout', async () => {
    const result = await runProcessRaw({
      argv: ['bash', '-c', 'echo $MY_TOKEN'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      env: {
        MY_TOKEN: 'secret123',
      },
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout.trim()).toBe('secret123');
  });

  it('should still sanitize stderr', async () => {
    const result = await runProcessRaw({
      argv: ['bash', '-c', 'echo $MY_TOKEN >&2'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      env: {
        MY_TOKEN: 'secret123',
      },
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    const stderr = await fs.readFile(stderrPath, 'utf8');
    expect(stderr).toContain('***REDACTED***');
    expect(stderr).not.toContain('secret123');
  });

  it('should allow immediate file read after return', async () => {
    const result = await runProcessRaw({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    });

    expect(result.status).toBe(ProcessStatus.SUCCESS);
    expect(result.log_io_error).toBeUndefined();
    const stdout = await fs.readFile(stdoutPath, 'utf8');
    expect(stdout.trim()).toBe('hello');
  });

  it('should handle pre-cancel without creating log files', async () => {
    const controller = new AbortController();
    controller.abort();

    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-precancel-'));
    const logStdout = path.join(logDir, 'stdout.log');
    const logStderr = path.join(logDir, 'stderr.log');

    const result = await runProcessRaw({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: logStdout,
      stderr_path: logStderr,
      signal: controller.signal,
    });

    expect(result.status).toBe(ProcessStatus.CANCELLED);
    expect(await fs.pathExists(logStdout)).toBe(false);
    expect(await fs.pathExists(logStderr)).toBe(false);

    await fs.remove(logDir);
  });

  it('should report log_io_error when stdout path is a directory', async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-log-err-'));

    const result = await runProcessRaw({
      argv: ['echo', 'hello'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: logDir,
      stderr_path: stderrPath,
    });

    expect(result.log_io_error).toBeDefined();
    expect(result.log_io_error).toContain('EISDIR');

    await fs.remove(logDir);
  });

  // --- Windows lifecycle: cancel child-close-first (F-206R13) ---

  it('should not re-kill after cancel when child closes before grace timer', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await runProcessRaw({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 30000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      kill_grace_seconds: 1,
      signal: controller.signal,
    });

    expect(result.status).toBe(ProcessStatus.CANCELLED);
    expect(result.cancelled).toBe(true);
    expect(result.kill_result).toBeDefined();
    expect(typeof result.kill_result!.success).toBe('boolean');
  }, 10000);

  it('should not re-kill after timeout when child closes before grace timer', async () => {
    const result = await runProcessRaw({
      argv: ['bash', '-c', 'sleep 30'],
      cwd: tmpDir,
      timeout_ms: 100,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      kill_grace_seconds: 1,
    });

    expect(result.status).toBe(ProcessStatus.TIMEOUT);
    expect(result.timed_out).toBe(true);
    expect(result.kill_result).toBeDefined();
    expect(typeof result.kill_result!.success).toBe('boolean');
  }, 10000);
});

// --- KillResult unit tests (F-206R12) ---

describe('KillResult', () => {
  it('should have correct type structure', () => {
    const result: KillResult = { success: true, method: 'process-group' };
    expect(result.success).toBe(true);
    expect(result.method).toBe('process-group');
    expect(result.timedOut).toBeUndefined();
  });

  it('should support timedOut field', () => {
    const result: KillResult = { success: false, method: 'taskkill', timedOut: true };
    expect(result.success).toBe(false);
    expect(result.method).toBe('taskkill');
    expect(result.timedOut).toBe(true);
  });

  it('should support all method values', () => {
    const methods: KillResult['method'][] = ['taskkill', 'process-group', 'child-kill', 'fallback', 'no-pid'];
    for (const method of methods) {
      const result: KillResult = { success: false, method };
      expect(result.method).toBe(method);
    }
  });
});
