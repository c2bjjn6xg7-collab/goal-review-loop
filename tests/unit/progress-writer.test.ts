import { describe, it, expect } from 'vitest';
import { buildProgressData, writeProgress, writeProgressMarkdown } from '../../src/runtime/progress-writer.js';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('buildProgressData', () => {
  it('builds valid ProgressData with all required fields', () => {
    const data = buildProgressData({
      run_id: 'test-run',
      phase: 'DEVELOPING',
      iteration: 1,
      max_iterations: 3,
      branch: 'agent/test',
      task_slug: 'test-task',
      started_at: '2026-01-01T00:00:00Z',
      stages: { planning: { status: 'completed', attempts: 1 }, developing: { status: 'in_progress', attempts: 1 } },
      last_event: 'Developer running',
    });

    expect(data.schema_version).toBe(1);
    expect(data.run_id).toBe('test-run');
    expect(data.phase).toBe('DEVELOPING');
    expect(data.iteration).toBe(1);
    expect(data.last_event).toBe('Developer running');
    expect(data.commit_sha).toBeNull();
    expect(data.final_audit_decision).toBeNull();
  });
});

describe('writeProgress', () => {
  it('writes progress.json to .agent directory', async () => {
    const dir = join(tmpdir(), `progress-test-${Date.now()}`);
    mkdirSync(join(dir, '.agent'), { recursive: true });

    const data = buildProgressData({
      run_id: 'r1',
      phase: 'PLANNING',
      iteration: 0,
      max_iterations: 3,
      branch: 'b',
      task_slug: 't',
      started_at: new Date().toISOString(),
      stages: {},
    });

    await writeProgress(dir, data);

    const written = JSON.parse(readFileSync(join(dir, '.agent', 'progress.json'), 'utf8'));
    expect(written.run_id).toBe('r1');
    expect(written.phase).toBe('PLANNING');

    rmSync(dir, { recursive: true, force: true });
  });

  it('writes progress.md to .agent directory', () => {
    const dir = join(tmpdir(), `progress-md-test-${Date.now()}`);
    mkdirSync(join(dir, '.agent'), { recursive: true });

    const data = buildProgressData({
      run_id: 'r2',
      phase: 'PASSED',
      iteration: 2,
      max_iterations: 3,
      branch: 'b',
      task_slug: 't',
      started_at: new Date().toISOString(),
      stages: {},
      commit_sha: 'abc123',
    });

    writeProgressMarkdown(dir, data);

    const md = readFileSync(join(dir, '.agent', 'progress.md'), 'utf8');
    expect(md).toContain('PASSED');
    expect(md).toContain('abc123');

    rmSync(dir, { recursive: true, force: true });
  });
});
