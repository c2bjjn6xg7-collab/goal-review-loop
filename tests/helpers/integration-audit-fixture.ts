import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeDigest } from '../../src/runtime/digest.js';
import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import { writeIntegrationPlanEvidence } from '../../src/orchestrator/integration-runner.js';
import type { IntegrationPlan } from '../../src/orchestrator/integration-plan.js';
import { OrchestratorFileRegistry, registerDirectoryFiles } from '../../src/orchestrator/run-orchestrator.js';
import { StateStore } from '../../src/orchestrator/state-store.js';
import { Phase, type GoalFrontMatter, type ReviewLoopConfig, type VerificationCommand } from '../../src/types.js';

export const INTEGRATION_AUDIT_RUN_ID = 'run-integration-audit';

export interface IntegrationAuditFixture {
  repoDir: string;
  agentDir: string;
  runId: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  registry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  goalDigest: string;
  goalFrontMatter: GoalFrontMatter;
  verificationCommands: VerificationCommand[];
  cleanup: () => void;
}

export async function createIntegrationAuditFixture(options: {
  suffix: string;
  allowedChanges?: string[];
  verificationCommand?: string[];
  finalAuditorBehavior?: 'audit-pass' | 'audit-fail' | 'audit-blocked' | 'audit-tamper-final';
  perTaskDiffDigest?: string;
  integrationChange?: 'add-feature' | 'delete-base';
}): Promise<IntegrationAuditFixture> {
  const repoDir = mkdtempSync(path.join(tmpdir(), `integration-audit-${options.suffix}-`));
  const runId = INTEGRATION_AUDIT_RUN_ID;
  const integrationBranch = `integration/${runId}`;

  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  writeFile(repoDir, '.gitignore', '.agent/**\nnode_modules/**\n');
  writeFile(repoDir, 'package.json', JSON.stringify({
    name: `integration-audit-${options.suffix}`,
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  writeFile(repoDir, 'src/base.ts', 'export const base = true;\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  const baseCommit = git(repoDir, ['rev-parse', '--verify', 'HEAD']);
  const mainBranch = git(repoDir, ['branch', '--show-current']);

  git(repoDir, ['switch', '-c', integrationBranch, baseCommit]);
  if (options.integrationChange === 'delete-base') {
    rmSync(path.join(repoDir, 'src', 'base.ts'));
    git(repoDir, ['add', '--', 'src/base.ts']);
    git(repoDir, ['commit', '-q', '-m', 'delete base feature']);
  } else {
    writeFile(repoDir, 'src/feature.ts', 'export const feature = true;\n');
    git(repoDir, ['add', 'src/feature.ts']);
    git(repoDir, ['commit', '-q', '-m', 'integrated feature']);
  }
  const integrationHead = git(repoDir, ['rev-parse', '--verify', 'HEAD']);

  const agentDir = path.join(repoDir, '.agent');
  const artifactStore = new ArtifactStore(repoDir);
  await artifactStore.init();
  const stateStore = new StateStore(agentDir);
  await stateStore.create({
    run_id: runId,
    task_slug: 'integration-audit',
    project_root: repoDir,
    base_commit: baseCommit,
    branch: mainBranch,
    max_iterations: 3,
  });
  await stateStore.transition(Phase.PLANNING);

  const goalFrontMatter = buildGoalFrontMatter({
    runId,
    allowedChanges: options.allowedChanges ?? ['src/**'],
    verificationCommand: options.verificationCommand ?? ['node', '-e', 'process.exit(0)'],
  });
  const goalContent = renderGoal(goalFrontMatter);
  const goalDigest = computeDigest(goalContent);
  writeFile(repoDir, '.agent/GOAL.md', goalContent);
  writeFile(repoDir, '.agent/plan.md', renderPlan(runId));
  writeFile(repoDir, '.agent/developer-handoff.md', renderHandoff(runId));
  writeFile(repoDir, '.agent/task-graph.json', JSON.stringify({
    schema_version: 1,
    run_id: runId,
    goal_digest: goalDigest,
    created_at: new Date().toISOString(),
    tasks: [
      {
        id: 'task-1',
        title: 'Integrated fixture task',
        description: 'Fixture task used by integration audit tests.',
        difficulty: 'low',
        risk: 'low',
        parallelizable: false,
        depends_on: [],
        allowed_changes: options.allowedChanges ?? ['src/**'],
        disallowed_changes: ['.git/**', '.agent/state.json'],
        verification_commands: [
          {
            id: 'task-1-verify',
            command: options.verificationCommand ?? ['node', '-e', 'process.exit(0)'],
            cwd: '.',
            required: true,
            timeout_seconds: 30,
          },
        ],
        status: 'passed',
      },
    ],
  }, null, 2));
  writeFile(repoDir, '.agent/task-results.json', JSON.stringify({
    schema_version: 1,
    run_id: runId,
    results: [
      {
        task_id: 'task-1',
        status: 'passed',
        branch: `agent/${runId}/task-1`,
        commit_sha: integrationHead,
      },
    ],
  }, null, 2));
  await stateStore.update(() => ({ goal_digest: goalDigest }));
  await stateStore.transition(Phase.DEVELOPING);

  const plan: IntegrationPlan = {
    schema_version: 1,
    run_id: runId,
    base_commit: baseCommit,
    integration_branch: integrationBranch,
    tasks: [
      {
        task_id: 'task-1',
        branch: `agent/${runId}/task-1`,
        commit_sha: integrationHead,
        status: 'passed',
      },
    ],
    excluded_tasks: [],
    partial: false,
    created_at: new Date().toISOString(),
  };
  await writeIntegrationPlanEvidence({ projectRoot: repoDir, plan });
  writeFile(repoDir, '.agent/integration/cherry-pick-log.jsonl', JSON.stringify({
    task_id: 'task-1',
    branch: `agent/${runId}/task-1`,
    commit_sha: integrationHead,
    outcome: 'already_applied',
    head_sha: integrationHead,
    at: new Date().toISOString(),
  }) + '\n');
  if (options.perTaskDiffDigest) {
    writeFile(repoDir, '.agent/task-runs/task-1/result.json', JSON.stringify({
      schema_version: 1,
      run_id: runId,
      task_id: 'task-1',
      status: 'passed',
      exit_code: 0,
      final_commit_sha: integrationHead,
      diff_digest: options.perTaskDiffDigest,
      branch: `agent/${runId}/task-1`,
      error: null,
      finished_at: new Date().toISOString(),
    }, null, 2));
  }

  const registry = new OrchestratorFileRegistry();
  registerDirectoryFiles(agentDir, registry);

  return {
    repoDir,
    agentDir,
    runId,
    baseCommit,
    integrationBranch,
    integrationHead,
    stateStore,
    artifactStore,
    registry,
    config: buildConfig(options.finalAuditorBehavior ?? 'audit-pass'),
    goalDigest,
    goalFrontMatter,
    verificationCommands: goalFrontMatter.verification_commands.map((command) => ({
      id: command.id,
      argv: command.command,
      cwd: command.cwd,
      required: command.required,
      timeout_seconds: command.timeout_seconds,
    })),
    cleanup: () => {
      if (existsSync(repoDir)) {
        rmSync(repoDir, { recursive: true, force: true });
      }
    },
  };
}

export async function runFixtureIntegrationAudit(fixture: IntegrationAuditFixture) {
  const { runIntegrationAudit } = await import('../../src/orchestrator/integration-audit.js');
  return runIntegrationAudit({
    projectRoot: fixture.repoDir,
    agentDir: fixture.agentDir,
    runId: fixture.runId,
    baseCommit: fixture.baseCommit,
    goalDigest: fixture.goalDigest,
    goalFrontMatter: fixture.goalFrontMatter,
    verificationCommands: fixture.verificationCommands,
    integrationBranch: fixture.integrationBranch,
    stateStore: fixture.stateStore,
    artifactStore: fixture.artifactStore,
    orchestratorRegistry: fixture.registry,
    config: fixture.config,
    combinedSignal: new AbortController().signal,
    iteration: 3,
  });
}

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function writeFile(repoDir: string, relativePath: string, content: string): void {
  mkdirSync(path.dirname(path.join(repoDir, relativePath)), { recursive: true });
  writeFileSync(path.join(repoDir, relativePath), content, 'utf8');
}

function buildGoalFrontMatter(params: {
  runId: string;
  allowedChanges: string[];
  verificationCommand: string[];
}): GoalFrontMatter {
  return {
    schema_version: 1,
    run_id: params.runId,
    goal_id: 'integration-audit-goal',
    title: 'Integration audit goal',
    allowed_changes: params.allowedChanges,
    disallowed_changes: ['.git/**', '.agent/state.json', '.agent/GOAL.md', '.agent/final-audit.md'],
    verification_commands: [
      {
        id: 'goal-check',
        command: params.verificationCommand,
        cwd: '.',
        required: true,
        timeout_seconds: 30,
      },
    ],
  };
}

function renderGoal(goal: GoalFrontMatter): string {
  return `---
schema_version: 1
run_id: "${goal.run_id}"
goal_id: "${goal.goal_id}"
title: "${goal.title}"
allowed_changes:
${goal.allowed_changes.map((item) => `  - "${item}"`).join('\n')}
disallowed_changes:
${goal.disallowed_changes.map((item) => `  - "${item}"`).join('\n')}
verification_commands:
  - id: "${goal.verification_commands[0].id}"
    command: ${JSON.stringify(goal.verification_commands[0].command)}
    cwd: "."
    required: true
    timeout_seconds: 30
---

# Objective

Audit the integrated diff.

# Success Criteria

1. Integrated feature is present.

# Non-Goals

- Do not create a final commit.

# Constraints

- Use integrated evidence only.
`;
}

function renderPlan(runId: string): string {
  return `---
schema_version: 1
run_id: "${runId}"
author_role: "planner"
---

# Plan

Run integrated audit.
`;
}

function renderHandoff(runId: string): string {
  return `---
schema_version: 1
run_id: "${runId}"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---

# Developer Handoff

Integrated task branches are ready.
`;
}

function buildConfig(finalAuditorBehavior: string): ReviewLoopConfig {
  const fakeAgentPath = path.resolve(path.join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const agent = (role: string, behavior: string) => ({
    command: [
      'node',
      fakeAgentPath,
      '--role',
      role,
      '--run-id',
      '{run_id}',
      '--iteration',
      '{iteration}',
      '--project-root',
      '{project_root}',
      '--prompt-file',
      '{prompt_file}',
      '--behavior',
      behavior,
    ],
    timeout_seconds: 60,
  });
  return {
    version: 1,
    agents: {
      planner: agent('planner', 'success'),
      developer: agent('developer', 'success'),
      auditor: agent('auditor', 'audit-pass'),
      final_auditor: agent('final-auditor', finalAuditorBehavior),
    },
    loop: {
      max_iterations: 3,
      archive_history: true,
      stop_on_infrastructure_error: true,
      max_consecutive_failures: 3,
      max_agent_retries: 0,
    },
    git: {
      require_repository: true,
      require_head: true,
      require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: true,
      commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
      create_tag: false,
      tag_template: 'agent-{run_id}-pass',
      push: false,
    },
    runtime: {
      kill_grace_seconds: 5,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
      cancel_grace_seconds: 10,
      agent_idle_timeout_seconds: 30,
    },
    feedback_protocol: {
      enabled: false,
      self_correction: false,
      max_blocks_per_document: 10,
      allowed_types_per_role: {
        planner: ['clarify', 'risk_note', 'scope_concern', 'verification_suggestion'],
        developer: ['risk_note', 'scope_concern', 'verification_suggestion'],
        auditor: ['followup_task', 'risk_note', 'scope_concern', 'verification_suggestion'],
        final_auditor: ['followup_task', 'risk_note'],
      },
    },
    parallel: { enabled: false, max_parallel_workers: 1 },
  };
}

export function readFixtureJson<T>(fixture: IntegrationAuditFixture, relativePath: string): T {
  return JSON.parse(readFileSync(path.join(fixture.repoDir, relativePath), 'utf8')) as T;
}
