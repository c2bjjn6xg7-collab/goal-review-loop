/**
 * Agent Adapter — unified interface for executing Planner/Developer/Auditor.
 * Phase 3 §8: All agents execute through this adapter and Process Runner.
 */

import { join, resolve, sep, relative, isAbsolute, dirname } from 'node:path';
import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { runProcess } from '../runtime/process-runner.js';
import { computeDigest, recordArtifactDigests, verifyArtifactDigests, type Digest, type ArtifactDigestRecord } from '../runtime/digest.js';
import { renderCommand, type CommandRenderValues } from './command-renderer.js';
import type { AgentRunInput, AgentRunResult, ErrorCategory } from '../types.js';

/** Pre-call artifact state for stale detection. */
export interface PreCallArtifactState {
  records: ArtifactDigestRecord[];
}

/**
 * Record artifact state before calling the agent.
 */
export async function recordPreCallState(
  expectedArtifacts: string[],
): Promise<PreCallArtifactState> {
  const records = await recordArtifactDigests(expectedArtifacts);
  return { records };
}

/**
 * Verify that expected artifacts were created or updated by this agent call.
 */
export async function verifyArtifactFreshness(
  expectedArtifacts: string[],
  preCallState: PreCallArtifactState,
): Promise<ArtifactFreshnessViolation[]> {
  const violations: ArtifactFreshnessViolation[] = [];

  for (const artifactPath of expectedArtifacts) {
    if (!existsSync(artifactPath)) {
      violations.push({
        path: artifactPath,
        violation: 'missing',
        message: `Expected artifact not found: ${artifactPath}`,
      });
      continue;
    }
  }

  const digestViolations = await verifyArtifactDigests(
    preCallState.records.filter(r => r.exists),
  );

  for (const v of digestViolations) {
    if (v.violation === 'deleted') {
      violations.push({
        path: v.path,
        violation: 'deleted',
        message: `Artifact was deleted during agent call: ${v.path}`,
      });
    }
  }

  // F-305R1 fix: Check for stale artifacts (existed before call, digest unchanged).
  // If the artifact existed before the agent call and its digest is still the same,
  // the agent did not produce fresh output — this is always stale, regardless of run_id.
  for (const record of preCallState.records) {
    if (!record.exists) continue;
    if (!existsSync(record.path)) continue;

    const currentDigest = computeDigest(readFileSync(record.path, 'utf8'));
    if (currentDigest === record.digest) {
      violations.push({
        path: record.path,
        violation: 'stale',
        message: `Artifact not modified during agent call (digest unchanged): ${record.path}`,
      });
    }
  }

  return violations;
}

export interface ArtifactFreshnessViolation {
  path: string;
  violation: 'missing' | 'deleted' | 'stale' | 'role_mismatch' | 'iteration_mismatch';
  message: string;
}

/**
 * Run an agent through the unified adapter.
 * F-305 fix: Artifact freshness checks are now wired into the success path.
 */
export async function runAgent(
  input: AgentRunInput,
  projectRoot: string,
): Promise<AgentRunResult> {
  const startTime = Date.now();

  // Step 1: Validate project root
  const resolvedRoot = resolve(projectRoot);
  if (!existsSync(resolvedRoot)) {
    return makeErrorResult(
      'CONFIG_ERROR',
      `Project root does not exist: ${resolvedRoot}`,
      startTime,
    );
  }

  // Step 1b: Validate expected artifact paths are within project root
  // F-314R1 fix: Three-layer containment to prevent sibling-prefix, symlink-parent,
  // and multi-level symlink escapes.
  //
  // Layer 1: relative() check rejects ".." and absolute escapes (sibling prefix).
  // Layer 2: Walk up from each artifact path to find the nearest existing ancestor,
  //   canonicalize it, and verify containment. This catches symlink parents even when
  //   the target file doesn't exist yet (the core F-314R1 scenario).
  // Layer 3: After agent returns, verify each artifact's realpath is within root.
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch {
    canonicalRoot = resolvedRoot;
  }

  for (const artifactPath of input.expected_artifacts) {
    const resolved = resolve(artifactPath);
    const relPath = relative(resolvedRoot, resolved);

    // Layer 1: relative path must not escape the root
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      return makeErrorResult(
        'CONFIG_ERROR',
        `Expected artifact path escapes project root: ${artifactPath}`,
        startTime,
      );
    }

    // Layer 2: Walk up to find nearest existing ancestor and canonicalize it.
    // This catches the case where a symlink parent directory points outside root
    // but the target file doesn't exist yet (so realpathSync on the file would fail).
    let checkPath = resolved;
    while (checkPath !== resolvedRoot && checkPath !== '/') {
      if (existsSync(checkPath)) {
        try {
          const realCheck = realpathSync(checkPath);
          if (realCheck !== canonicalRoot && !realCheck.startsWith(canonicalRoot + sep)) {
            return makeErrorResult(
              'CONFIG_ERROR',
              `Expected artifact path escapes project root (symlink ancestor): ${artifactPath}`,
              startTime,
            );
          }
        } catch {
          // Cannot canonicalize — fail closed
          return makeErrorResult(
            'CONFIG_ERROR',
            `Cannot verify artifact path containment (canonicalize failed): ${artifactPath}`,
            startTime,
          );
        }
        break; // Found existing ancestor, no need to go further up
      }
      // Check if the path component itself is a symlink (even if target doesn't exist)
      const parentDir = dirname(checkPath);
      const component = checkPath.slice(parentDir.length + 1);
      const componentPath = join(parentDir, component);
      try {
        if (lstatSync(componentPath).isSymbolicLink()) {
          const linkTarget = realpathSync(componentPath);
          if (linkTarget !== canonicalRoot && !linkTarget.startsWith(canonicalRoot + sep)) {
            return makeErrorResult(
              'CONFIG_ERROR',
              `Expected artifact path escapes project root (symlink component): ${artifactPath}`,
              startTime,
            );
          }
        }
      } catch {
        // lstat failed — component doesn't exist, continue walking up
      }
      checkPath = parentDir;
    }
  }

  // Step 1c: Record pre-call artifact state for freshness verification (F-305)
  const preCallState = await recordPreCallState(input.expected_artifacts);

  // Step 2: Compute prompt digest
  const promptDigest = computeDigest(input.prompt);

  // Step 3: Render command template to argv
  let argv: string[];
  try {
    const renderValues: CommandRenderValues = {
      prompt: input.prompt,
      prompt_file: input.prompt_file,
      run_id: input.run_id,
      iteration: input.iteration,
      project_root: resolvedRoot,
    };
    argv = renderCommand(input.command_template, renderValues);
  } catch (err) {
    return makeErrorResult(
      'CONFIG_ERROR',
      `Command template rendering failed: ${err instanceof Error ? err.message : String(err)}`,
      startTime,
    );
  }

  // Step 4: Prepare log directories
  const agentDir = join(resolvedRoot, '.agent');
  const debugDir = join(agentDir, 'debug');
  if (!existsSync(debugDir)) {
    await mkdir(debugDir, { recursive: true });
  }

  const logBase = join(debugDir, `${input.run_id}-${input.role}-iter${input.iteration}`);
  const stdoutPath = `${logBase}.stdout.log`;
  const stderrPath = `${logBase}.stderr.log`;

  // Step 5: Execute via Process Runner
  try {
    const processResult = await runProcess(
      {
        argv,
        cwd: resolvedRoot,
        timeout_ms: input.timeout_seconds * 1000,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        signal: input.signal,
      },
      resolvedRoot,
    );

    // Step 6: Check exit status
    if (processResult.status === 'timeout') {
      return {
        status: 'timeout',
        exit_code: processResult.exit_code,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        artifact_paths: [],
        prompt_digest: promptDigest,
        duration_ms: Date.now() - startTime,
        error: {
          code: 'AGENT_TIMEOUT' as ErrorCategory,
          message: `Agent ${input.role} timed out after ${input.timeout_seconds}s`,
          exit_code: processResult.exit_code ?? undefined,
          log_path: stderrPath,
          resumable: false,
          suggested_action: 'Increase timeout or check agent for hangs',
        },
      };
    }

    if (processResult.status === 'cancelled') {
      return {
        status: 'cancelled',
        exit_code: processResult.exit_code,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        artifact_paths: [],
        prompt_digest: promptDigest,
        duration_ms: Date.now() - startTime,
        error: {
          code: 'USER_CANCELLED' as ErrorCategory,
          message: `Agent ${input.role} was cancelled`,
          exit_code: processResult.exit_code ?? undefined,
          log_path: stderrPath,
          resumable: true,
          suggested_action: 'Resume the run to retry this agent',
        },
      };
    }

    if (processResult.status === 'failed' || (processResult.exit_code !== 0 && processResult.exit_code !== null)) {
      return {
        status: 'failed',
        exit_code: processResult.exit_code,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        artifact_paths: [],
        prompt_digest: promptDigest,
        duration_ms: Date.now() - startTime,
        error: {
          code: 'AGENT_ERROR' as ErrorCategory,
          message: `Agent ${input.role} exited with code ${processResult.exit_code}`,
          exit_code: processResult.exit_code ?? undefined,
          log_path: stderrPath,
          resumable: false,
          suggested_action: 'Check agent logs for errors',
        },
      };
    }

    // Step 7: Check expected artifacts exist
    const foundArtifacts: string[] = [];
    const missingArtifacts: string[] = [];
    for (const artifactPath of input.expected_artifacts) {
      if (existsSync(artifactPath)) {
        foundArtifacts.push(artifactPath);
      } else {
        missingArtifacts.push(artifactPath);
      }
    }

    if (missingArtifacts.length > 0) {
      return {
        status: 'failed',
        exit_code: processResult.exit_code,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        artifact_paths: foundArtifacts,
        prompt_digest: promptDigest,
        duration_ms: Date.now() - startTime,
        error: {
          code: 'ARTIFACT_ERROR' as ErrorCategory,
          message: `Agent ${input.role} did not produce expected artifacts: ${missingArtifacts.join(', ')}`,
          log_path: stderrPath,
          resumable: false,
          suggested_action: 'Check agent output and prompt for issues',
        },
      };
    }

    // Step 7a (F-314R1 Layer 3): Post-agent realpath containment check.
    // Now that artifacts exist, verify their real (canonical) paths are within root.
    for (const artifactPath of foundArtifacts) {
      try {
        const realArtifact = realpathSync(artifactPath);
        if (realArtifact !== canonicalRoot && !realArtifact.startsWith(canonicalRoot + sep)) {
          return {
            status: 'failed',
            exit_code: processResult.exit_code,
            stdout_path: stdoutPath,
            stderr_path: stderrPath,
            artifact_paths: [],
            prompt_digest: promptDigest,
            duration_ms: Date.now() - startTime,
            error: {
              code: 'ARTIFACT_ERROR' as ErrorCategory,
              message: `Agent ${input.role} created artifact outside project root (symlink escape): ${artifactPath} → ${realArtifact}`,
              log_path: stderrPath,
              resumable: false,
              suggested_action: 'Check for symlink escapes in artifact paths',
            },
          };
        }
      } catch {
        // Cannot canonicalize — fail closed
        return {
          status: 'failed',
          exit_code: processResult.exit_code,
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
          artifact_paths: [],
          prompt_digest: promptDigest,
          duration_ms: Date.now() - startTime,
          error: {
            code: 'ARTIFACT_ERROR' as ErrorCategory,
            message: `Cannot verify artifact containment (canonicalize failed): ${artifactPath}`,
            log_path: stderrPath,
            resumable: false,
            suggested_action: 'Check for broken symlinks in artifact paths',
          },
        };
      }
    }

    // Step 7b: Verify artifact freshness (F-305)
    // Detects stale artifacts (unchanged from pre-call, wrong run_id),
    // deleted artifacts, and role/iteration mismatches.
    const freshnessViolations = await verifyArtifactFreshness(
      input.expected_artifacts,
      preCallState,
    );

    if (freshnessViolations.length > 0) {
      const violationMessages = freshnessViolations.map(v => v.message).join('; ');
      return {
        status: 'failed',
        exit_code: processResult.exit_code,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        artifact_paths: foundArtifacts,
        prompt_digest: promptDigest,
        duration_ms: Date.now() - startTime,
        error: {
          code: 'ARTIFACT_ERROR' as ErrorCategory,
          message: `Agent ${input.role} artifact freshness check failed: ${violationMessages}`,
          log_path: stderrPath,
          resumable: false,
          suggested_action: 'Agent may have reused stale artifacts from a previous run',
        },
      };
    }

    // Step 8-10: Success
    return {
      status: 'success',
      exit_code: processResult.exit_code,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      artifact_paths: foundArtifacts,
      prompt_digest: promptDigest,
      duration_ms: Date.now() - startTime,
      error: null,
    };
  } catch (err) {
    return makeErrorResult(
      'AGENT_ERROR',
      `Agent ${input.role} execution failed: ${err instanceof Error ? err.message : String(err)}`,
      startTime,
    );
  }
}

function makeErrorResult(
  code: ErrorCategory,
  message: string,
  startTime: number,
): AgentRunResult {
  return {
    status: 'failed',
    exit_code: null,
    stdout_path: '',
    stderr_path: '',
    artifact_paths: [],
    prompt_digest: `sha256:${'0'.repeat(64)}` as Digest,
    duration_ms: Date.now() - startTime,
    error: {
      code,
      message,
      resumable: false,
      suggested_action: 'Check configuration and try again',
    },
  };
}
