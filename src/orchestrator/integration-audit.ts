import fs from 'fs-extra';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildFinalAuditorInput, validateFinalAuditorOutput } from '../agents/final-auditor-adapter.js';
import { buildFinalAuditorPrompt, buildPrompt, deletePromptFile, type PromptCleanupResult } from '../agents/prompt-builder.js';
import { runAgent } from '../agents/agent-adapter.js';
import { collectDiff } from '../git/diff-collector.js';
import { runGit } from '../git/git-manager.js';
import { resolveCommandForAgent } from '../providers/provider-registry.js';
import { computeFileDigest, type Digest } from '../runtime/digest.js';
import { checkScope } from '../scope/scope-guard.js';
import { runVerification } from '../verification/verification-runner.js';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { IntegrationPlan } from './integration-plan.js';
import { integrationArtifactPaths } from './integration-runner.js';
import { readFeedbackNotesForAudit, dispatchFeedbackBlocks } from './feedback-dispatcher.js';
import {
  appendLog,
  computeDigest,
  emitProgress,
  registerAgentLogs,
  registerDirectoryFiles,
  type OrchestratorFileRegistry,
} from './run-orchestrator.js';
import type { StateStore } from './state-store.js';
import {
  ErrorCategory,
  Phase as PhaseEnum,
  type ErrorCategory as ErrorCategoryType,
  type FinalAuditDecision,
  type GoalFrontMatter,
  type ReviewLoopConfig,
  type VerificationCommand,
} from '../types.js';

export interface IntegrationAuditResult {
  status: 'passed' | 'blocked';
  integration_branch: string;
  integration_head: string | null;
  integrated_diff_digest: string | null;
  audit_decision: FinalAuditDecision | null;
  artifact_paths: string[];
  error_code: ErrorCategoryType | null;
  error_message: string | null;
}

export interface IntegrationAuditParams {
  projectRoot: string;
  agentDir: string;
  runId: string;
  baseCommit: string;
  goalDigest: string;
  goalFrontMatter: GoalFrontMatter;
  verificationCommands: VerificationCommand[];
  integrationBranch: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  combinedSignal: AbortSignal;
  iteration: number;
}

interface IntegratedDiffMetadata {
  schema_version: 1;
  run_id: string;
  base_commit: string;
  integration_branch: string;
  integration_head: string;
  integrated_diff_digest: string;
  changed_files: string[];
  created_at: string;
  artifact_paths: {
    tracked_diff: string;
    changed_files: string;
    untracked_files: string;
    diff_metadata: string;
  };
}

interface FinalAuditContext {
  schema_version: 1;
  run_id: string;
  base_commit: string;
  integration_branch: string;
  integration_head: string;
  integrated_diff_digest: string;
  changed_files: string[];
  task_provenance: Array<{
    task_id: string;
    branch: string;
    commit_sha: string;
  }>;
  per_task_diff_digest_reused: false;
  per_task_diff_digest_policy: string;
  evidence_paths: Record<string, string>;
  created_at: string;
}

const SKIP_REASON =
  'Phase 8E R2 ran integrated verification and Final Aggregate Audit; final commit/tag are deferred to R3.';

export async function runIntegrationAudit(params: IntegrationAuditParams): Promise<IntegrationAuditResult> {
  const {
    projectRoot,
    agentDir,
    runId,
    baseCommit,
    goalDigest,
    goalFrontMatter,
    verificationCommands,
    integrationBranch,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    config,
    combinedSignal,
    iteration,
  } = params;

  const paths = integrationAuditPaths(projectRoot);
  await fs.ensureDir(paths.dir);
  const artifactPaths = uniquePaths([
    paths.plan,
    paths.cherryPickLog,
    paths.dir,
  ]);

  const verifyingReady = await ensureVerifyingPhase(stateStore);
  if (!verifyingReady.ok) {
    return blocked({
      integrationBranch,
      artifactPaths,
      code: ErrorCategory.STATE_CONFLICT,
      message: verifyingReady.message,
    });
  }

  const preconditions = await validateIntegrationPreconditions({
    projectRoot,
    runId,
    baseCommit,
    integrationBranch,
  });
  artifactPaths.push(...preconditions.artifactPaths);
  if (!preconditions.ok) {
    return blocked({
      integrationBranch,
      integrationHead: preconditions.integrationHead,
      artifactPaths,
      code: preconditions.code,
      message: preconditions.message,
    });
  }

  await stateStore.update(() => ({ branch: integrationBranch }));
  await appendLog(
    artifactStore,
    runId,
    iteration,
    'VERIFYING',
    'integration audit preconditions',
    'PASS',
    integrationBranch,
  );

  let diffResult = await collectDiff({
    projectRoot,
    baseCommit,
    iteration,
  });
  let integratedDiffDigest = `sha256:${diffResult.diffDigest}` as Digest;
  await writeIntegratedDiffEvidence({
    runId,
    baseCommit,
    integrationBranch,
    integrationHead: preconditions.integrationHead,
    integratedDiffDigest,
    diffResult,
    paths,
  });
  artifactPaths.push(
    paths.trackedDiff,
    paths.changedFiles,
    paths.untrackedFiles,
    paths.diffMetadata,
    paths.integratedDiffMetadata,
  );
  registerDirectoryFiles(paths.dir, orchestratorRegistry);

  const scopeResult = checkScope({
    allowedChanges: goalFrontMatter.allowed_changes,
    disallowedChanges: goalFrontMatter.disallowed_changes,
    changedFiles: diffResult.changedFiles,
    orchestratorOwnedFiles: orchestratorRegistry.getRelativePaths(projectRoot),
  });
  await fs.outputJson(paths.scopeReport, scopeResult.report, { spaces: 2 });
  artifactPaths.push(paths.scopeReport);
  registerDirectoryFiles(paths.dir, orchestratorRegistry);

  if (!scopeResult.passed) {
    const deniedPaths = scopeResult.report.denied.map((denial) => `${denial.path} (${denial.reason})`).join(', ');
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'VERIFYING',
      'integration scope result',
      'FAIL',
      deniedPaths,
    );
    return blocked({
      integrationBranch,
      integrationHead: preconditions.integrationHead,
      integratedDiffDigest,
      artifactPaths,
      code: ErrorCategory.SCOPE_VIOLATION,
      message: `Integrated scope violation: ${deniedPaths}`,
    });
  }

  await appendLog(
    artifactStore,
    runId,
    iteration,
    'VERIFYING',
    'integration scope result',
    'PASS',
  );

  const verificationResult = await runVerification({
    commands: verificationCommands,
    projectRoot,
    runId,
    iteration,
    signal: combinedSignal,
  });
  await fs.copy(path.join(agentDir, 'verification', 'manifest.json'), paths.verificationManifest);
  artifactPaths.push(paths.verificationManifest);
  registerDirectoryFiles(path.join(agentDir, 'verification'), orchestratorRegistry);
  registerDirectoryFiles(paths.dir, orchestratorRegistry);

  if (!verificationResult.passed) {
    const failed = verificationResult.manifest.commands
      .filter((command) => command.required && command.status !== 'success')
      .map((command) => command.id)
      .join(', ');
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'VERIFYING',
      'integration verification result',
      'FAIL',
      failed,
    );
    return blocked({
      integrationBranch,
      integrationHead: preconditions.integrationHead,
      integratedDiffDigest,
      artifactPaths,
      code: ErrorCategory.VERIFICATION_FAILED,
      message: `Integrated verification failed: ${failed}`,
    });
  }

  await appendLog(
    artifactStore,
    runId,
    iteration,
    'VERIFYING',
    'integration verification result',
    'PASS',
  );

  diffResult = await collectDiff({
    projectRoot,
    baseCommit,
    iteration,
  });
  integratedDiffDigest = `sha256:${diffResult.diffDigest}` as Digest;
  await writeIntegratedDiffEvidence({
    runId,
    baseCommit,
    integrationBranch,
    integrationHead: preconditions.integrationHead,
    integratedDiffDigest,
    diffResult,
    paths,
  });
  registerDirectoryFiles(paths.dir, orchestratorRegistry);

  const postVerificationScopeResult = checkScope({
    allowedChanges: goalFrontMatter.allowed_changes,
    disallowedChanges: goalFrontMatter.disallowed_changes,
    changedFiles: diffResult.changedFiles,
    orchestratorOwnedFiles: orchestratorRegistry.getRelativePaths(projectRoot),
  });
  await fs.outputJson(paths.scopeReport, postVerificationScopeResult.report, { spaces: 2 });
  registerDirectoryFiles(paths.dir, orchestratorRegistry);

  if (!postVerificationScopeResult.passed) {
    const deniedPaths = postVerificationScopeResult.report.denied.map((denial) => `${denial.path} (${denial.reason})`).join(', ');
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'VERIFYING',
      'post-verification integration scope',
      'FAIL',
      deniedPaths,
    );
    return blocked({
      integrationBranch,
      integrationHead: preconditions.integrationHead,
      integratedDiffDigest,
      artifactPaths,
      code: ErrorCategory.SCOPE_VIOLATION,
      message: `Post-verification integrated scope violation: ${deniedPaths}`,
    });
  }

  await stateStore.update(() => ({ audited_diff_digest: integratedDiffDigest }));
  await stateStore.transition(PhaseEnum.AUDITING);
  await appendLog(
    artifactStore,
    runId,
    iteration,
    'AUDITING',
    'integrated evidence ready',
    'PASS',
    integratedDiffDigest,
  );
  await stateStore.transition(PhaseEnum.FINALIZING);

  const finalAuditContext = buildFinalAuditContext({
    runId,
    baseCommit,
    integrationBranch,
    integrationHead: preconditions.integrationHead,
    integratedDiffDigest,
    changedFiles: diffResult.changedFiles.files.map((file) => file.path),
    plan: preconditions.plan,
    paths,
  });
  await fs.outputJson(paths.finalAuditContext, finalAuditContext, { spaces: 2 });
  artifactPaths.push(paths.finalAuditContext);
  registerDirectoryFiles(paths.dir, orchestratorRegistry);

  const finalAuditResult = await runIntegratedFinalAudit({
    projectRoot,
    agentDir,
    runId,
    goalDigest,
    integratedDiffDigest,
    iteration,
    config,
    combinedSignal,
    orchestratorRegistry,
    contextPath: paths.finalAuditContext,
    paths,
    baseCommit,
    integrationBranch,
    integrationHead: preconditions.integrationHead,
    changedFiles: diffResult.changedFiles.files.map((file) => file.path),
  });
  artifactPaths.push(...finalAuditResult.artifact_paths);

  if (finalAuditResult.status === 'blocked') {
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'FINALIZING',
      'integrated final audit',
      'FAIL',
      finalAuditResult.error_message ?? 'Final Aggregate Audit failed',
    );
    return blocked({
      integrationBranch,
      integrationHead: preconditions.integrationHead,
      integratedDiffDigest,
      auditDecision: finalAuditResult.audit_decision,
      artifactPaths,
      code: finalAuditResult.error_code ?? ErrorCategory.FINAL_AUDIT_FAILED,
      message: finalAuditResult.error_message ?? 'Final Aggregate Audit failed',
    });
  }

  await stateStore.update(() => ({
    branch: integrationBranch,
    commit_skipped: true,
    skip_reason: SKIP_REASON,
    tag_name: null,
    tag_created: false,
    finalized_at: new Date().toISOString(),
  }));
  await appendLog(
    artifactStore,
    runId,
    iteration,
    'FINALIZING',
    'integrated final audit',
    'PASS',
    integratedDiffDigest,
  );
  await emitProgress({
    projectRoot,
    stateStore,
    lastEvent: `Phase 8E R2 integrated audit PASSED on ${integrationBranch}`,
    registry: orchestratorRegistry,
    finalAuditDecision: 'PASS',
  });

  return {
    status: 'passed',
    integration_branch: integrationBranch,
    integration_head: preconditions.integrationHead,
    integrated_diff_digest: integratedDiffDigest,
    audit_decision: 'PASS',
    artifact_paths: uniquePaths(artifactPaths),
    error_code: null,
    error_message: null,
  };
}

export function integrationAuditSkipReason(): string {
  return SKIP_REASON;
}

async function ensureVerifyingPhase(
  stateStore: StateStore,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const state = await stateStore.read();
  if (state.phase === PhaseEnum.VERIFYING) return { ok: true };
  if (state.phase === PhaseEnum.DEVELOPING) {
    await stateStore.transition(PhaseEnum.VERIFYING);
    return { ok: true };
  }
  return {
    ok: false,
    message: `Integration audit expected DEVELOPING or VERIFYING phase, got ${state.phase}`,
  };
}

async function validateIntegrationPreconditions(params: {
  projectRoot: string;
  runId: string;
  baseCommit: string;
  integrationBranch: string;
}): Promise<
  | { ok: true; integrationHead: string; plan: IntegrationPlan; artifactPaths: string[] }
  | { ok: false; integrationHead: string | null; code: ErrorCategoryType; message: string; artifactPaths: string[] }
> {
  const { projectRoot, runId, baseCommit, integrationBranch } = params;
  const paths = integrationAuditPaths(projectRoot);
  const artifactPaths = [paths.plan].filter((filePath) => existsSync(filePath));

  if (integrationBranch !== `integration/${runId}`) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Expected integration branch integration/${runId}, got ${integrationBranch}`,
      artifactPaths,
    };
  }

  if (!existsSync(paths.plan)) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: 'Integration plan evidence is missing at .agent/integration/integration-plan.json',
      artifactPaths,
    };
  }

  let plan: IntegrationPlan;
  try {
    plan = await fs.readJson(paths.plan) as IntegrationPlan;
  } catch (err) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Integration plan evidence is invalid: ${err instanceof Error ? err.message : String(err)}`,
      artifactPaths,
    };
  }

  const planMismatch = [
    plan.run_id === runId ? null : `run_id ${plan.run_id} != ${runId}`,
    plan.base_commit === baseCommit ? null : `base_commit ${plan.base_commit} != ${baseCommit}`,
    plan.integration_branch === integrationBranch ? null : `integration_branch ${plan.integration_branch} != ${integrationBranch}`,
  ].filter((value): value is string => value !== null);
  if (planMismatch.length > 0) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Integration plan evidence mismatch: ${planMismatch.join('; ')}`,
      artifactPaths,
    };
  }

  if (plan.excluded_tasks.length > 0) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.VERIFICATION_FAILED,
      message: 'Integration plan contains excluded tasks; R2 will not audit a partial R1 integration.',
      artifactPaths,
    };
  }

  const branchExists = await runGit(['rev-parse', '--verify', `refs/heads/${integrationBranch}`], projectRoot);
  if (branchExists.exit_code !== 0) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Integration branch ${integrationBranch} does not exist`,
      artifactPaths,
    };
  }

  const currentBranch = await runGit(['branch', '--show-current'], projectRoot);
  if (currentBranch.exit_code !== 0) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Cannot determine current branch: ${currentBranch.stderr || currentBranch.stdout}`,
      artifactPaths,
    };
  }

  if (currentBranch.stdout.trim() !== integrationBranch) {
    const status = await runGit(['status', '--porcelain=v1', '--untracked-files=no'], projectRoot);
    if (status.exit_code !== 0 || status.stdout.trim().length > 0) {
      return {
        ok: false,
        integrationHead: null,
        code: ErrorCategory.STATE_CONFLICT,
        message: `Cannot safely switch to ${integrationBranch}; tracked working tree changes are present`,
        artifactPaths,
      };
    }
    const switched = await runGit(['switch', integrationBranch], projectRoot);
    if (switched.exit_code !== 0) {
      return {
        ok: false,
        integrationHead: null,
        code: ErrorCategory.STATE_CONFLICT,
        message: `Failed to switch to ${integrationBranch}: ${switched.stderr || switched.stdout}`,
        artifactPaths,
      };
    }
  }

  const ancestor = await runGit(['merge-base', '--is-ancestor', baseCommit, integrationBranch], projectRoot);
  if (ancestor.exit_code !== 0) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Integration branch ${integrationBranch} is not a descendant of base commit ${baseCommit}`,
      artifactPaths,
    };
  }

  const head = await runGit(['rev-parse', '--verify', 'HEAD'], projectRoot);
  if (head.exit_code !== 0) {
    return {
      ok: false,
      integrationHead: null,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Cannot resolve integration HEAD: ${head.stderr || head.stdout}`,
      artifactPaths,
    };
  }

  return {
    ok: true,
    integrationHead: head.stdout.trim(),
    plan,
    artifactPaths,
  };
}

async function runIntegratedFinalAudit(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  goalDigest: string;
  integratedDiffDigest: string;
  iteration: number;
  config: ReviewLoopConfig;
  combinedSignal: AbortSignal;
  orchestratorRegistry: OrchestratorFileRegistry;
  contextPath: string;
  paths: ReturnType<typeof integrationAuditPaths>;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  changedFiles: string[];
}): Promise<IntegrationAuditResult> {
  const {
    projectRoot,
    agentDir,
    runId,
    goalDigest,
    integratedDiffDigest,
    iteration,
    config,
    combinedSignal,
    orchestratorRegistry,
    contextPath,
    paths,
  } = params;

  const artifactPaths: string[] = [];
  const contextDigest = computeDigest(readFileSync(contextPath, 'utf8'));
  const verificationManifestDigest = computeDigest(readFileSync(paths.verificationManifest, 'utf8'));
  const currentGoalDigest = computeDigest(readFileSync(path.join(agentDir, 'GOAL.md'), 'utf8'));
  const preFinalAuditBusinessDigests = await snapshotBusinessDigests(projectRoot, params.changedFiles);
  const feedbackNotes = await readFeedbackNotesForAudit(projectRoot);

  let finalAuditorPrompt: string;
  let finalAuditorPromptFile: string | undefined;
  try {
    const promptResult = await buildPrompt(
      projectRoot,
      'final-auditor.md',
      (template) => {
        const rendered = buildFinalAuditorPrompt(template, {
          run_id: runId,
          iteration,
          project_root: projectRoot,
          plan_path: path.join(projectRoot, '.agent/plan.md'),
          goal_path: path.join(projectRoot, '.agent/GOAL.md'),
          handoff_path: path.join(projectRoot, '.agent/developer-handoff.md'),
          audit_report_path: contextPath,
          verification_manifest_path: paths.verificationManifest,
          changed_files_path: paths.changedFiles,
          untracked_files_path: paths.untrackedFiles,
          scope_report_path: paths.scopeReport,
          diff_metadata_path: paths.integratedDiffMetadata,
          final_audit_path: path.join(projectRoot, '.agent/final-audit.md'),
          goal_digest: currentGoalDigest,
          diff_digest: integratedDiffDigest,
          audit_report_digest: contextDigest,
          verification_manifest_digest: verificationManifestDigest,
          feedback_notes: feedbackNotes,
          feedback_notes_path: '.agent/feedback-notes.md',
        });
        return `${rendered}

## Phase 8E Integrated Audit Context

This is a Final Aggregate Audit for the integrated branch \`${params.integrationBranch}\` at \`${params.integrationHead}\`, based on \`${params.baseCommit}\`.

- Integrated diff digest: \`${integratedDiffDigest}\`
- Integrated final audit context: \`${contextPath}\`
- Per-task \`diff_digest\` values are not reused as integrated evidence.
- Audit the integrated diff described by the integration evidence files, not isolated task diffs.
`;
      },
      { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'final-auditor' },
    );
    finalAuditorPrompt = promptResult.prompt;
    finalAuditorPromptFile = promptResult.prompt_file_path ?? undefined;
  } catch (err) {
    return blocked({
      integrationBranch: params.integrationBranch,
      integrationHead: params.integrationHead,
      integratedDiffDigest,
      artifactPaths,
      code: ErrorCategory.CONFIG_ERROR,
      message: `Final Auditor prompt build failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  let finalAuditorResult;
  let finalAuditorCleanupResult: PromptCleanupResult | undefined;
  try {
    const finalAuditorInput = buildFinalAuditorInput({
      run_id: runId,
      iteration,
      project_root: projectRoot,
      command_template: resolveCommandForAgent(config.agents.final_auditor.command, config.agents.final_auditor.provider, config),
      timeout_seconds: config.agents.final_auditor.timeout_seconds,
      prompt: finalAuditorPrompt,
      prompt_file: finalAuditorPromptFile,
      signal: combinedSignal,
    });

    finalAuditorResult = await runAgent(finalAuditorInput, projectRoot);
  } finally {
    if (finalAuditorPromptFile) finalAuditorCleanupResult = await deletePromptFile(finalAuditorPromptFile);
  }

  if (finalAuditorResult) {
    registerAgentLogs(finalAuditorResult, orchestratorRegistry);
    artifactPaths.push(...finalAuditorResult.artifact_paths);
  }

  if (finalAuditorCleanupResult && !finalAuditorCleanupResult.success) {
    return blocked({
      integrationBranch: params.integrationBranch,
      integrationHead: params.integrationHead,
      integratedDiffDigest,
      artifactPaths,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Final Auditor prompt cleanup failed: ${finalAuditorCleanupResult.error}`,
    });
  }

  if (!finalAuditorResult || finalAuditorResult.status !== 'success') {
    return blocked({
      integrationBranch: params.integrationBranch,
      integrationHead: params.integrationHead,
      integratedDiffDigest,
      artifactPaths,
      code: ErrorCategory.AGENT_ERROR,
      message: `Final Auditor failed: ${finalAuditorResult?.error?.message ?? 'unknown'}`,
    });
  }

  const finalAuditPath = path.join(projectRoot, '.agent/final-audit.md');
  if (existsSync(finalAuditPath)) {
    artifactPaths.push(finalAuditPath);
    orchestratorRegistry.register(finalAuditPath, computeDigest(readFileSync(finalAuditPath, 'utf8')));
  }

  const finalAuditValidation = validateFinalAuditorOutput({
    projectRoot,
    runId,
    iteration,
    expectedGoalDigest: currentGoalDigest || goalDigest,
    expectedDiffDigest: integratedDiffDigest,
    expectedAuditReportDigest: contextDigest,
    expectedVerificationManifestDigest: verificationManifestDigest,
  });

  if (!finalAuditValidation.valid) {
    const errorCode = finalAuditValidation.decision === 'PASS'
      ? ErrorCategory.FINAL_AUDIT_SCHEMA_ERROR
      : ErrorCategory.FINAL_AUDIT_FAILED;
    return blocked({
      integrationBranch: params.integrationBranch,
      integrationHead: params.integrationHead,
      integratedDiffDigest,
      auditDecision: finalAuditValidation.decision,
      artifactPaths,
      code: errorCode,
      message: `Final Audit validation failed: ${finalAuditValidation.errors.join('; ')}`,
    });
  }

  const decision = finalAuditValidation.effectiveDecision ?? finalAuditValidation.decision;
  if (decision !== 'PASS') {
    return blocked({
      integrationBranch: params.integrationBranch,
      integrationHead: params.integrationHead,
      integratedDiffDigest,
      auditDecision: finalAuditValidation.decision,
      artifactPaths,
      code: ErrorCategory.FINAL_AUDIT_FAILED,
      message: `Final Audit decision: ${decision}. R2 will not create final commit or tag.`,
    });
  }

  const businessViolations = await findFinalAuditBusinessViolations({
    projectRoot,
    baseCommit: params.baseCommit,
    iteration,
    preFinalAuditBusinessDigests,
  });
  if (businessViolations.length > 0) {
    return blocked({
      integrationBranch: params.integrationBranch,
      integrationHead: params.integrationHead,
      integratedDiffDigest,
      auditDecision: finalAuditValidation.decision,
      artifactPaths,
      code: ErrorCategory.SCOPE_VIOLATION,
      message: `Final Auditor modified business files: ${businessViolations.join(', ')}`,
    });
  }

  await dispatchFeedbackBlocks({
    projectRoot,
    runId,
    role: 'final_auditor',
    artifactPath: finalAuditPath,
    config: config.feedback_protocol,
    registry: orchestratorRegistry,
  }).catch(() => {});

  return {
    status: 'passed',
    integration_branch: params.integrationBranch,
    integration_head: params.integrationHead,
    integrated_diff_digest: integratedDiffDigest,
    audit_decision: 'PASS',
    artifact_paths: uniquePaths(artifactPaths),
    error_code: null,
    error_message: null,
  };
}

function integrationAuditPaths(projectRoot: string) {
  const base = integrationArtifactPaths(projectRoot);
  return {
    ...base,
    trackedDiff: path.join(base.dir, 'tracked.diff'),
    changedFiles: path.join(base.dir, 'changed-files.json'),
    untrackedFiles: path.join(base.dir, 'untracked-files.json'),
    diffMetadata: path.join(base.dir, 'diff-metadata.json'),
    integratedDiffMetadata: path.join(base.dir, 'integrated-diff-metadata.json'),
    scopeReport: path.join(base.dir, 'scope-report.json'),
    verificationManifest: path.join(base.dir, 'verification-manifest.json'),
    finalAuditContext: path.join(base.dir, 'final-audit-context.json'),
  };
}

function buildIntegratedDiffMetadata(params: {
  runId: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  integratedDiffDigest: string;
  changedFiles: string[];
  paths: ReturnType<typeof integrationAuditPaths>;
}): IntegratedDiffMetadata {
  return {
    schema_version: 1,
    run_id: params.runId,
    base_commit: params.baseCommit,
    integration_branch: params.integrationBranch,
    integration_head: params.integrationHead,
    integrated_diff_digest: params.integratedDiffDigest,
    changed_files: params.changedFiles,
    created_at: new Date().toISOString(),
    artifact_paths: {
      tracked_diff: params.paths.trackedDiff,
      changed_files: params.paths.changedFiles,
      untracked_files: params.paths.untrackedFiles,
      diff_metadata: params.paths.diffMetadata,
    },
  };
}

async function writeIntegratedDiffEvidence(params: {
  runId: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  integratedDiffDigest: string;
  diffResult: Awaited<ReturnType<typeof collectDiff>>;
  paths: ReturnType<typeof integrationAuditPaths>;
}): Promise<void> {
  const integratedMetadata = buildIntegratedDiffMetadata({
    runId: params.runId,
    baseCommit: params.baseCommit,
    integrationBranch: params.integrationBranch,
    integrationHead: params.integrationHead,
    integratedDiffDigest: params.integratedDiffDigest,
    changedFiles: params.diffResult.changedFiles.files.map((file) => file.path),
    paths: params.paths,
  });

  await fs.writeFile(params.paths.trackedDiff, params.diffResult.trackedDiff);
  await fs.outputJson(params.paths.changedFiles, params.diffResult.changedFiles, { spaces: 2 });
  await fs.outputJson(params.paths.untrackedFiles, params.diffResult.untrackedFiles, { spaces: 2 });
  await fs.outputJson(params.paths.diffMetadata, params.diffResult.diffMetadata, { spaces: 2 });
  await fs.outputJson(params.paths.integratedDiffMetadata, integratedMetadata, { spaces: 2 });
}

function buildFinalAuditContext(params: {
  runId: string;
  baseCommit: string;
  integrationBranch: string;
  integrationHead: string;
  integratedDiffDigest: string;
  changedFiles: string[];
  plan: IntegrationPlan;
  paths: ReturnType<typeof integrationAuditPaths>;
}): FinalAuditContext {
  return {
    schema_version: 1,
    run_id: params.runId,
    base_commit: params.baseCommit,
    integration_branch: params.integrationBranch,
    integration_head: params.integrationHead,
    integrated_diff_digest: params.integratedDiffDigest,
    changed_files: params.changedFiles,
    task_provenance: params.plan.tasks.map((task) => ({
      task_id: task.task_id,
      branch: task.branch,
      commit_sha: task.commit_sha,
    })),
    per_task_diff_digest_reused: false,
    per_task_diff_digest_policy:
      'Per-task diff_digest values are intentionally not read, copied, or reused. The integrated_diff_digest is recomputed from base_commit to the integration branch.',
    evidence_paths: {
      changed_files: params.paths.changedFiles,
      untracked_files: params.paths.untrackedFiles,
      tracked_diff: params.paths.trackedDiff,
      integrated_diff_metadata: params.paths.integratedDiffMetadata,
      scope_report: params.paths.scopeReport,
      verification_manifest: params.paths.verificationManifest,
    },
    created_at: new Date().toISOString(),
  };
}

async function snapshotBusinessDigests(
  projectRoot: string,
  changedFiles: string[],
): Promise<Map<string, Digest>> {
  const digests = new Map<string, Digest>();
  for (const filePath of changedFiles) {
    if (filePath.startsWith('.agent/')) continue;
    const fullPath = path.join(projectRoot, filePath);
    if (existsSync(fullPath)) {
      digests.set(filePath, await computeFileDigest(fullPath));
    }
  }
  return digests;
}

async function findFinalAuditBusinessViolations(params: {
  projectRoot: string;
  baseCommit: string;
  iteration: number;
  preFinalAuditBusinessDigests: Map<string, Digest>;
}): Promise<string[]> {
  const violations: string[] = [];
  for (const [filePath, preDigest] of params.preFinalAuditBusinessDigests) {
    const fullPath = path.join(params.projectRoot, filePath);
    if (!existsSync(fullPath)) {
      violations.push(`${filePath} (deleted by final auditor)`);
      continue;
    }
    const currentDigest = await computeFileDigest(fullPath);
    if (currentDigest !== preDigest) {
      violations.push(`${filePath} (content modified)`);
    }
  }

  const postDiff = await collectDiff({
    projectRoot: params.projectRoot,
    baseCommit: params.baseCommit,
    iteration: params.iteration,
  });
  const postFiles = [
    ...postDiff.changedFiles.files.map((file) => file.path),
    ...postDiff.untrackedFiles.files.map((file) => file.path),
  ];
  for (const filePath of postFiles) {
    if (filePath.startsWith('.agent/')) continue;
    if (!params.preFinalAuditBusinessDigests.has(filePath)) {
      violations.push(`${filePath} (new)`);
    }
  }
  return violations;
}

function blocked(params: {
  integrationBranch: string;
  integrationHead?: string | null;
  integratedDiffDigest?: string | null;
  auditDecision?: FinalAuditDecision | null;
  artifactPaths: string[];
  code: ErrorCategoryType;
  message: string;
}): IntegrationAuditResult {
  return {
    status: 'blocked',
    integration_branch: params.integrationBranch,
    integration_head: params.integrationHead ?? null,
    integrated_diff_digest: params.integratedDiffDigest ?? null,
    audit_decision: params.auditDecision ?? null,
    artifact_paths: uniquePaths(params.artifactPaths),
    error_code: params.code,
    error_message: params.message,
  };
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
