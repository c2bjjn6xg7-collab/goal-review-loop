import fs from 'fs-extra';
import path from 'path';
import { runProcess } from '../runtime/process-runner.js';
import { atomicWriteJSON } from '../runtime/atomic-file.js';
import { validateVerificationManifest } from '../artifacts/json-schemas.js';
import { ProcessStatus } from '../types.js';
import { isWindowsUnsafeFileName, windowsFileNameKey } from '../runtime/windows-file-name.js';
import type {
  VerificationCommand,
  VerificationManifest,
  VerificationResult,
  MechanicalFinding,
} from '../types.js';

export class VerificationRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationRunnerError';
  }
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Persist artifact paths with the platform-neutral forward-slash contract. */
export function toPortableVerificationPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isPathSafe(filePath: string, projectRoot: string): boolean {
  const resolved = path.resolve(projectRoot, filePath);
  return resolved.startsWith(projectRoot + path.sep) || resolved === projectRoot;
}

function validateCommandId(id: string, platform: NodeJS.Platform): void {
  if (!id || id.trim().length === 0) {
    throw new VerificationRunnerError('Command id must be non-empty');
  }
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new VerificationRunnerError(
      `Command id "${id}" contains invalid characters. Must match ${SAFE_ID_PATTERN}`,
    );
  }
  if (platform === 'win32' && isWindowsUnsafeFileName(id)) {
    throw new VerificationRunnerError(`Command id "${id}" is not a safe Windows file name`);
  }
}

function validateLogPath(logPath: string, projectRoot: string, cmdId: string): void {
  const resolved = path.resolve(logPath);
  const realProjectRoot = projectRoot;
  if (!resolved.startsWith(realProjectRoot + path.sep)) {
    throw new VerificationRunnerError(
      `Command ${cmdId}: log path escapes project root`,
    );
  }
}

function validateCommand(
  cmd: VerificationCommand,
  projectRoot: string,
  platform: NodeJS.Platform,
): void {
  validateCommandId(cmd.id, platform);

  if (!cmd.argv || cmd.argv.length === 0) {
    throw new VerificationRunnerError(`Command ${cmd.id}: argv must be non-empty`);
  }

  if (!cmd.cwd) {
    throw new VerificationRunnerError(`Command ${cmd.id}: cwd must be specified`);
  }

  if (!isPathSafe(cmd.cwd, projectRoot)) {
    throw new VerificationRunnerError(`Command ${cmd.id}: cwd is outside project root`);
  }

  if (!cmd.timeout_seconds || cmd.timeout_seconds <= 0) {
    throw new VerificationRunnerError(`Command ${cmd.id}: timeout_seconds must be positive`);
  }
}

export interface RunVerificationOptions {
  projectRoot: string;
  runId: string;
  iteration: number;
  commands: VerificationCommand[];
  signal?: AbortSignal;
  /** Testable platform override; production defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export interface RunVerificationResult {
  manifest: VerificationManifest;
  findings: MechanicalFinding[];
  passed: boolean;
}

export async function runVerification(options: RunVerificationOptions): Promise<RunVerificationResult> {
  const { projectRoot, runId, iteration, commands, signal } = options;
  const platform = options.platform ?? process.platform;

  const seenIds = new Set<string>();
  for (const cmd of commands) {
    const comparisonId = platform === 'win32' ? windowsFileNameKey(cmd.id) : cmd.id;
    if (seenIds.has(comparisonId)) {
      throw new VerificationRunnerError(`Duplicate command id: ${cmd.id}`);
    }
    seenIds.add(comparisonId);
    validateCommand(cmd, projectRoot, platform);
  }

  const logDir = path.join(
    projectRoot,
    '.agent',
    'verification',
    `iteration-${String(iteration).padStart(2, '0')}`,
  );
  await fs.ensureDir(logDir);

  const startedAt = new Date().toISOString();
  const results: VerificationResult[] = [];
  const findings: MechanicalFinding[] = [];
  let cancelled = false;

  for (const cmd of commands) {
    if (signal?.aborted) {
      cancelled = true;
    }

    if (cancelled) {
      const relStdout = toPortableVerificationPath(
        path.relative(projectRoot, path.join(logDir, `${cmd.id}.stdout.log`)),
      );
      const relStderr = toPortableVerificationPath(
        path.relative(projectRoot, path.join(logDir, `${cmd.id}.stderr.log`)),
      );
      results.push({
        id: cmd.id,
        argv: cmd.argv,
        cwd: cmd.cwd,
        required: cmd.required,
        status: 'failed',
        exit_code: null,
        timed_out: false,
        duration_ms: 0,
        stdout_path: relStdout,
        stderr_path: relStderr,
      });
      continue;
    }

    const stdoutPath = path.join(logDir, `${cmd.id}.stdout.log`);
    const stderrPath = path.join(logDir, `${cmd.id}.stderr.log`);
    validateLogPath(stdoutPath, projectRoot, cmd.id);
    validateLogPath(stderrPath, projectRoot, cmd.id);
    const resolvedCwd = path.resolve(projectRoot, cmd.cwd);

    const processResult = await runProcess({
      argv: cmd.argv,
      cwd: resolvedCwd,
      timeout_ms: cmd.timeout_seconds * 1000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      signal,
    }, projectRoot);

    let status: 'success' | 'failed' | 'timeout';
    if (processResult.status === ProcessStatus.TIMEOUT) {
      status = 'timeout';
    } else if (processResult.status === ProcessStatus.CANCELLED) {
      cancelled = true;
      status = 'failed';
    } else if (processResult.status === ProcessStatus.SUCCESS) {
      status = 'success';
    } else {
      status = 'failed';
    }

    if (processResult.log_io_error) {
      status = 'failed';
    }

    const result: VerificationResult = {
      id: cmd.id,
      argv: cmd.argv,
      cwd: cmd.cwd,
      required: cmd.required,
      status,
      exit_code: processResult.exit_code,
      timed_out: processResult.timed_out,
      duration_ms: processResult.duration_ms,
      stdout_path: toPortableVerificationPath(path.relative(projectRoot, stdoutPath)),
      stderr_path: toPortableVerificationPath(path.relative(projectRoot, stderrPath)),
      log_io_error: processResult.log_io_error,
    };

    results.push(result);

    if (cmd.required && status !== 'success') {
      findings.push({
        id: `V-${String(findings.length + 1).padStart(3, '0')}`,
        command_id: cmd.id,
        status: processResult.log_io_error ? ProcessStatus.FAILED : processResult.status,
        exit_code: processResult.exit_code,
        stdout_path: result.stdout_path,
        stderr_path: result.stderr_path,
        log_io_error: processResult.log_io_error,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const passed = results
    .filter((r) => {
      const cmd = commands.find((c) => c.id === r.id);
      return cmd?.required;
    })
    .every((r) => r.status === 'success');

  const manifest: VerificationManifest = {
    schema_version: 1,
    run_id: runId,
    iteration,
    passed,
    started_at: startedAt,
    finished_at: finishedAt,
    commands: results,
  };

  const manifestPath = path.join(projectRoot, '.agent', 'verification', 'manifest.json');
  if (!validateVerificationManifest(manifest)) {
    throw new VerificationRunnerError(`Invalid manifest: ${JSON.stringify(validateVerificationManifest.errors)}`);
  }
  await atomicWriteJSON(manifestPath, manifest);

  return { manifest, findings, passed };
}
