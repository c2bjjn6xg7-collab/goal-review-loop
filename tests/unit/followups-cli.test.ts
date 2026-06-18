import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { createFollowupsCommand, extractOpenItems } from '../../src/cli/followups.js';
import { Command } from 'commander';

function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(createFollowupsCommand());
    let stdout = '';
    let stderr = '';
    const origLog = console.log;
    const origErr = console.error;
    console.log = (s: string) => { stdout += s + '\n'; };
    console.error = (s: string) => { stderr += s + '\n'; };
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    prog.parseAsync(argv, { from: 'user' })
      .then(() => {
        const code = process.exitCode ?? 0;
        console.log = origLog; console.error = origErr;
        process.exitCode = prevExitCode;
        resolve({ code, stdout, stderr });
      })
      .catch((e) => {
        console.log = origLog; console.error = origErr;
        process.exitCode = prevExitCode;
        resolve({ code: e.exitCode ?? 1, stdout, stderr });
      });
  });
}

describe('followups CLI', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-cli-')); });
  afterEach(async () => { await fs.remove(tmp); });

  it('list reports no file gracefully', async () => {
    const { stdout } = await run(['followups', 'list', '--project-root', tmp]);
    expect(stdout).toContain('no followups file');
  });

  it('list shows open items and close marks one done', async () => {
    const f = path.join(tmp, '.agent/followups.md');
    await fs.outputFile(f, [
      '### entry 1',
      '- [ ] first task',
      '  - desc',
      '',
      '### entry 2',
      '- [ ] second task',
      '',
    ].join('\n'));
    const { stdout } = await run(['followups', 'list', '--project-root', tmp]);
    expect(stdout).toContain('first task');
    expect(stdout).toContain('second task');

    await run(['followups', 'close', '1', '--project-root', tmp]);
    const after = await fs.readFile(f, 'utf8');
    expect(after).toContain('- [x] first task');
    expect(after).toContain('- [ ] second task');
  });

  it('close rejects out-of-range index', async () => {
    const f = path.join(tmp, '.agent/followups.md');
    await fs.outputFile(f, '- [ ] only\n');
    const { code, stderr } = await run(['followups', 'close', '5', '--project-root', tmp]);
    expect(code).toBe(1);
    expect(stderr).toContain('No open item at index 5');
  });

  it('extractOpenItems pulls checkbox text', () => {
    expect(extractOpenItems('- [ ] a\n- [x] b\n- [ ] c')).toEqual(['a', 'c']);
  });
});
