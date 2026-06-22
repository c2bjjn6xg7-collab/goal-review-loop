/**
 * Unit tests for src/runtime/process-runner.ts onOutput observer.
 * Phase 9 R5: verifies filtered agent output is delivered to the callback
 * with 500ms / 2000-char throttle coalescing, and thinking blocks / JSON
 * tool lines never reach the observer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { runProcess } from '../../src/runtime/process-runner.js';

describe('runProcess onOutput', () => {
  let tmpDir: string;
  let stdoutPath: string;
  let stderrPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'process-runner-output-'));
    stdoutPath = path.join(tmpDir, 'stdout.log');
    stderrPath = path.join(tmpDir, 'stderr.log');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.remove(tmpDir);
  });

  it('delivers filtered stdout text to onOutput', async () => {
    const received: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    await runProcess({
      argv: ['bash', '-c', 'printf "Editing src/foo.ts\\n"'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      onOutput: (p) => received.push(p),
    });

    const combined = received.map((r) => r.text).join('');
    expect(combined).toContain('Editing src/foo.ts');
  });

  it('does not deliver thinking blocks to onOutput', async () => {
    const received: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    const script =
      'printf "<thinking>secret reasoning</thinking>Visible line\\n"';
    await runProcess({
      argv: ['bash', '-c', script],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      onOutput: (p) => received.push(p),
    });

    const combined = received.map((r) => r.text).join('');
    expect(combined).not.toContain('secret');
    expect(combined).not.toContain('<thinking>');
    expect(combined).toContain('Visible line');
  });

  it('does not deliver JSON tool_use lines to onOutput', async () => {
    const received: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    const script =
      'printf "Doing work\\n{\\"type\\":\\"tool_use\\",\\"name\\":\\"edit\\"}\\n"';
    await runProcess({
      argv: ['bash', '-c', script],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      onOutput: (p) => received.push(p),
    });

    const combined = received.map((r) => r.text).join('');
    expect(combined).not.toContain('tool_use');
    expect(combined).toContain('Doing work');
  });

  it('writes raw content to stdout file even when filtered for onOutput', async () => {
    const received: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    const script =
      'printf "<thinking>hidden</thinking>Editing src/foo.ts\\n{\\"type\\":\\"tool_use\\",\\"name\\":\\"x\\"}\\n"';
    await runProcess({
      argv: ['bash', '-c', script],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      onOutput: (p) => received.push(p),
    });

    const onDisk = await fs.readFile(stdoutPath, 'utf8');
    expect(onDisk).toContain('<thinking>hidden</thinking>');
    expect(onDisk).toContain('{"type":"tool_use"');
    const combined = received.map((r) => r.text).join('');
    expect(combined).not.toContain('hidden');
    expect(combined).not.toContain('tool_use');
  });

  it('coalesces bursts written within the 500ms flush window', async () => {
    vi.useFakeTimers();
    const received: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    // Emit two chunks back-to-back (real I/O completes near-instantly),
    // then advance fake time past the 500ms flush interval so the
    // coalesced accumulator drains in one delivery before cleanup.
    const promise = runProcess({
      argv: ['bash', '-c', 'printf "burst1\\n"; printf "burst2\\n"'],
      cwd: tmpDir,
      timeout_ms: 5000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      onOutput: (p) => received.push(p),
    });

    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    const combined = received.map((r) => r.text).join('');
    expect(combined).toContain('burst1');
    expect(combined).toContain('burst2');
    // Two chunks emitted within the 500ms window should coalesce into a
    // single flush delivery (the cleanup flush is a no-op once drained).
    expect(received.length).toBe(1);
  });

  it('flushes immediately when accumulated buffer exceeds 2000 chars', async () => {
    const received: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    // Emit 5 chunks of ~450 visible chars each, separated by short sleeps so
    // the child emits distinct 'data' events. Each chunk is below the 500-char
    // per-call truncation, so filterAgentOutput passes it through. The
    // accumulator crosses 2000 chars mid-stream, triggering an immediate
    // threshold flush.
    const chunk = 'b'.repeat(450) + '\n';
    const script = `for i in 1 2 3 4 5; do printf '${chunk}'; sleep 0.05; done`;
    await runProcess({
      argv: ['bash', '-c', script],
      cwd: tmpDir,
      timeout_ms: 10000,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      onOutput: (p) => received.push(p),
    });

    expect(received.length).toBeGreaterThanOrEqual(1);
    const combined = received.map((r) => r.text).join('');
    expect(combined.length).toBeGreaterThan(2000);
  }, 15000);
});
