import { describe, it, expect } from 'vitest';
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

  it('returns fallback when provider is disabled', () => {
    const fallback = ['fallback'];
    const result = resolveCommandForAgent(fallback, 'codebuddy');
    expect(result).toBe(fallback);
  });
});
