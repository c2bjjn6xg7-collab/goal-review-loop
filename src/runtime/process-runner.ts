import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs-extra';
import path from 'path';
import { ProcessStatus, type ProcessRunnerInput, type ProcessRunnerResult } from '../types.js';

const SENSITIVE_KEY_PATTERN = /token|api_key|secret|password|authorization/i;
const REDACTED = '***REDACTED***';

export class ProcessRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessRunnerError';
  }
}

export class StreamRedactor {
  private sensitiveValues: string[];
  private pending: string = '';
  private decoder: StringDecoder;

  constructor(sensitiveValues: string[]) {
    this.sensitiveValues = sensitiveValues.filter(v => v.length > 0);
    this.decoder = new StringDecoder('utf8');
  }

  private redact(str: string): string {
    let result = str;
    for (const value of this.sensitiveValues) {
      result = result.split(value).join(REDACTED);
    }
    return result;
  }

  /**
   * Find the earliest position in `pending` where any secret could still
   * potentially match (either fully present or as a partial prefix extending
   * beyond the current buffer). Returns the start position of that earliest
   * candidate, or null if no secret appears at all.
   */
  private findEarliestCandidateStart(): number | null {
    let earliest: number | null = null;

    for (const secret of this.sensitiveValues) {
      // Check for complete match
      const idx = this.pending.indexOf(secret);
      if (idx !== -1) {
        if (earliest === null || idx < earliest) {
          earliest = idx;
        }
      }

      // Check for partial match — secret starts somewhere in pending
      // but extends beyond it. We need to find the earliest position
      // where a secret's prefix matches the pending text.
      for (let pos = 0; pos < this.pending.length; pos++) {
        if (earliest !== null && pos >= earliest) break; // can't be earlier
        const remaining = this.pending.length - pos;
        if (secret.length > remaining) {
          const prefix = this.pending.substring(pos);
          if (secret.startsWith(prefix)) {
            if (earliest === null || pos < earliest) {
              earliest = pos;
            }
            break; // no need to check later positions for this secret
          }
        }
      }
    }

    return earliest;
  }

  /**
   * Among all secrets that fully appear at the given position, find the longest.
   */
  private findLongestMatchAt(position: number): { start: number; end: number } | null {
    let best: { start: number; end: number } | null = null;

    for (const secret of this.sensitiveValues) {
      if (position + secret.length <= this.pending.length) {
        if (this.pending.substring(position, position + secret.length) === secret) {
          if (!best || secret.length > best.end - best.start) {
            best = { start: position, end: position + secret.length };
          }
        }
      }
    }

    return best;
  }

  /**
   * Check whether any secret has a partial match starting at or before
   * `position` that extends beyond the current pending buffer AND is longer
   * than `minLength`. This means a longer secret could still match if we
   * receive more input.
   */
  private hasPartialCandidateAtOrBefore(position: number, minLength: number): boolean {
    for (const secret of this.sensitiveValues) {
      if (secret.length <= minLength) continue; // not longer than the current match
      for (let pos = 0; pos <= position; pos++) {
        const remaining = this.pending.length - pos;
        if (secret.length > remaining) {
          const prefix = this.pending.substring(pos);
          if (secret.startsWith(prefix)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  process(chunk: Buffer): Buffer {
    if (this.sensitiveValues.length === 0) return chunk;

    this.pending += this.decoder.write(chunk);

    let output = '';

    while (this.pending.length > 0) {
      const earliestStart = this.findEarliestCandidateStart();

      if (earliestStart === null) {
        // No secret appears at all — output everything
        output += this.pending;
        this.pending = '';
        break;
      }

      // Check if there's a complete match at the earliest position
      const match = this.findLongestMatchAt(earliestStart);

      if (match) {
        // There's a complete match. But before committing it, check if
        // a longer secret could still match starting at the same position
        // or an earlier position. If so, we must wait for more input.
        if (this.hasPartialCandidateAtOrBefore(match.start, match.end - match.start)) {
          // A longer secret starting at or before the match might still match — wait
          break;
        }

        // Safe to commit: output text before match + redacted marker
        output += this.pending.substring(0, match.start) + REDACTED;
        this.pending = this.pending.substring(match.end);
      } else {
        // The earliest candidate is a partial match (extends beyond pending).
        // Output any text before it, then wait for more input.
        if (earliestStart > 0) {
          output += this.pending.substring(0, earliestStart);
          this.pending = this.pending.substring(earliestStart);
        }
        break;
      }
    }

    if (output.length === 0) {
      return Buffer.alloc(0);
    }
    return Buffer.from(output, 'utf8');
  }

  flush(): Buffer {
    this.pending += this.decoder.end();

    if (this.pending.length === 0) return Buffer.alloc(0);

    const result = this.redact(this.pending);
    this.pending = '';
    return Buffer.from(result, 'utf8');
  }
}

const TASKKILL_TIMEOUT_MS = 10_000; // 10s timeout for taskkill to prevent hanging

export interface KillResult {
  success: boolean;
  method: 'taskkill' | 'process-group' | 'child-kill' | 'fallback' | 'no-pid';
  timedOut?: boolean;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<KillResult> {
  if (!child.pid) return Promise.resolve({ success: false, method: 'no-pid' });

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: KillResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(taskkillTimer);
        resolve(result);
      };

      const killer = spawn('taskkill', ['/pid', String(child.pid!), '/T', '/F'], { stdio: 'ignore' });

      // Timeout for taskkill itself to prevent hanging
      const taskkillTimer = setTimeout(() => {
        try { killer.kill('SIGKILL'); } catch { /* already dead */ }
        try { child.kill(signal); } catch { /* already dead */ }
        settle({ success: false, method: 'taskkill', timedOut: true });
      }, TASKKILL_TIMEOUT_MS);

      killer.on('error', () => {
        try { child.kill(signal); } catch { /* already dead */ }
        settle({ success: false, method: 'fallback' });
      });
      killer.on('exit', (code) => {
        if (code === 0) {
          settle({ success: true, method: 'taskkill' });
        } else {
          try { child.kill(signal); } catch { /* already dead */ }
          settle({ success: false, method: 'fallback' });
        }
      });
    });
  } else {
    try {
      process.kill(-child.pid, signal);
      return Promise.resolve({ success: true, method: 'process-group' });
    } catch {
      try {
        child.kill(signal);
        return Promise.resolve({ success: true, method: 'child-kill' });
      } catch { /* process already dead */ }
    }
    return Promise.resolve({ success: false, method: 'fallback' });
  }
}

/**
 * Wait for a WriteStream to close, handling errors.
 * Returns a string error message if the stream encountered an error,
 * or undefined if it closed successfully.
 */
function waitForStream(stream: fs.WriteStream): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.closed) {
      resolve(undefined);
      return;
    }
    let settled = false;
    const settle = (err?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(err);
    };
    const onClose = () => {
      settle(streamErrored ? streamErrorMessage : undefined);
    };
    const onError = (err: Error) => {
      streamErrored = true;
      streamErrorMessage = err.message;
      // Don't resolve yet — wait for close to ensure file handle is released
    };
    let streamErrored = false;
    let streamErrorMessage: string | undefined;
    const cleanup = () => {
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    stream.on('close', onClose);
    stream.on('error', onError);
  });
}

export async function runProcess(input: ProcessRunnerInput, projectRoot?: string): Promise<ProcessRunnerResult> {
  if (!input.argv || input.argv.length === 0) {
    throw new ProcessRunnerError('argv must be a non-empty array');
  }

  const resolvedCwd = path.resolve(input.cwd);

  if (projectRoot) {
    const resolvedRoot = path.resolve(projectRoot);
    if (!resolvedCwd.startsWith(resolvedRoot + path.sep) && resolvedCwd !== resolvedRoot) {
      throw new ProcessRunnerError(`cwd "${input.cwd}" is outside project root`);
    }
  }

  // Pre-cancel check BEFORE creating any streams or directories
  if (input.signal?.aborted) {
    return {
      status: ProcessStatus.CANCELLED,
      exit_code: null,
      signal: null,
      timed_out: false,
      cancelled: true,
      duration_ms: 0,
      stdout_path: input.stdout_path,
      stderr_path: input.stderr_path,
      stdout_truncated: false,
      stderr_truncated: false,
    };
  }

  await fs.ensureDir(path.dirname(input.stdout_path));
  await fs.ensureDir(path.dirname(input.stderr_path));

  const stdoutStream = fs.createWriteStream(input.stdout_path);
  const stderrStream = fs.createWriteStream(input.stderr_path);

  // Install error handlers immediately to prevent unhandled errors
  let logIoError: string | undefined;
  stdoutStream.on('error', (err: Error) => {
    if (!logIoError) logIoError = err.message;
  });
  stderrStream.on('error', (err: Error) => {
    if (!logIoError) logIoError = err.message;
  });

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const maxLogBytes = input.max_log_bytes ?? 10 * 1024 * 1024;

  const env: Record<string, string> = {};
  const sensitiveValues: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (input.env) {
    for (const [key, value] of Object.entries(input.env)) {
      env[key] = value;
    }
  }
  // Phase 8F: delete specified keys from the child environment
  if (input.delete_env) {
    for (const key of input.delete_env) {
      delete env[key];
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && value) {
      sensitiveValues.push(value);
    }
  }

  const stdoutRedactor = new StreamRedactor(sensitiveValues);
  const stderrRedactor = new StreamRedactor(sensitiveValues);

  let cleanupDone = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;

    const stdoutFlush = stdoutRedactor.flush();
    if (stdoutFlush.length > 0) {
      stdoutStream.write(stdoutFlush);
    }
    const stderrFlush = stderrRedactor.flush();
    if (stderrFlush.length > 0) {
      stderrStream.write(stderrFlush);
    }

    stdoutStream.end();
    stderrStream.end();

    const [stdoutErr, stderrErr] = await Promise.all([
      waitForStream(stdoutStream),
      waitForStream(stderrStream),
    ]);
    if (stdoutErr && !logIoError) logIoError = stdoutErr;
    if (stderrErr && !logIoError) logIoError = stderrErr;
  };

  const startTime = Date.now();
  let cancelled = false;
  let timedOut = false;
  let resolved = false;
  let lastKillResult: KillResult | undefined;
  let inFlightKill: Promise<KillResult> | undefined;
  let childClosed = false;

  const child: ChildProcess = spawn(input.argv[0], input.argv.slice(1), {
    cwd: resolvedCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: true,
  });

  const killTree = async (signal: NodeJS.Signals): Promise<boolean> => {
    const promise = killProcessTree(child, signal);
    inFlightKill = promise;
    const result = await promise;
    lastKillResult = result;
    return result.success;
  };

  const onData = (stream: fs.WriteStream, redactor: StreamRedactor, isStdout: boolean) => (chunk: Buffer) => {
    const bytes = isStdout ? stdoutBytes : stderrBytes;
    const truncated = isStdout ? stdoutTruncated : stderrTruncated;

    if (truncated) return;

    const sanitized = redactor.process(chunk);

    const remaining = maxLogBytes - bytes;
    if (remaining <= 0) {
      const marker = '\n[LOG TRUNCATED]\n';
      stream.write(marker);
      if (isStdout) stdoutTruncated = true;
      else stderrTruncated = true;
      return;
    }

    const toWrite = sanitized.length > remaining ? sanitized.subarray(0, remaining) : sanitized;
    stream.write(toWrite);

    if (isStdout) stdoutBytes += toWrite.length;
    else stderrBytes += toWrite.length;

    if (sanitized.length > remaining) {
      const marker = '\n[LOG TRUNCATED]\n';
      stream.write(marker);
      if (isStdout) stdoutTruncated = true;
      else stderrTruncated = true;
    }
  };

  child.stdout?.on('data', onData(stdoutStream, stdoutRedactor, true));
  child.stderr?.on('data', onData(stderrStream, stderrRedactor, false));

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let killGraceTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<ProcessRunnerResult>((resolve) => {
    const resolveOnce = (result: ProcessRunnerResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const onAbort = async () => {
      cancelled = true;
      await killTree('SIGTERM');

      if (childClosed) return;

      const graceMs = (input.kill_grace_seconds ?? 5) * 1000;
      killGraceTimeoutId = setTimeout(async () => {
        if (!childClosed) await killTree('SIGKILL');
      }, graceMs);
    };

    child.on('error', async () => {
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }
      await cleanup();
      resolveOnce({
        status: ProcessStatus.FAILED,
        exit_code: null,
        signal: null,
        timed_out: false,
        cancelled: false,
        duration_ms: Date.now() - startTime,
        stdout_path: input.stdout_path,
        stderr_path: input.stderr_path,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        kill_result: lastKillResult ? { success: lastKillResult.success, method: lastKillResult.method, timedOut: lastKillResult.timedOut } : undefined,
        log_io_error: logIoError,
      });
    });

    child.on('close', async (exitCode, signal) => {
      childClosed = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killGraceTimeoutId) clearTimeout(killGraceTimeoutId);
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }

      // Wait for any in-flight kill operation to settle before reading its result
      if (inFlightKill) {
        try { await inFlightKill; } catch { /* kill already settled */ }
      }

      await cleanup();

      let status: ProcessStatus;
      if (cancelled) {
        status = ProcessStatus.CANCELLED;
      } else if (timedOut) {
        status = ProcessStatus.TIMEOUT;
      } else if (exitCode !== 0) {
        status = ProcessStatus.FAILED;
      } else {
        status = ProcessStatus.SUCCESS;
      }

      resolveOnce({
        status,
        exit_code: exitCode,
        signal: signal ?? null,
        timed_out: timedOut,
        cancelled,
        duration_ms: Date.now() - startTime,
        stdout_path: input.stdout_path,
        stderr_path: input.stderr_path,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        kill_result: lastKillResult ? { success: lastKillResult.success, method: lastKillResult.method, timedOut: lastKillResult.timedOut } : undefined,
        log_io_error: logIoError,
      });
    });

    timeoutId = setTimeout(async () => {
      if (childClosed) return; // child already exited, no need to kill
      timedOut = true;
      await killTree('SIGTERM');

      if (childClosed) return;

      const graceMs = (input.kill_grace_seconds ?? 5) * 1000;
      killGraceTimeoutId = setTimeout(async () => {
        if (!childClosed) await killTree('SIGKILL');
      }, graceMs);
    }, input.timeout_ms);

    if (input.signal) {
      input.signal.addEventListener('abort', onAbort);
    }
  });

  return promise;
}

export async function runProcessRaw(input: ProcessRunnerInput, projectRoot?: string): Promise<ProcessRunnerResult> {
  if (!input.argv || input.argv.length === 0) {
    throw new ProcessRunnerError('argv must be a non-empty array');
  }

  const resolvedCwd = path.resolve(input.cwd);

  if (projectRoot) {
    const resolvedRoot = path.resolve(projectRoot);
    if (!resolvedCwd.startsWith(resolvedRoot + path.sep) && resolvedCwd !== resolvedRoot) {
      throw new ProcessRunnerError(`cwd "${input.cwd}" is outside project root`);
    }
  }

  // Pre-cancel check BEFORE creating any streams or directories
  if (input.signal?.aborted) {
    return {
      status: ProcessStatus.CANCELLED,
      exit_code: null,
      signal: null,
      timed_out: false,
      cancelled: true,
      duration_ms: 0,
      stdout_path: input.stdout_path,
      stderr_path: input.stderr_path,
      stdout_truncated: false,
      stderr_truncated: false,
    };
  }

  await fs.ensureDir(path.dirname(input.stdout_path));
  await fs.ensureDir(path.dirname(input.stderr_path));

  const stdoutStream = fs.createWriteStream(input.stdout_path);
  const stderrStream = fs.createWriteStream(input.stderr_path);

  // Install error handlers immediately to prevent unhandled errors
  let logIoError: string | undefined;
  stdoutStream.on('error', (err: Error) => {
    if (!logIoError) logIoError = err.message;
  });
  stderrStream.on('error', (err: Error) => {
    if (!logIoError) logIoError = err.message;
  });

  let stderrBytes = 0;
  let stderrTruncated = false;
  const maxLogBytes = input.max_log_bytes ?? 10 * 1024 * 1024;

  const env: Record<string, string> = {};
  const sensitiveValues: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (input.env) {
    for (const [key, value] of Object.entries(input.env)) {
      env[key] = value;
    }
  }
  // Phase 8F: delete specified keys from the child environment
  if (input.delete_env) {
    for (const key of input.delete_env) {
      delete env[key];
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && value) {
      sensitiveValues.push(value);
    }
  }

  const stderrRedactor = new StreamRedactor(sensitiveValues);

  let cleanupDone = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;

    const stderrFlush = stderrRedactor.flush();
    if (stderrFlush.length > 0) {
      stderrStream.write(stderrFlush);
    }
    stdoutStream.end();
    stderrStream.end();

    const [stdoutErr, stderrErr] = await Promise.all([
      waitForStream(stdoutStream),
      waitForStream(stderrStream),
    ]);
    if (stdoutErr && !logIoError) logIoError = stdoutErr;
    if (stderrErr && !logIoError) logIoError = stderrErr;
  };

  const startTime = Date.now();
  let cancelled = false;
  let timedOut = false;
  let resolved = false;
  let lastKillResult: KillResult | undefined;
  let inFlightKill: Promise<KillResult> | undefined;
  let childClosed = false;

  const child: ChildProcess = spawn(input.argv[0], input.argv.slice(1), {
    cwd: resolvedCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: true,
  });

  const killTree = async (signal: NodeJS.Signals): Promise<boolean> => {
    const promise = killProcessTree(child, signal);
    inFlightKill = promise;
    const result = await promise;
    lastKillResult = result;
    return result.success;
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutStream.write(chunk);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const sanitized = stderrRedactor.process(chunk);

    const remaining = maxLogBytes - stderrBytes;
    if (remaining <= 0) {
      if (!stderrTruncated) {
        stderrStream.write('\n[LOG TRUNCATED]\n');
        stderrTruncated = true;
      }
      return;
    }

    const toWrite = sanitized.length > remaining ? sanitized.subarray(0, remaining) : sanitized;
    stderrStream.write(toWrite);
    stderrBytes += toWrite.length;

    if (sanitized.length > remaining && !stderrTruncated) {
      stderrStream.write('\n[LOG TRUNCATED]\n');
      stderrTruncated = true;
    }
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let killGraceTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<ProcessRunnerResult>((resolve) => {
    const resolveOnce = (result: ProcessRunnerResult) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const onAbort = async () => {
      cancelled = true;
      await killTree('SIGTERM');

      if (childClosed) return;

      const graceMs = (input.kill_grace_seconds ?? 5) * 1000;
      killGraceTimeoutId = setTimeout(async () => {
        if (!childClosed) await killTree('SIGKILL');
      }, graceMs);
    };

    child.on('error', async () => {
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }
      await cleanup();
      resolveOnce({
        status: ProcessStatus.FAILED,
        exit_code: null,
        signal: null,
        timed_out: false,
        cancelled: false,
        duration_ms: Date.now() - startTime,
        stdout_path: input.stdout_path,
        stderr_path: input.stderr_path,
        stdout_truncated: false,
        stderr_truncated: stderrTruncated,
        kill_result: lastKillResult ? { success: lastKillResult.success, method: lastKillResult.method, timedOut: lastKillResult.timedOut } : undefined,
        log_io_error: logIoError,
      });
    });

    child.on('close', async (exitCode, signal) => {
      childClosed = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killGraceTimeoutId) clearTimeout(killGraceTimeoutId);
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }

      // Wait for any in-flight kill operation to settle before reading its result
      if (inFlightKill) {
        try { await inFlightKill; } catch { /* kill already settled */ }
      }

      await cleanup();

      let status: ProcessStatus;
      if (cancelled) {
        status = ProcessStatus.CANCELLED;
      } else if (timedOut) {
        status = ProcessStatus.TIMEOUT;
      } else if (exitCode !== 0) {
        status = ProcessStatus.FAILED;
      } else {
        status = ProcessStatus.SUCCESS;
      }

      resolveOnce({
        status,
        exit_code: exitCode,
        signal: signal ?? null,
        timed_out: timedOut,
        cancelled,
        duration_ms: Date.now() - startTime,
        stdout_path: input.stdout_path,
        stderr_path: input.stderr_path,
        stdout_truncated: false,
        stderr_truncated: stderrTruncated,
        kill_result: lastKillResult ? { success: lastKillResult.success, method: lastKillResult.method, timedOut: lastKillResult.timedOut } : undefined,
        log_io_error: logIoError,
      });
    });

    timeoutId = setTimeout(async () => {
      if (childClosed) return; // child already exited, no need to kill
      timedOut = true;
      await killTree('SIGTERM');

      if (childClosed) return;

      const graceMs = (input.kill_grace_seconds ?? 5) * 1000;
      killGraceTimeoutId = setTimeout(async () => {
        if (!childClosed) await killTree('SIGKILL');
      }, graceMs);
    }, input.timeout_ms);

    if (input.signal) {
      input.signal.addEventListener('abort', onAbort);
    }
  });

  return promise;
}
