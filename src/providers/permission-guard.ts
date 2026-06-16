import type { ReviewLoopConfig } from '../types.js';
import { resolveCommandForAgent } from './provider-registry.js';

const DANGEROUS_FLAG = '--dangerously-skip-permissions';
const BYPASS_FLAG = 'bypassPermissions';

export interface PermissionWarning {
  level: 'warning' | 'info';
  message: string;
  provider: string;
  role: string;
}

export function checkPermissionModes(config: ReviewLoopConfig): PermissionWarning[] {
  const warnings: PermissionWarning[] = [];
  const roles = ['planner', 'developer', 'auditor', 'final_auditor'] as const;

  for (const role of roles) {
    const agentConfig = config.agents[role];
    if (!agentConfig) continue;
    const resolvedCommand = resolveCommandForAgent(agentConfig.command, agentConfig.provider, config);
    const cmdStr = resolvedCommand.join(' ');

    if (cmdStr.includes(DANGEROUS_FLAG)) {
      warnings.push({
        level: 'warning',
        message: `Agent "${role}" uses ${DANGEROUS_FLAG}. This bypasses ALL permission checks. Use only in isolated, trusted, disposable repositories.`,
        provider: agentConfig.provider ?? 'default',
        role,
      });
    } else if (cmdStr.includes(BYPASS_FLAG)) {
      warnings.push({
        level: 'info',
        message: `Agent "${role}" uses bypassPermissions mode. File edits will not require confirmation.`,
        provider: agentConfig.provider ?? 'default',
        role,
      });
    }
  }

  return warnings;
}

export function emitPermissionWarnings(config: ReviewLoopConfig): void {
  const warnings = checkPermissionModes(config);
  for (const w of warnings) {
    const prefix = w.level === 'warning' ? '⚠️  WARNING' : 'ℹ️  INFO';
    process.stderr.write(`[review-loop] ${prefix}: ${w.message}\n`);
  }
}
