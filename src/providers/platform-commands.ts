/**
 * Platform-aware command templates for the built-in interactive providers.
 *
 * POSIX keeps the existing shell-wrapper behavior. Windows
 * uses Windows PowerShell to read the prompt file and then invokes the
 * provider through PowerShell's native command resolution (including npm
 * `.cmd` shims).
 */

export type AgentRole = 'planner' | 'developer' | 'auditor' | 'final_auditor';
export type ClaudePermissionMode = 'acceptEdits' | 'bypassPermissions';

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

function windowsPowerShellCommand(script: string, extraArgs: string[] = []): string[] {
  return [
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
    '{prompt_file}',
    ...extraArgs,
  ];
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
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$promptPath = $args[0]',
      'if ([string]::IsNullOrWhiteSpace($promptPath)) { throw "Missing prompt file path" }',
      '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$P = [IO.File]::ReadAllText($promptPath, [Text.Encoding]::UTF8)',
      '$P | & claude -p --permission-mode acceptEdits',
      '$status = $LASTEXITCODE',
      'if ($null -eq $status) { exit 1 }',
      'exit $status',
    ].join('\n');
    return windowsPowerShellCommand(script);
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
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$promptPath = $args[0]',
      '$model = $args[1]',
      'if ([string]::IsNullOrWhiteSpace($promptPath)) { throw "Missing prompt file path" }',
      '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$P = [IO.File]::ReadAllText($promptPath, [Text.Encoding]::UTF8)',
      'if ([string]::IsNullOrWhiteSpace($model)) {',
      '  $P | & opencode run --dangerously-skip-permissions --no-replay',
      '} else {',
      '  $P | & opencode run --model $model --dangerously-skip-permissions --no-replay',
      '}',
      '$status = $LASTEXITCODE',
      'if ($null -eq $status) { exit 1 }',
      'exit $status',
    ].join('\n');
    return windowsPowerShellCommand(script, model ? [model] : []);
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
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$promptPath = $args[0]',
      'if ([string]::IsNullOrWhiteSpace($promptPath)) { throw "Missing prompt file path" }',
      "$proxyNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')",
      'foreach ($name in $proxyNames) { [Environment]::SetEnvironmentVariable($name, $null, "Process") }',
      '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '$P = [IO.File]::ReadAllText($promptPath, [Text.Encoding]::UTF8)',
      `$P | & claude -p --permission-mode ${permissionMode} --max-turns 160`,
      '$status = $LASTEXITCODE',
      'if ($null -eq $status) { exit 1 }',
      'exit $status',
    ].join('\n');
    return windowsPowerShellCommand(script);
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
