/**
 * Phase 8F integration test: Provider network env isolation.
 *
 * Verifies that two provider commands with different proxy_mode settings
 * each see only their own proxy env, and the parent process.env is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { runProcess } from '../../src/runtime/process-runner.js';
import { resolveProviderEnv } from '../../src/providers/network-env.js';
import type { ProviderProfile, ProviderNetworkConfig } from '../../src/types.js';

function makeProfile(network?: ProviderNetworkConfig): ProviderProfile {
  return {
    provider_id: 'test',
    display_name: 'Test Provider',
    execution_mode: 'cli',
    command_template: [],
    prompt_transport: 'stdin',
    permission_modes: [],
    transcript_mode: 'stdout_stderr',
    enabled: true,
    network,
  };
}

describe('Provider network env isolation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-network-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('Codex-like provider with none mode and Claude-like provider with custom mode have isolated envs', async () => {
    // Codex-like: none mode (no proxy)
    const codexProfile = makeProfile({ proxy_mode: 'none' });
    const codexResolved = await resolveProviderEnv(codexProfile);

    // Claude-like: custom mode (with proxy)
    const claudeProfile = makeProfile({ proxy_mode: 'custom', proxy_url: 'http://my-proxy:3128' });
    const claudeResolved = await resolveProviderEnv(claudeProfile);

    // Launch a "Codex" child that prints its env
    const codexStdout = path.join(tmpDir, 'codex-stdout.log');
    const codexStderr = path.join(tmpDir, 'codex-stderr.log');
    const codexResult = await runProcess({
      argv: ['bash', '-c', 'echo "HTTP_PROXY=$HTTP_PROXY"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "NO_PROXY=$NO_PROXY"'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: codexStdout,
      stderr_path: codexStderr,
      env: codexResolved.env,
      delete_env: codexResolved.deleteEnv,
    });

    // Launch a "Claude" child that prints its env
    const claudeStdout = path.join(tmpDir, 'claude-stdout.log');
    const claudeStderr = path.join(tmpDir, 'claude-stderr.log');
    const claudeResult = await runProcess({
      argv: ['bash', '-c', 'echo "HTTP_PROXY=$HTTP_PROXY"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "NO_PROXY=$NO_PROXY"'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: claudeStdout,
      stderr_path: claudeStderr,
      env: claudeResolved.env,
      delete_env: claudeResolved.deleteEnv,
    });

    expect(codexResult.status).toBe('success');
    expect(claudeResult.status).toBe('success');

    const codexOutput = await fs.readFile(codexStdout, 'utf8');
    const claudeOutput = await fs.readFile(claudeStdout, 'utf8');

    // Codex (none mode) should NOT have proxy vars
    expect(codexOutput).toContain('HTTP_PROXY=');
    expect(codexOutput).not.toContain('HTTP_PROXY=http://my-proxy:3128');

    // Claude (custom mode) should have proxy vars
    expect(claudeOutput).toContain('HTTP_PROXY=http://my-proxy:3128');
    expect(claudeOutput).toContain('HTTPS_PROXY=http://my-proxy:3128');
  });

  it('parent process.env is unchanged after resolving provider envs', async () => {
    const parentEnvSnapshot = { ...process.env };

    const codexProfile = makeProfile({ proxy_mode: 'none' });
    await resolveProviderEnv(codexProfile);

    const claudeProfile = makeProfile({ proxy_mode: 'custom', proxy_url: 'http://my-proxy:3128' });
    await resolveProviderEnv(claudeProfile);

    // Parent env should be unchanged
    expect(process.env).toEqual(parentEnvSnapshot);
  });

  it('inherit mode produces no env changes (regression)', async () => {
    const inheritProfile = makeProfile({ proxy_mode: 'inherit' });
    const resolved = await resolveProviderEnv(inheritProfile);

    const stdoutPath = path.join(tmpDir, 'inherit-stdout.log');
    const stderrPath = path.join(tmpDir, 'inherit-stderr.log');

    const result = await runProcess({
      argv: ['bash', '-c', 'echo "HTTP_PROXY=$HTTP_PROXY"'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      env: resolved.env,
      delete_env: resolved.deleteEnv,
    });

    expect(result.status).toBe('success');
    // inherit mode should not modify proxy vars — whatever was in process.env stays
    expect(resolved.env).toEqual({});
    expect(resolved.deleteEnv).toEqual([]);
  });
});
