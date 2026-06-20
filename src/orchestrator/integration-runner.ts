import fs from 'fs-extra';
import path from 'node:path';
import { runGit } from '../git/git-manager.js';
import type { ErrorCategory } from '../types.js';
import type { IntegrationPlan, IntegrationTaskEntry } from './integration-plan.js';

export interface IntegrationRunResult {
  status: 'passed' | 'blocked';
  integration_branch: string;
  applied_tasks: string[];
  skipped_tasks: string[];
  artifact_paths: string[];
  error_message: string | null;
  error_code: ErrorCategory | null;
}

interface CherryPickLogEntry {
  task_id: string;
  branch: string;
  commit_sha: string;
  outcome: 'applied' | 'already_applied' | 'conflict' | 'blocked';
  head_sha: string | null;
  conflicted_paths?: string[];
  error?: string;
  at: string;
}

export function integrationArtifactDir(projectRoot: string): string {
  return path.join(projectRoot, '.agent', 'integration');
}

export function integrationArtifactPaths(projectRoot: string): {
  dir: string;
  plan: string;
  cherryPickLog: string;
  conflictReport: string;
  excludedTasks: string;
} {
  const dir = integrationArtifactDir(projectRoot);
  return {
    dir,
    plan: path.join(dir, 'integration-plan.json'),
    cherryPickLog: path.join(dir, 'cherry-pick-log.jsonl'),
    conflictReport: path.join(dir, 'conflict-report.md'),
    excludedTasks: path.join(dir, 'excluded-tasks.md'),
  };
}

export async function writeIntegrationPlanEvidence(params: {
  projectRoot: string;
  plan: IntegrationPlan;
}): Promise<string[]> {
  const paths = integrationArtifactPaths(params.projectRoot);
  await fs.ensureDir(paths.dir);
  await fs.outputJson(paths.plan, params.plan, { spaces: 2 });

  const artifactPaths = [paths.plan];
  if (params.plan.excluded_tasks.length > 0) {
    const lines = [
      '# Excluded Integration Tasks',
      '',
      `Run ID: ${params.plan.run_id}`,
      '',
      '| Task | Status | Reason |',
      '| --- | --- | --- |',
      ...params.plan.excluded_tasks.map((task) =>
        `| ${escapeMarkdownTableCell(task.task_id)} | ${escapeMarkdownTableCell(task.status)} | ${escapeMarkdownTableCell(task.reason)} |`,
      ),
      '',
    ];
    await fs.outputFile(paths.excludedTasks, lines.join('\n'), 'utf8');
    artifactPaths.push(paths.excludedTasks);
  } else {
    await fs.remove(paths.excludedTasks).catch(() => {});
  }

  return artifactPaths;
}

export async function runIntegrationMerge(params: {
  projectRoot: string;
  runId: string;
  baseCommit: string;
  plan: IntegrationPlan;
}): Promise<IntegrationRunResult> {
  const paths = integrationArtifactPaths(params.projectRoot);
  const artifactPaths = await writeIntegrationPlanEvidence({
    projectRoot: params.projectRoot,
    plan: params.plan,
  });
  await fs.outputFile(paths.cherryPickLog, '', 'utf8');
  await fs.remove(paths.conflictReport).catch(() => {});
  artifactPaths.push(paths.cherryPickLog);

  const branchName = params.plan.integration_branch;
  if (params.plan.excluded_tasks.length > 0) {
    return blockedResult({
      branchName,
      artifactPaths,
      code: 'VERIFICATION_FAILED',
      message: 'Integration plan contains excluded task(s); R1 is fail-closed and will not cherry-pick a partial plan.',
    });
  }

  const branchCheck = await runGit(['check-ref-format', '--branch', branchName], params.projectRoot);
  if (branchCheck.exit_code !== 0) {
    return blockedResult({
      branchName,
      artifactPaths,
      code: 'PREFLIGHT_ERROR',
      message: `Invalid integration branch name: ${branchName}`,
    });
  }

  const branchReady = await ensureIntegrationBranch({
    projectRoot: params.projectRoot,
    branchName,
    baseCommit: params.baseCommit,
  });
  if (!branchReady.ok) {
    return blockedResult({
      branchName,
      artifactPaths,
      code: branchReady.code,
      message: branchReady.message,
    });
  }

  const appliedTasks: string[] = [];
  const skippedTasks: string[] = [];

  for (const task of params.plan.tasks) {
    const alreadyApplied = await isCommitAlreadyApplied(params.projectRoot, task.commit_sha);
    if (alreadyApplied) {
      skippedTasks.push(task.task_id);
      await appendCherryPickLog(paths.cherryPickLog, task, 'already_applied', await currentHead(params.projectRoot));
      continue;
    }

    const pick = await runGit(['cherry-pick', '--no-edit', task.commit_sha], params.projectRoot);
    if (pick.exit_code === 0) {
      appliedTasks.push(task.task_id);
      await appendCherryPickLog(paths.cherryPickLog, task, 'applied', await currentHead(params.projectRoot));
      continue;
    }

    const conflictedPaths = await listConflictedPaths(params.projectRoot);
    await writeConflictReport({
      projectRoot: params.projectRoot,
      plan: params.plan,
      task,
      conflictedPaths,
      gitError: pick.stderr || pick.stdout,
    });
    await appendCherryPickLog(paths.cherryPickLog, task, 'conflict', await currentHead(params.projectRoot), {
      conflicted_paths: conflictedPaths,
      error: pick.stderr || pick.stdout,
    });
    if (!artifactPaths.includes(paths.conflictReport)) {
      artifactPaths.push(paths.conflictReport);
    }
    await runGit(['cherry-pick', '--abort'], params.projectRoot).catch(() => {});
    return {
      ...blockedResult({
        branchName,
        artifactPaths,
        code: 'VERIFICATION_FAILED',
        message: `Cherry-pick conflict while applying ${task.task_id} (${task.commit_sha})`,
      }),
      applied_tasks: appliedTasks,
      skipped_tasks: skippedTasks,
    };
  }

  return {
    status: 'passed',
    integration_branch: branchName,
    applied_tasks: appliedTasks,
    skipped_tasks: skippedTasks,
    artifact_paths: artifactPaths,
    error_message: null,
    error_code: null,
  };
}

async function ensureIntegrationBranch(params: {
  projectRoot: string;
  branchName: string;
  baseCommit: string;
}): Promise<{ ok: true } | { ok: false; code: ErrorCategory; message: string }> {
  const existing = await runGit(['rev-parse', '--verify', `refs/heads/${params.branchName}`], params.projectRoot);
  if (existing.exit_code === 0) {
    const ancestor = await runGit(['merge-base', '--is-ancestor', params.baseCommit, params.branchName], params.projectRoot);
    if (ancestor.exit_code !== 0) {
      return {
        ok: false,
        code: 'STATE_CONFLICT',
        message: `Existing integration branch ${params.branchName} is not a descendant of base commit ${params.baseCommit}`,
      };
    }
    const switchResult = await runGit(['switch', params.branchName], params.projectRoot);
    if (switchResult.exit_code !== 0) {
      return {
        ok: false,
        code: 'STATE_CONFLICT',
        message: `Failed to switch to integration branch ${params.branchName}: ${switchResult.stderr || switchResult.stdout}`,
      };
    }
    return { ok: true };
  }

  const create = await runGit(['switch', '-c', params.branchName, params.baseCommit], params.projectRoot);
  if (create.exit_code !== 0) {
    return {
      ok: false,
      code: 'STATE_CONFLICT',
      message: `Failed to create integration branch ${params.branchName} from ${params.baseCommit}: ${create.stderr || create.stdout}`,
    };
  }
  return { ok: true };
}

async function isCommitAlreadyApplied(projectRoot: string, commitSha: string): Promise<boolean> {
  const ancestor = await runGit(['merge-base', '--is-ancestor', commitSha, 'HEAD'], projectRoot);
  if (ancestor.exit_code === 0) return true;

  const cherry = await runGit(['cherry', 'HEAD', commitSha], projectRoot);
  if (cherry.exit_code !== 0) return false;
  return cherry.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => line.startsWith(`- ${commitSha}`) || line.startsWith('-'));
}

async function currentHead(projectRoot: string): Promise<string | null> {
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], projectRoot);
  return head.exit_code === 0 ? head.stdout : null;
}

async function listConflictedPaths(projectRoot: string): Promise<string[]> {
  const result = await runGit(['diff', '--name-only', '--diff-filter=U'], projectRoot);
  if (result.exit_code !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function appendCherryPickLog(
  logPath: string,
  task: IntegrationTaskEntry,
  outcome: CherryPickLogEntry['outcome'],
  headSha: string | null,
  extra: Partial<Pick<CherryPickLogEntry, 'conflicted_paths' | 'error'>> = {},
): Promise<void> {
  const entry: CherryPickLogEntry = {
    task_id: task.task_id,
    branch: task.branch,
    commit_sha: task.commit_sha,
    outcome,
    head_sha: headSha,
    ...extra,
    at: new Date().toISOString(),
  };
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function writeConflictReport(params: {
  projectRoot: string;
  plan: IntegrationPlan;
  task: IntegrationTaskEntry;
  conflictedPaths: string[];
  gitError: string;
}): Promise<void> {
  const paths = integrationArtifactPaths(params.projectRoot);
  const lines = [
    '# Integration Cherry-Pick Conflict',
    '',
    `Run ID: ${params.plan.run_id}`,
    `Integration branch: ${params.plan.integration_branch}`,
    `Task ID: ${params.task.task_id}`,
    `Task branch: ${params.task.branch}`,
    `Task commit: ${params.task.commit_sha}`,
    'Conflict type: cherry_pick_conflict',
    '',
    '## Conflicted Paths',
    '',
    ...(params.conflictedPaths.length > 0
      ? params.conflictedPaths.map((filePath) => `- ${filePath}`)
      : ['- (Git did not report conflicted paths)']),
    '',
    '## Git Error',
    '',
    params.gitError.trim() || '(no git stderr/stdout captured)',
    '',
    '## Recommended Next Action',
    '',
    'Inspect the conflict, resolve manually on the integration branch, then resume the review loop. Alternatively, drop one of the conflicting tasks and re-integrate.',
    '',
  ];
  await fs.outputFile(paths.conflictReport, lines.join('\n'), 'utf8');
}

function blockedResult(params: {
  branchName: string;
  artifactPaths: string[];
  code: ErrorCategory;
  message: string;
}): IntegrationRunResult {
  return {
    status: 'blocked',
    integration_branch: params.branchName,
    applied_tasks: [],
    skipped_tasks: [],
    artifact_paths: params.artifactPaths,
    error_message: params.message,
    error_code: params.code,
  };
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
