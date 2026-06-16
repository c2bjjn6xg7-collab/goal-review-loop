import { describe, it, expect } from 'vitest';
import { checkPermissionModes, emitPermissionWarnings } from '../../src/providers/permission-guard.js';
import type { ReviewLoopConfig } from '../../src/types.js';

function makeConfig(agentCommands: Record<string, string[]>, providers?: ReviewLoopConfig['providers']): ReviewLoopConfig {
  const mkAgent = (cmd: string[]) => ({ command: cmd, timeout_seconds: 60 });
  return {
    version: 1,
    agents: {
      planner: mkAgent(agentCommands.planner ?? ['codex', 'exec']),
      developer: mkAgent(agentCommands.developer ?? ['claude', '-p']),
      auditor: mkAgent(agentCommands.auditor ?? ['codex', 'exec']),
      final_auditor: mkAgent(agentCommands.final_auditor ?? ['codex', 'exec']),
    },
    providers,
    loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true },
    git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'a/{run_id}', commit_on_pass: true, commit_template: 'x', create_tag: false, tag_template: 't', push: false },
    runtime: { kill_grace_seconds: 10, max_log_bytes: 1024, lock_stale_seconds: 60 },
  };
}

function makeConfigWithProvider(agentProviders: Record<string, string>, providerCommands: Record<string, string[]>): ReviewLoopConfig {
  const mkAgent = (provider: string) => ({ command: ['placeholder'], timeout_seconds: 60, provider });
  const providers: ReviewLoopConfig['providers'] = {};
  for (const [id, cmd] of Object.entries(providerCommands)) {
    providers[id] = { enabled: true, command_template: cmd };
  }
  return {
    version: 1,
    agents: {
      planner: mkAgent(agentProviders.planner ?? 'codex'),
      developer: mkAgent(agentProviders.developer ?? 'claude'),
      auditor: mkAgent(agentProviders.auditor ?? 'codex'),
      final_auditor: mkAgent(agentProviders.final_auditor ?? 'codex'),
    },
    providers,
    loop: { max_iterations: 3, archive_history: true, stop_on_infrastructure_error: true },
    git: { require_repository: true, require_head: true, require_clean_worktree: true, branch_template: 'a/{run_id}', commit_on_pass: true, commit_template: 'x', create_tag: false, tag_template: 't', push: false },
    runtime: { kill_grace_seconds: 10, max_log_bytes: 1024, lock_stale_seconds: 60 },
  };
}

describe('checkPermissionModes', () => {
  it('returns empty for safe commands', () => {
    const config = makeConfig({ developer: ['claude', '-p', '--permission-mode', 'acceptEdits'] });
    expect(checkPermissionModes(config)).toEqual([]);
  });

  it('detects dangerously-skip-permissions', () => {
    const config = makeConfig({ developer: ['claude', '-p', '--dangerously-skip-permissions'] });
    const warnings = checkPermissionModes(config);
    expect(warnings.length).toBe(1);
    expect(warnings[0].level).toBe('warning');
    expect(warnings[0].role).toBe('developer');
  });

  it('detects bypassPermissions as info', () => {
    const config = makeConfig({ developer: ['claude', '-p', '--permission-mode', 'bypassPermissions'] });
    const warnings = checkPermissionModes(config);
    expect(warnings.length).toBe(1);
    expect(warnings[0].level).toBe('info');
  });

  it('detects multiple roles with dangerous flags', () => {
    const config = makeConfig({
      developer: ['claude', '--dangerously-skip-permissions'],
      auditor: ['claude', '--dangerously-skip-permissions'],
    });
    const warnings = checkPermissionModes(config);
    expect(warnings.length).toBe(2);
  });

  // F-601 regression: provider command_template with dangerous flags
  it('detects dangerously-skip-permissions in provider command_template', () => {
    const config = makeConfigWithProvider(
      { developer: 'myprovider' },
      { myprovider: ['mytool', 'run', '--dangerously-skip-permissions', '{prompt_file}'] },
    );
    const warnings = checkPermissionModes(config);
    expect(warnings.length).toBe(1);
    expect(warnings[0].level).toBe('warning');
    expect(warnings[0].role).toBe('developer');
    expect(warnings[0].provider).toBe('myprovider');
  });

  // F-601 regression: safe agent command but dangerous provider command
  it('detects bypassPermissions in provider even when agent command is safe', () => {
    const config = makeConfigWithProvider(
      { developer: 'risky' },
      { risky: ['risky-tool', '--permission-mode', 'bypassPermissions', '{prompt_file}'] },
    );
    const warnings = checkPermissionModes(config);
    expect(warnings.length).toBe(1);
    expect(warnings[0].level).toBe('info');
    expect(warnings[0].provider).toBe('risky');
  });
});
