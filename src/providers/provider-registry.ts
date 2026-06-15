import { execFileSync } from 'node:child_process';
import type { ProviderProfile, ProviderConfig, ReviewLoopConfig } from '../types.js';
import { BUILTIN_PROVIDERS } from './builtin-providers.js';

export interface ProviderRegistry {
  list(): ProviderProfile[];
  resolve(providerId: string): ProviderProfile | null;
  healthCheck(providerId: string): { available: boolean; output: string; duration_ms: number };
}

export function createProviderRegistry(config?: ReviewLoopConfig): ProviderRegistry {
  const customProviders = buildCustomProviders(config);

  function getAllProviders(): ProviderProfile[] {
    const map = new Map<string, ProviderProfile>();
    for (const p of BUILTIN_PROVIDERS) {
      map.set(p.provider_id, { ...p });
    }
    for (const [id, custom] of customProviders) {
      const base = map.get(id);
      if (base) {
        map.set(id, mergeProviderConfig(base, custom));
      } else {
        map.set(id, buildCustomProfile(id, custom));
      }
    }
    return [...map.values()];
  }

  return {
    list(): ProviderProfile[] {
      return getAllProviders();
    },

    resolve(providerId: string): ProviderProfile | null {
      const all = getAllProviders();
      return all.find(p => p.provider_id === providerId) ?? null;
    },

    healthCheck(providerId: string): { available: boolean; output: string; duration_ms: number } {
      const provider = this.resolve(providerId);
      if (!provider || !provider.health_check || provider.health_check.length === 0) {
        return { available: false, output: 'No health check configured', duration_ms: 0 };
      }
      const start = Date.now();
      try {
        const output = execFileSync(
          provider.health_check[0],
          provider.health_check.slice(1),
          { encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        return { available: true, output: output.trim(), duration_ms: Date.now() - start };
      } catch (err) {
        return {
          available: false,
          output: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - start,
        };
      }
    },
  };
}

function buildCustomProviders(config?: ReviewLoopConfig): Map<string, ProviderConfig> {
  const result = new Map<string, ProviderConfig>();
  if (!config?.providers) return result;
  for (const [id, pc] of Object.entries(config.providers)) {
    result.set(id, pc);
  }
  return result;
}

function mergeProviderConfig(base: ProviderProfile, override: ProviderConfig): ProviderProfile {
  return {
    ...base,
    enabled: override.enabled,
    command_template: override.command_template ?? base.command_template,
    prompt_transport: override.prompt_transport ?? base.prompt_transport,
    health_check: override.health_check ?? base.health_check,
    transcript_mode: override.transcript_mode ?? base.transcript_mode,
  };
}

function buildCustomProfile(id: string, pc: ProviderConfig): ProviderProfile {
  return {
    provider_id: id,
    display_name: id,
    command_template: pc.command_template ?? [],
    prompt_transport: pc.prompt_transport ?? 'prompt_file',
    health_check: pc.health_check,
    permission_modes: pc.permission_mode ? [pc.permission_mode] : ['default'],
    transcript_mode: pc.transcript_mode ?? 'stdout_stderr',
    enabled: pc.enabled,
  };
}

export function resolveCommandForAgent(
  agentCommand: string[],
  providerId: string | undefined,
  config?: ReviewLoopConfig,
): string[] {
  if (!providerId) return agentCommand;
  const registry = createProviderRegistry(config);
  const profile = registry.resolve(providerId);
  if (!profile || !profile.enabled || profile.command_template.length === 0) {
    return agentCommand;
  }
  return profile.command_template;
}
