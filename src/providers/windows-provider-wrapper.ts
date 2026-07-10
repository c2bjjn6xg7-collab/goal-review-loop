#!/usr/bin/env node
/**
 * Windows Provider Wrapper (001-R3 / 015-R2).
 *
 * Replaces the inline PowerShell `-Command` script in platform-commands.ts.
 * PowerShell's `-Command` parameter must be the LAST positional argument on
 * its command line; trailing tokens are treated as command text, NOT bound to
 * `$args`. That made `$args[0]` (the prompt path) empty, so the prompt file
 * was never read and the provider exited with status 1.
 *
 * This Node entry point avoids the PowerShell argv trap entirely: the prompt
 * path arrives as a real argv flag (`--prompt-file`), the prompt BODY travels
 * only over stdin (never argv), and the real provider (`claude`/`opencode`) is
 * resolved by cross-spawn — which handles npm global `.cmd` shims natively.
 *
 * Contract (set by platform-commands.ts win32 branches):
 *   node windows-provider-wrapper.js --prompt-file <path> --provider <name>
 *      [--model <name>] [--permission-mode <acceptEdits|bypassPermissions>]
 *      [--max-turns <n>] [--clear-proxy]
 *
 * The wrapper: reads the prompt file (UTF-8), spawns the provider, pipes the
 * prompt text to the provider's stdin, forwards stdout/stderr, and exits with
 * the provider's exit code. Node's own stdin is ignored by the caller.
 */

import { readFileSync } from 'node:fs';
import crossSpawn from 'cross-spawn';

interface WrapperOptions {
  promptFile: string;
  provider: string;
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  clearProxy: boolean;
}

function parseArgs(argv: string[]): WrapperOptions {
  const args = argv.slice(2);
  const get = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  };

  const promptFile = get('prompt-file');
  const provider = get('provider');
  if (!promptFile || !provider) {
    process.stderr.write(
      'windows-provider-wrapper: --prompt-file and --provider are required\n',
    );
    process.exit(2);
  }

  const maxTurnsRaw = get('max-turns');
  const maxTurns = maxTurnsRaw === undefined ? undefined : Number(maxTurnsRaw);

  return {
    promptFile,
    provider,
    model: get('model'),
    permissionMode: get('permission-mode'),
    maxTurns: maxTurns !== undefined && Number.isFinite(maxTurns) ? maxTurns : undefined,
    clearProxy: args.includes('--clear-proxy'),
  };
}

function buildProviderArgv(opts: WrapperOptions): string[] {
  const argv: string[] = [];
  if (opts.provider === 'claude') {
    argv.push('-p');
    if (opts.permissionMode) {
      argv.push('--permission-mode', opts.permissionMode);
    }
    if (opts.maxTurns !== undefined) {
      argv.push('--max-turns', String(opts.maxTurns));
    }
  } else if (opts.provider === 'opencode') {
    argv.push('run');
    if (opts.model) {
      argv.push('--model', opts.model);
    }
    argv.push('--dangerously-skip-permissions', '--no-replay');
  } else {
    // Unknown provider: pass nothing extra; caller is responsible.
  }
  return argv;
}

function main(): void {
  const opts = parseArgs(process.argv);

  let promptText: string;
  try {
    promptText = readFileSync(opts.promptFile, 'utf8');
  } catch (err) {
    process.stderr.write(
      `windows-provider-wrapper: failed to read prompt file "${opts.promptFile}": ${(err as Error).message}\n`,
    );
    process.exit(2);
  }

  // Optional proxy stripping for the non-builtin Claude profile.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.clearProxy) {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete env[name];
    }
  }

  const providerArgv = buildProviderArgv(opts);
  // cross-spawn resolves npm global .cmd shims on Windows without shell:true.
  const child = crossSpawn(opts.provider, providerArgv, {
    env,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
    windowsVerbatimArguments: true,
  });

  // Deliver the prompt over stdin, then close it so the provider sees EOF.
  child.stdin?.on('error', () => {
    // Provider may have exited before we finished writing; ignore.
  });
  child.stdin?.end(promptText, 'utf8');

  child.on('error', (err) => {
    process.stderr.write(
      `windows-provider-wrapper: failed to spawn "${opts.provider}": ${err.message}\n`,
    );
    process.exit(127);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      // Propagate signal-based termination as a non-zero exit.
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

main();
