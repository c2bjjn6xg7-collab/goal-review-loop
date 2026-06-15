import { join } from 'node:path';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import type { TranscriptEntry } from '../types.js';

const MAX_STDOUT_BYTES = 4096;
const MAX_STDERR_BYTES = 2048;

export function buildTranscriptEntry(params: {
  role: TranscriptEntry['role'];
  iteration: number;
  run_id: string;
  started_at: string;
  result: {
    status: 'success' | 'failed' | 'timeout' | 'cancelled';
    exit_code: number | null;
    duration_ms: number;
    stdout_path: string;
    stderr_path: string;
    artifact_paths: string[];
  };
}): TranscriptEntry {
  const stdoutSummary = readSummary(params.result.stdout_path, MAX_STDOUT_BYTES);
  const stderrSummary = readSummary(params.result.stderr_path, MAX_STDERR_BYTES);

  return {
    role: params.role,
    iteration: params.iteration,
    run_id: params.run_id,
    started_at: params.started_at,
    finished_at: new Date().toISOString(),
    duration_ms: params.result.duration_ms,
    status: params.result.status,
    exit_code: params.result.exit_code,
    stdout_summary: stdoutSummary,
    stderr_summary: stderrSummary,
    artifacts: params.result.artifact_paths,
  };
}

export function writeTranscript(projectRoot: string, entry: TranscriptEntry): void {
  const transcriptsDir = join(projectRoot, '.agent', 'transcripts');
  if (!existsSync(transcriptsDir)) {
    mkdirSync(transcriptsDir, { recursive: true });
  }

  const iterStr = String(entry.iteration).padStart(2, '0');
  const fileName = `iteration-${iterStr}-${entry.role}.md`;
  const filePath = join(transcriptsDir, fileName);

  const lines = [
    `---`,
    `role: ${entry.role}`,
    `iteration: ${entry.iteration}`,
    `run_id: "${entry.run_id}"`,
    `started_at: "${entry.started_at}"`,
    `finished_at: "${entry.finished_at}"`,
    `duration_ms: ${entry.duration_ms}`,
    `status: "${entry.status}"`,
    `exit_code: ${entry.exit_code ?? 'null'}`,
    `---`,
    '',
    `# ${entry.role} — Iteration ${entry.iteration}`,
    '',
    `## Status`,
    '',
    `- **Result**: ${entry.status}`,
    `- **Exit code**: ${entry.exit_code ?? 'N/A'}`,
    `- **Duration**: ${entry.duration_ms}ms`,
    '',
    `## Artifacts`,
    '',
    ...entry.artifacts.map(a => `- \`${a}\``),
    '',
    `## stdout (last 4KB)`,
    '',
    '```',
    entry.stdout_summary || '(empty)',
    '```',
    '',
    `## stderr (last 2KB)`,
    '',
    '```',
    entry.stderr_summary || '(empty)',
    '```',
    '',
  ];

  writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function readSummary(filePath: string, maxBytes: number): string {
  if (!filePath || !existsSync(filePath)) return '';
  try {
    const content = readFileSync(filePath, 'utf8');
    if (content.length <= maxBytes) return content;
    return '...' + content.slice(content.length - maxBytes);
  } catch {
    return '(unreadable)';
  }
}
