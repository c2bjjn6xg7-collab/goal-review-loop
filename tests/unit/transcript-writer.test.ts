import { describe, it, expect } from 'vitest';
import { buildTranscriptEntry, writeTranscript } from '../../src/runtime/transcript-writer.js';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('buildTranscriptEntry', () => {
  it('builds a valid transcript entry', () => {
    const dir = join(tmpdir(), `transcript-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const stdoutPath = join(dir, 'stdout.log');
    const stderrPath = join(dir, 'stderr.log');
    writeFileSync(stdoutPath, 'Hello from agent\n');
    writeFileSync(stderrPath, '');

    const entry = buildTranscriptEntry({
      role: 'developer',
      iteration: 1,
      run_id: 'test-run',
      started_at: '2026-01-01T00:00:00Z',
      result: {
        status: 'success',
        exit_code: 0,
        duration_ms: 5000,
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        artifact_paths: ['.agent/developer-handoff.md'],
      },
    });

    expect(entry.role).toBe('developer');
    expect(entry.iteration).toBe(1);
    expect(entry.status).toBe('success');
    expect(entry.stdout_summary).toContain('Hello from agent');
    expect(entry.artifacts).toContain('.agent/developer-handoff.md');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('writeTranscript', () => {
  it('writes transcript markdown file', () => {
    const dir = join(tmpdir(), `transcript-write-${Date.now()}`);
    mkdirSync(join(dir, '.agent'), { recursive: true });

    const entry = buildTranscriptEntry({
      role: 'auditor',
      iteration: 2,
      run_id: 'run-123',
      started_at: '2026-01-01T00:00:00Z',
      result: {
        status: 'success',
        exit_code: 0,
        duration_ms: 3000,
        stdout_path: '',
        stderr_path: '',
        artifact_paths: ['.agent/audit-report.md'],
      },
    });

    writeTranscript(dir, entry);

    const transcriptPath = join(dir, '.agent', 'transcripts', 'iteration-02-auditor.md');
    expect(existsSync(transcriptPath)).toBe(true);
    const content = readFileSync(transcriptPath, 'utf8');
    expect(content).toContain('auditor');
    expect(content).toContain('success');

    rmSync(dir, { recursive: true, force: true });
  });
});
