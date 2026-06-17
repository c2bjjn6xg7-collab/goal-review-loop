import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { atomicWriteJSON } from './atomic-file.js';
import type { ProgressData, TaskProgressInfo } from '../types.js';

export function buildProgressData(params: {
  run_id: string;
  phase: ProgressData['phase'];
  iteration: number;
  max_iterations: number;
  branch: string;
  task_slug: string;
  started_at: string;
  stages: ProgressData['stages'];
  commit_sha?: string | null;
  final_audit_decision?: string | null;
  last_event?: string;
  task_graph?: TaskProgressInfo | null;
}): ProgressData {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    run_id: params.run_id,
    phase: params.phase,
    iteration: params.iteration,
    max_iterations: params.max_iterations,
    branch: params.branch,
    task_slug: params.task_slug,
    started_at: params.started_at,
    updated_at: now,
    last_event: params.last_event ?? `Phase: ${params.phase}`,
    last_event_at: now,
    stages: params.stages,
    commit_sha: params.commit_sha ?? null,
    final_audit_decision: params.final_audit_decision ?? null,
    task_graph: params.task_graph ?? null,
  };
}

export async function writeProgress(projectRoot: string, data: ProgressData): Promise<void> {
  const agentDir = join(projectRoot, '.agent');
  if (!existsSync(agentDir)) return;
  await atomicWriteJSON(join(agentDir, 'progress.json'), data);
}

export function writeProgressMarkdown(projectRoot: string, data: ProgressData): void {
  const agentDir = join(projectRoot, '.agent');
  if (!existsSync(agentDir)) return;

  const lines = [
    `# Progress — ${data.run_id}`,
    '',
    `**Phase**: ${data.phase}`,
    `**Iteration**: ${data.iteration} / ${data.max_iterations}`,
    `**Branch**: ${data.branch}`,
    `**Task**: ${data.task_slug}`,
    `**Started**: ${data.started_at}`,
    `**Updated**: ${data.updated_at}`,
    `**Last event**: ${data.last_event}`,
    '',
    '## Stages',
    '',
    '| Stage | Status | Attempts |',
    '|-------|--------|----------|',
  ];

  for (const [stage, info] of Object.entries(data.stages)) {
    lines.push(`| ${stage} | ${info.status} | ${info.attempts} |`);
  }

  if (data.commit_sha) {
    lines.push('', `**Commit**: ${data.commit_sha}`);
  }
  if (data.final_audit_decision) {
    lines.push('', `**Final Audit**: ${data.final_audit_decision}`);
  }
  if (data.task_graph) {
    lines.push('', '## Task Graph', '');
    lines.push(`| Current Task | Status | Overall |`);
    lines.push(`|--------------|--------|---------|`);
    lines.push(`| ${data.task_graph.task_index} | ${data.task_graph.task_status} | ${data.task_graph.overall_progress} |`);
  }

  lines.push('');
  writeFileSync(join(agentDir, 'progress.md'), lines.join('\n'), 'utf8');
}
