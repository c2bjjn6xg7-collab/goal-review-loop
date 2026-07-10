/**
 * Platform-aware command templates for the built-in interactive providers.
 *
 * POSIX keeps the existing shell-wrapper behavior. Windows invokes a compiled
 * Node wrapper (`windows-provider-wrapper.js`) that reads the prompt file and
 * pipes it to the provider over stdin. This avoids PowerShell's `-Command`
 * argv limitation (trailing tokens are command text, not `$args`), which made
 * the prompt path unreachable and caused the provider to exit with status 1.
 */

import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

export type AgentRole = 'planner' | 'developer' | 'auditor' | 'final_auditor';
export type ClaudePermissionMode = 'acceptEdits' | 'bypassPermissions';

/**
 * Absolute path to the compiled Windows provider wrapper.
 *
 * In production this module runs from dist/providers/ (compiled), and the
 * wrapper sits beside it. Under Vitest the module runs from src/providers/
 * (TypeScript source), where only the .ts file exists — the runnable .js is
 * produced by `npm run build` into dist/providers/. So: prefer the sibling
 * .js (production), and fall back to the dist copy relative to the repo root
 * (test environment).
 */
function windowsWrapperPath(): string {
  const here = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, 'windows-provider-wrapper.js');
  if (existsSync(sibling)) {
    return sibling;
  }
  // Test environment: this module is at <root>/src/providers, wrapper is at
  // <root>/dist/providers/windows-provider-wrapper.js.
  const repoRoot = path.resolve(here, '..', '..');
  return path.join(repoRoot, 'dist', 'providers', 'windows-provider-wrapper.js');
}

/**
 * Build the argv that invokes the Node wrapper for a Windows provider. The
 * prompt file placeholder `{prompt_file}` is a standalone argv element so the
 * existing renderCommand whole-element substitution still applies.
 */
function windowsWrapperCommand(
  provider: string,
  flags: string[],
): string[] {
  return [
    process.execPath,
    windowsWrapperPath(),
    '--prompt-file',
    '{prompt_file}',
    '--provider',
    provider,
    ...flags,
  ];
}

function buildPosixHeartbeat(role: AgentRole): string {
  return [
    `heartbeat_interval="\${REVIEW_LOOP_${role.toUpperCase()}_HEARTBEAT_SECONDS:-30}"`,
    '(',
    '  while :; do',
    '    sleep "$heartbeat_interval"',
    `    printf '[review-loop heartbeat] ${role} still running (%ss idle heartbeat)\\n' "$heartbeat_interval" >&2`,
    '  done',
    ') &',
    'heartbeat_pid=$!',
    "trap 'kill \"$heartbeat_pid\" 2>/dev/null || true' EXIT INT TERM",
  ].join('\n');
}

/**
 * Built-in Claude provider command.
 *
 * This intentionally mirrors the original POSIX profile: accept edits,
 * inherit the caller's environment, do not impose a turn limit, and deliver
 * the prompt through stdin.
 */
export function buildBuiltinClaudeCommand(
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    // Built-in Claude profile: accept edits, inherit environment, no turn
    // limit, prompt delivered over stdin by the wrapper.
    return windowsWrapperCommand('claude', ['--permission-mode', 'acceptEdits']);
  }

  return [
    'sh', '-lc',
    'exec claude -p --permission-mode acceptEdits < "$1"',
    'claude-developer',
    '{prompt_file}',
  ];
}

export function buildOpenCodeCommand(
  role: AgentRole,
  model?: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    const flags: string[] = [];
    if (model) {
      flags.push('--model', model);
    }
    return windowsWrapperCommand('opencode', flags);
  }

  const modelFlag = model ? `--model ${model}` : '';
  return [
    'sh', '-c',
    [
      'P=$(cat "$1")',
      buildPosixHeartbeat(role),
      `~/.opencode/bin/opencode run ${modelFlag} --dangerously-skip-permissions --no-replay -- "$P"`,
      'status=$?',
      'kill "$heartbeat_pid" 2>/dev/null || true',
      'wait "$heartbeat_pid" 2>/dev/null || true',
      'exit "$status"',
    ].join('\n'),
    `opencode-${role}`,
    '{prompt_file}',
  ];
}

export function buildClaudeCommand(
  role: AgentRole,
  platform: NodeJS.Platform = process.platform,
  permissionMode: ClaudePermissionMode = 'bypassPermissions',
): string[] {
  if (platform === 'win32') {
    // Non-builtin Claude: clear proxy env, impose a turn limit, prompt over
    // stdin. --clear-proxy makes the wrapper strip HTTP(S)_PROXY/ALL_PROXY.
    return windowsWrapperCommand('claude', [
      '--permission-mode', permissionMode,
      '--max-turns', '160',
      '--clear-proxy',
    ]);
  }

  return [
    'sh', '-c',
    [
      'P=$(cat "$1")',
      buildPosixHeartbeat(role),
      'env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \\',
      `  claude -p --permission-mode ${permissionMode} --max-turns 160 -- "$P"`,
      'status=$?',
      'kill "$heartbeat_pid" 2>/dev/null || true',
      'wait "$heartbeat_pid" 2>/dev/null || true',
      'exit "$status"',
    ].join('\n'),
    `claude-${role}`,
    '{prompt_file}',
  ];
}
