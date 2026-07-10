import { describe, expect, it } from 'vitest';
import crossSpawn from 'cross-spawn';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
  buildBuiltinClaudeCommand,
  buildClaudeCommand,
  buildOpenCodeCommand,
} from '../../src/providers/platform-commands.js';

describe('platform-aware provider commands', () => {
  it('preserves the existing POSIX sh wrappers on macOS', () => {
    const openCode = buildOpenCodeCommand('planner', 'ownplan/deepseekv4pro', 'darwin');
    const claude = buildClaudeCommand('developer', 'darwin');

    expect(openCode.slice(0, 2)).toEqual(['sh', '-c']);
    expect(openCode).toContain('{prompt_file}');
    expect(openCode[2]).toContain('~/.opencode/bin/opencode run');
    expect(openCode[2]).toContain('[review-loop heartbeat] planner');
    expect(claude.slice(0, 2)).toEqual(['sh', '-c']);
    expect(claude[2]).toContain('env -u HTTP_PROXY');
    expect(claude).toContain('{prompt_file}');
  });

  it('uses the Node provider wrapper on Windows (no PowerShell)', () => {
    const openCode = buildOpenCodeCommand('planner', 'model/name', 'win32');
    const claude = buildClaudeCommand('developer', 'win32');

    // argv[0] is the Node executable; argv[1] points at the compiled wrapper.
    expect(openCode[0]).toBe(process.execPath);
    expect(openCode[1]).toContain('windows-provider-wrapper');
    expect(openCode).toContain('{prompt_file}');
    expect(openCode).toContain('--provider');
    expect(openCode).toContain('opencode');
    expect(openCode).toContain('--model');
    expect(openCode).toContain('model/name');
    // No PowerShell anywhere — the -Command argv trap is gone.
    expect(openCode.some((p) => p.includes('powershell'))).toBe(false);

    expect(claude[0]).toBe(process.execPath);
    expect(claude[1]).toContain('windows-provider-wrapper');
    expect(claude).toContain('{prompt_file}');
    expect(claude).toContain('--provider');
    expect(claude).toContain('claude');
    expect(claude).toContain('--permission-mode');
    expect(claude).toContain('bypassPermissions');
    expect(claude).toContain('--max-turns');
    expect(claude).toContain('--clear-proxy');
    expect(claude.some((p) => p.includes('powershell'))).toBe(false);
  });

  it('keeps the built-in Claude profile equivalent across Windows and POSIX', () => {
    const windowsClaude = buildBuiltinClaudeCommand('win32');
    // Built-in profile: acceptEdits, no turn limit, no proxy clearing.
    expect(windowsClaude).toContain('--permission-mode');
    expect(windowsClaude).toContain('acceptEdits');
    expect(windowsClaude).not.toContain('--max-turns');
    expect(windowsClaude).not.toContain('--clear-proxy');
    expect(windowsClaude.some((p) => p.includes('powershell'))).toBe(false);

    expect(buildBuiltinClaudeCommand('darwin')).toEqual([
      'sh', '-lc',
      'exec claude -p --permission-mode acceptEdits < "$1"',
      'claude-developer',
      '{prompt_file}',
    ]);
  });

  it('passes a Windows model name as a wrapper flag, not interpolated into a script', () => {
    const model = 'model; Write-Error injected';
    const command = buildOpenCodeCommand('planner', model, 'win32');

    // The model is a standalone --model flag value, never embedded in a script.
    expect(command).toContain('--model');
    const modelIdx = command.indexOf('--model');
    expect(command[modelIdx + 1]).toBe(model);
  });

  it.skipIf(process.platform !== 'win32')(
    'executes the generated command through a Windows .cmd provider shim',
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-command-win-'));
      try {
        const marker = 'WINDOWS_STDIN_END_测试';
        const longPrompt = `${'长提示内容-'.repeat(2500)}\n${marker}`;
        const promptPath = path.join(tmpDir, 'prompt file.md');
        const probePath = path.join(tmpDir, 'provider-probe.mjs');
        await fs.writeFile(promptPath, longPrompt, 'utf8');
        await fs.writeFile(
          probePath,
          [
            'const chunks = [];',
            'for await (const chunk of process.stdin) chunks.push(chunk);',
            "const stdin = Buffer.concat(chunks).toString('utf8');",
            'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));',
          ].join('\n'),
          'utf8',
        );
        await fs.writeFile(
          path.join(tmpDir, 'opencode.cmd'),
          `@echo off\r\n@"${process.execPath}" "${probePath}" %*\r\n`,
          'utf8',
        );

        const command = buildOpenCodeCommand('planner', 'model/name', 'win32')
          .map((part) => part === '{prompt_file}' ? promptPath : part);
        const result = crossSpawn.sync(command[0], command.slice(1), {
          cwd: tmpDir,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpDir}${path.delimiter}${process.env.PATH ?? ''}` },
        });

        expect(result.error).toBeFalsy();
        expect(result.status).toBe(0);
        const probe = JSON.parse(String(result.stdout)) as { argv: string[]; stdin: string };
        expect(probe.argv).toContain('model/name');
        expect(probe.argv.join(' ')).not.toContain(marker);
        expect(probe.stdin).toContain(marker);
        expect(probe.stdin.length).toBeGreaterThanOrEqual(longPrompt.length);
      } finally {
        await fs.remove(tmpDir);
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'executes the built-in Claude profile with stdin and inherited proxy environment',
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-claude-win-'));
      try {
        const marker = 'BUILTIN_CLAUDE_STDIN_测试';
        const promptPath = path.join(tmpDir, 'prompt file.md');
        const probePath = path.join(tmpDir, 'claude-probe.mjs');
        await fs.writeFile(promptPath, `${'内置提示-'.repeat(2500)}\n${marker}`, 'utf8');
        await fs.writeFile(
          probePath,
          [
            'const chunks = [];',
            'for await (const chunk of process.stdin) chunks.push(chunk);',
            "const stdin = Buffer.concat(chunks).toString('utf8');",
            "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin, proxy: process.env.HTTP_PROXY }));",
          ].join('\n'),
          'utf8',
        );
        await fs.writeFile(
          path.join(tmpDir, 'claude.cmd'),
          `@echo off\r\n@"${process.execPath}" "${probePath}" %*\r\n`,
          'utf8',
        );

        const command = buildBuiltinClaudeCommand('win32')
          .map((part) => part === '{prompt_file}' ? promptPath : part);
        const proxy = 'http://proxy.example:3128';
        const result = crossSpawn.sync(command[0], command.slice(1), {
          cwd: tmpDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            HTTP_PROXY: proxy,
            PATH: `${tmpDir}${path.delimiter}${process.env.PATH ?? ''}`,
          },
        });

        expect(result.error).toBeFalsy();
        expect(result.status).toBe(0);
        const probe = JSON.parse(String(result.stdout)) as {
          argv: string[];
          stdin: string;
          proxy?: string;
        };
        expect(probe.argv).toContain('acceptEdits');
        expect(probe.argv).not.toContain('--max-turns');
        expect(probe.stdin).toContain(marker);
        // Built-in profile inherits the proxy (no --clear-proxy).
        expect(probe.proxy).toBe(proxy);
      } finally {
        await fs.remove(tmpDir);
      }
    },
  );
});
