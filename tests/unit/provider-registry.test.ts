import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { createProviderRegistry, resolveCommandForAgent } from '../../src/providers/provider-registry.js';
import { BUILTIN_PROVIDERS, getBuiltinProvider } from '../../src/providers/builtin-providers.js';
import type { ReviewLoopConfig } from '../../src/types.js';

describe('BUILTIN_PROVIDERS', () => {
  it('includes claude, codex, codebuddy, opencode', () => {
    const ids = BUILTIN_PROVIDERS.map(p => p.provider_id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('codebuddy');
    expect(ids).toContain('opencode');
  });

  it('claude is enabled by default', () => {
    const claude = getBuiltinProvider('claude');
    expect(claude).toBeDefined();
    expect(claude!.enabled).toBe(true);
  });

  it('codebuddy and opencode are disabled by default', () => {
    expect(getBuiltinProvider('codebuddy')!.enabled).toBe(false);
    expect(getBuiltinProvider('opencode')!.enabled).toBe(false);
  });

  it('all providers have command_template and prompt_transport', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.command_template.length).toBeGreaterThan(0);
      expect(['stdin', 'prompt_file', 'argv']).toContain(p.prompt_transport);
    }
  });
});

describe('ProviderRegistry', () => {
  it('lists all builtin providers', () => {
    const registry = createProviderRegistry();
    const all = registry.list();
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  it('resolves a known provider', () => {
    const registry = createProviderRegistry();
    const claude = registry.resolve('claude');
    expect(claude).not.toBeNull();
    expect(claude!.provider_id).toBe('claude');
  });

  it('returns null for unknown provider', () => {
    const registry = createProviderRegistry();
    expect(registry.resolve('nonexistent')).toBeNull();
  });

  it('runs a provider health check without a shell', () => {
    const config = {
      providers: {
        probe: {
          enabled: true,
          command_template: [process.execPath, '-e', ''],
          health_check: [process.execPath, '--version'],
        },
      },
    } as unknown as ReviewLoopConfig;
    const result = createProviderRegistry(config).healthCheck('probe');
    expect(result.available).toBe(true);
    expect(result.output).toMatch(/^v\d+/);
  });

  it.skipIf(process.platform !== 'win32')('runs a Windows .cmd provider health check', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-health-win-'));
    try {
      const shimPath = path.join(tmpDir, 'provider-health.cmd');
      await fs.writeFile(shimPath, '@echo off\r\necho provider-health-ok\r\n', 'utf8');
      const config = {
        providers: {
          probe: {
            enabled: true,
            command_template: [shimPath, '{prompt_file}'],
            health_check: [shimPath, '--version'],
          },
        },
      } as unknown as ReviewLoopConfig;

      const result = createProviderRegistry(config).healthCheck('probe');
      expect(result.available).toBe(true);
      expect(result.output).toContain('provider-health-ok');
    } finally {
      await fs.remove(tmpDir);
    }
  });

  it('merges config overrides for builtin providers', () => {
    const config: ReviewLoopConfig = {
      version: 1,
      agents: { planner: { command: ['x'], timeout_seconds: 60 }, developer: { command: ['x'], timeout_seconds: 60 }, auditor: { command: ['x'], timeout_seconds: 60 }, final_auditor: { command: ['x'], timeout_seconds: 60 } },
      providers: {
        claude: { enabled: false },
      },
      loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true },
      git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'a/{run_id}', commit_on_pass: true, commit_template: 'x', create_tag: false, tag_template: 't', push: false },
      runtime: { kill_grace_seconds: 10, max_log_bytes: 1024, lock_stale_seconds: 60 },
    };
    const registry = createProviderRegistry(config);
    const claude = registry.resolve('claude');
    expect(claude!.enabled).toBe(false);
  });

  it('creates custom provider from config', () => {
    const config: ReviewLoopConfig = {
      version: 1,
      agents: { planner: { command: ['x'], timeout_seconds: 60 }, developer: { command: ['x'], timeout_seconds: 60 }, auditor: { command: ['x'], timeout_seconds: 60 }, final_auditor: { command: ['x'], timeout_seconds: 60 } },
      providers: {
        mytool: {
          enabled: true,
          command_template: ['mytool', 'run', '{prompt_file}'],
          prompt_transport: 'prompt_file',
        },
      },
      loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true },
      git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'a/{run_id}', commit_on_pass: true, commit_template: 'x', create_tag: false, tag_template: 't', push: false },
      runtime: { kill_grace_seconds: 10, max_log_bytes: 1024, lock_stale_seconds: 60 },
    };
    const registry = createProviderRegistry(config);
    const custom = registry.resolve('mytool');
    expect(custom).not.toBeNull();
    expect(custom!.provider_id).toBe('mytool');
    expect(custom!.command_template).toEqual(['mytool', 'run', '{prompt_file}']);
  });

  // Phase 8F: network block threading
  it('threads network config through mergeProviderConfig for builtin providers', () => {
    const config: ReviewLoopConfig = {
      version: 1,
      agents: { planner: { command: ['x'], timeout_seconds: 60 }, developer: { command: ['x'], timeout_seconds: 60 }, auditor: { command: ['x'], timeout_seconds: 60 }, final_auditor: { command: ['x'], timeout_seconds: 60 } },
      providers: {
        claude: {
          enabled: true,
          network: { proxy_mode: 'none' },
        },
      },
      loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true },
      git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'a/{run_id}', commit_on_pass: true, commit_template: 'x', create_tag: false, tag_template: 't', push: false },
      runtime: { kill_grace_seconds: 10, max_log_bytes: 1024, lock_stale_seconds: 60 },
    };
    const registry = createProviderRegistry(config);
    const claude = registry.resolve('claude');
    expect(claude).not.toBeNull();
    expect(claude!.network).toBeDefined();
    expect(claude!.network!.proxy_mode).toBe('none');
  });

  it('threads network config through buildCustomProfile for custom providers', () => {
    const config: ReviewLoopConfig = {
      version: 1,
      agents: { planner: { command: ['x'], timeout_seconds: 60 }, developer: { command: ['x'], timeout_seconds: 60 }, auditor: { command: ['x'], timeout_seconds: 60 }, final_auditor: { command: ['x'], timeout_seconds: 60 } },
      providers: {
        myproxy: {
          enabled: true,
          command_template: ['myproxy', 'run', '{prompt_file}'],
          prompt_transport: 'prompt_file',
          network: { proxy_mode: 'custom', proxy_url: 'http://my-proxy:3128' },
        },
      },
      loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true },
      git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'a/{run_id}', commit_on_pass: true, commit_template: 'x', create_tag: false, tag_template: 't', push: false },
      runtime: { kill_grace_seconds: 10, max_log_bytes: 1024, lock_stale_seconds: 60 },
    };
    const registry = createProviderRegistry(config);
    const provider = registry.resolve('myproxy');
    expect(provider).not.toBeNull();
    expect(provider!.network).toBeDefined();
    expect(provider!.network!.proxy_mode).toBe('custom');
    expect(provider!.network!.proxy_url).toBe('http://my-proxy:3128');
  });

  it('preserves undefined network when not configured', () => {
    const config: ReviewLoopConfig = {
      version: 1,
      agents: { planner: { command: ['x'], timeout_seconds: 60 }, developer: { command: ['x'], timeout_seconds: 60 }, auditor: { command: ['x'], timeout_seconds: 60 }, final_auditor: { command: ['x'], timeout_seconds: 60 } },
      providers: {
        claude: { enabled: true },
      },
      loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true },
      git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'a/{run_id}', commit_on_pass: true, commit_template: 'x', create_tag: false, tag_template: 't', push: false },
      runtime: { kill_grace_seconds: 10, max_log_bytes: 1024, lock_stale_seconds: 60 },
    };
    const registry = createProviderRegistry(config);
    const claude = registry.resolve('claude');
    expect(claude!.network).toBeUndefined();
  });
});

describe('resolveCommandForAgent', () => {
  it('returns original command when no provider specified', () => {
    const cmd = ['original', 'command'];
    expect(resolveCommandForAgent(cmd, undefined)).toBe(cmd);
  });

  it('resolves command from provider when provider_id given', () => {
    const fallback = ['fallback'];
    const result = resolveCommandForAgent(fallback, 'claude');
    expect(result).not.toBe(fallback);
    expect(result.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform !== 'win32')('uses a Windows-native Claude provider command', () => {
    const result = resolveCommandForAgent(['fallback'], 'claude');
    // Windows uses the Node provider wrapper (not PowerShell), launched via the
    // Node executable with the built-in Claude profile (acceptEdits, no turns).
    expect(result[0]).toBe(process.execPath);
    expect(result[1]).toContain('windows-provider-wrapper');
    expect(result).not.toContain('sh');
    expect(result).toContain('--provider');
    expect(result).toContain('claude');
    expect(result.join('\n')).toContain('--permission-mode acceptEdits');
    expect(result.join('\n')).not.toContain('--permission-mode bypassPermissions');
    expect(result.join('\n')).not.toContain('--max-turns');
  });

  it('returns fallback when provider is disabled', () => {
    const fallback = ['fallback'];
    const result = resolveCommandForAgent(fallback, 'codebuddy');
    expect(result).toBe(fallback);
  });
});
