/**
 * Phase 8E R3 Integration Finalization — Commit And Tag.
 *
 * After Phase 8E R2 Final Aggregate Audit PASS, R3 turns the audited integration
 * branch into the project-level final commit on `integration/{run_id}`, optionally
 * creates a local tag, and records finalization state.
 *
 * Critical invariants:
 * - R3 NEVER reruns the Final Aggregate Audit. It only validates R2 evidence.
 * - R3 does NOT move the original branch; it finalizes on `integration/{run_id}`.
 * - R3 stages with precise pathspecs only (never `git add -A` / `git add .`).
 * - R3 force-adds ignored `.agent` artifacts only through the R3 allowlist.
 * - R3 never stages or commits `.agent/task-runs/**`.
 * - R3 does not push.
 */
import fs from 'fs-extra';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { collectDiff } from '../git/diff-collector.js';
import { runGit, runGitRaw } from '../git/git-manager.js';
import {
  buildAllowedCommitSet,
  commitExists,
  createCommit,
  createTag,
  findStagedSetViolations,
  findTrackedLocalOnlyArtifacts,
  getStagedFiles,
  getTagTarget,
  INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  isIntegrationVersionedArtifact,
  renderCommitMessage,
  renderTagName,
  stageFilesControlled,
  verifyCommitTree,
  type StageEntry,
} from '../git/commit-manager.js';
import { parseFinalAudit } from '../artifacts/artifact-schemas.js';
import type { Digest } from '../runtime/digest.js';
import {
  appendLog,
  emitProgress,
  type OrchestratorFileRegistry,
} from './run-orchestrator.js';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { StateStore } from './state-store.js';
import {
  ErrorCategory,
  Phase as PhaseEnum,
  type ChangedFile,
  type ChangedFilesSchema,
  type ErrorCategory as ErrorCategoryType,
  type ReviewLoopConfig,
  type UntrackedFileEvidence,
  type UntrackedFilesSchema,
} from '../types.js';

export interface IntegrationFinalizationResult {
  status: 'passed' | 'blocked';
  integration_branch: string;
  final_commit_sha: string | null;
  final_commit_message: string | null;
  tag_name: string | null;
  tag_created: boolean;
  commit_skipped: boolean;
  skip_reason: string | null;
  artifact_paths: string[];
  error_code: ErrorCategoryType | null;
  error_message: string | null;
}

export interface IntegrationFinalizationParams {
  projectRoot: string;
  agentDir: string;
  runId: string;
  baseCommit: string;
  goalDigest: string;
  integrationBranch: string;
  iteration: number;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  tag: boolean;
  noCommit: boolean;
}

/** R2 evidence shape written by `runIntegrationAudit()`. */
interface IntegratedDiffMetadata {
  schema_version: 1;
  run_id: string;
  base_commit: string;
  integration_branch: string;
  integration_head: string;
  integrated_diff_digest: string;
  changed_files: string[];
  created_at: string;
}

interface FinalAuditContext {
  schema_version: 1;
  run_id: string;
  base_commit: string;
  integration_branch: string;
  integration_head: string;
  integrated_diff_digest: string;
  changed_files: string[];
}

interface IntegrationPlanEvidence {
  schema_version: 1;
  run_id: string;
  base_commit: string;
  integration_branch: string;
}

/** Required R3 artifacts that must be present in a valid final commit (resume check). */
const REQUIRED_FINAL_COMMIT_ARTIFACTS = [...INTEGRATION_VERSIONED_ARTIFACT_PATHS];

const SKIP_REASON_NO_COMMIT = 'Phase 8E R3 final commit skipped (--no-commit or commit_on_pass is false)';

/**
 * Run Phase 8E R3 finalization: validate R2 evidence, recompute and compare the
 * business diff, stage the controlled final file set, create the final commit on
 * `integration/{run_id}`, optionally create a local tag, and update state.
 */
export async function runIntegrationFinalization(
  params: IntegrationFinalizationParams,
): Promise<IntegrationFinalizationResult> {
  const {
    projectRoot,
    agentDir,
    runId,
    baseCommit,
    goalDigest,
    integrationBranch,
    iteration,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    config,
    tag,
    noCommit,
  } = params;

  if (config.git.push) {
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.UNSUPPORTED_PUSH,
      message: 'git.push is not supported in Phase 8E R3 finalization.',
    });
  }

  if (integrationBranch !== `integration/${runId}`) {
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Expected integration branch integration/${runId}, got ${integrationBranch}`,
    });
  }

  // Switch safely to the integration branch (R2 normally leaves us here, but a
  // resume may start elsewhere). Never move the original branch.
  const switched = await ensureOnIntegrationBranch(projectRoot, integrationBranch);
  if (!switched.ok) {
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.STATE_CONFLICT,
      message: switched.message,
    });
  }

  // Load and validate R2 evidence. R3 never reruns Final Aggregate Audit.
  const evidence = await loadAndValidateR2Evidence({
    projectRoot,
    agentDir,
    runId,
    baseCommit,
    integrationBranch,
    stateStore,
  });
  if (!evidence.ok) {
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: evidence.code,
      message: evidence.message,
    });
  }

  const artifactPaths = uniquePaths([
    ...REQUIRED_FINAL_COMMIT_ARTIFACTS,
    ...buildExistingAllowlistArtifacts(projectRoot),
  ]);

  // Resume: if state already records a final commit, verify it and only run tag
  // handling if needed (idempotent — no duplicate commit).
  let state = await stateStore.read();
  if (state.phase === PhaseEnum.BLOCKED && state.final_commit_sha && !state.tag_created) {
    state = await stateStore.forceTransitionForResume(PhaseEnum.FINALIZING);
  }
  if (state.final_commit_sha) {
    const resume = await tryResumeFromExistingCommit({
      projectRoot,
      runId,
      baseCommit,
      integrationBranch,
      stateStore,
      artifactStore,
      orchestratorRegistry,
      config,
      tag,
      iteration,
      finalCommitSha: state.final_commit_sha,
      evidence: evidence.value,
      artifactPaths,
    });
    if (resume.outcome === 'passed' || resume.outcome === 'blocked') {
      return resume.result;
    }
    // outcome === 'stale': clear final commit state and run fresh finalization.
    await stateStore.update(() => ({
      final_commit_sha: null,
      final_commit_message: null,
      tag_name: null,
      tag_created: false,
    }));
  }

  const liveHead = await verifyLiveIntegrationHead({
    projectRoot,
    integrationBranch,
    expectedHead: evidence.value.integrationHead,
  });
  if (!liveHead.ok) {
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.STATE_CONFLICT,
      message: liveHead.message,
      artifactPaths,
    });
  }

  // Recompute the business diff from base_commit and compare against R2 evidence.
  const diffCheck = await verifyBusinessDiff({
    projectRoot,
    baseCommit,
    evidence: evidence.value,
  });
  if (!diffCheck.ok) {
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'FINALIZING',
      'integration business diff verification',
      'FAIL',
      diffCheck.message,
    );
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.STATE_CONFLICT,
      message: diffCheck.message,
      artifactPaths,
    });
  }

  // Build the final commit file set: business files + existing R3 versioned artifacts.
  const businessFiles = diffCheck.businessFiles;
  const existingArtifacts = buildExistingAllowlistArtifacts(projectRoot);
  const missingRequiredArtifacts = INTEGRATION_VERSIONED_ARTIFACT_PATHS
    .filter((filePath) => !existsSync(path.join(projectRoot, filePath)));
  if (missingRequiredArtifacts.length > 0) {
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.STATE_CONFLICT,
      message: `Required R3 artifact(s) missing: ${missingRequiredArtifacts.join(', ')}`,
      artifactPaths,
    });
  }

  // --no-commit / commit_on_pass=false: preserve skip behavior only after all
  // R2 evidence and business-diff checks pass. The normal R3 path creates a commit.
  if (noCommit || !config.git.commit_on_pass) {
    await stateStore.update(() => ({
      branch: integrationBranch,
      commit_skipped: true,
      skip_reason: SKIP_REASON_NO_COMMIT,
      tag_name: null,
      tag_created: false,
      finalized_at: new Date().toISOString(),
    }));
    await stateStore.transition(PhaseEnum.PASSED);
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'FINALIZING',
      'integration finalization (commit skipped)',
      'PASS',
      SKIP_REASON_NO_COMMIT,
    );
    await emitProgress({
      projectRoot,
      stateStore,
      lastEvent: `Phase 8E R3 finalization PASSED (commit skipped) on ${integrationBranch}`,
      registry: orchestratorRegistry,
      finalAuditDecision: 'PASS',
    });
    return {
      status: 'passed',
      integration_branch: integrationBranch,
      final_commit_sha: null,
      final_commit_message: null,
      tag_name: null,
      tag_created: false,
      commit_skipped: true,
      skip_reason: SKIP_REASON_NO_COMMIT,
      artifact_paths: artifactPaths,
      error_code: null,
      error_message: null,
    };
  }

  const allowedSet = buildAllowedCommitSet(existingArtifacts, businessFiles);

  // Reject if any local-only runtime artifact is tracked by git.
  const trackedLocalOnly = await findTrackedLocalOnlyArtifacts(projectRoot);
  if (trackedLocalOnly.length > 0) {
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.PRE_COMMIT_STAGED_SET_VIOLATION,
      message: `Local-only artifacts are tracked by git: ${trackedLocalOnly.join(', ')}. Remove them before finalizing.`,
      artifactPaths,
    });
  }

  // Stage with precise pathspecs + controlled force-add.
  const stageableBusinessFiles = businessFiles
    .filter((filePath) => existsSync(path.join(projectRoot, filePath)));
  const stageEntries: StageEntry[] = [
    ...stageableBusinessFiles.map((filePath) => ({ path: filePath, force: false })),
    ...existingArtifacts.map((filePath) => ({ path: filePath, force: true })),
  ];
  const stageResult = await stageFilesControlled(projectRoot, stageEntries);
  if (!stageResult.success) {
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.GIT_COMMIT_ERROR,
      message: `Staging failed: ${stageResult.error}`,
      artifactPaths,
    });
  }

  // Verify the staged set is a subset of the allowed set.
  const stagedFiles = await getStagedFiles(projectRoot);
  const violations = findStagedSetViolations(stagedFiles, allowedSet);
  if (violations.length > 0) {
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.PRE_COMMIT_STAGED_SET_VIOLATION,
      message: `Staged set contains disallowed files: ${violations.join(', ')}`,
      artifactPaths,
    });
  }

  // Render the configured commit message template.
  let commitMessage: string;
  try {
    const shortGoalDigest = goalDigest.replace('sha256:', '').slice(0, 12);
    const taskSlug = (await stateStore.read()).task_slug;
    commitMessage = renderCommitMessage(config.git.commit_template, {
      task_slug: taskSlug,
      run_id: runId,
      iteration,
      short_goal_digest: shortGoalDigest,
    });
  } catch (err) {
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.GIT_COMMIT_ERROR,
      message: `Commit message template error: ${err instanceof Error ? err.message : String(err)}`,
      artifactPaths,
    });
  }

  // Create the final commit on integration/{run_id}.
  const commitResult = await createCommit(projectRoot, commitMessage);
  if (!commitResult.success) {
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.GIT_COMMIT_ERROR,
      message: `Commit failed: ${commitResult.error}`,
      artifactPaths,
    });
  }

  const commitSha = commitResult.commitSha!;

  // Record the final commit in state before tag handling so a tag failure
  // preserves final_commit_sha for resume.
  await stateStore.update(() => ({
    branch: integrationBranch,
    final_commit_sha: commitSha,
    final_commit_message: commitMessage,
    commit_skipped: false,
    skip_reason: null,
  }));
  await appendLog(
    artifactStore,
    runId,
    iteration,
    'FINALIZING',
    'integration final commit created',
    'PASS',
    commitSha,
  );

  // Optional local tag (mirrors existing finalization tag behavior).
  const tagResult = await handleTag({
    projectRoot,
    stateStore,
    config,
    tag,
    runId,
    commitSha,
  });
  if (tagResult.outcome === 'blocked') {
    await appendLog(
      artifactStore,
      runId,
      iteration,
      'FINALIZING',
      'integration final tag',
      'FAIL',
      tagResult.error_message ?? 'tag failed',
    );
    return blockFinalization({
      stateStore,
      integrationBranch,
      code: ErrorCategory.GIT_TAG_ERROR,
      message: tagResult.error_message ?? 'tag failed',
      artifactPaths,
      finalCommitSha: commitSha,
      finalCommitMessage: commitMessage,
      tagName: tagResult.tagName,
    });
  }

  await stateStore.update(() => ({
    finalized_at: new Date().toISOString(),
    tag_name: tagResult.tagName,
    tag_created: tagResult.tagCreated,
  }));
  await stateStore.transition(PhaseEnum.PASSED);
  await emitProgress({
    projectRoot,
    stateStore,
    lastEvent: `Phase 8E R3 finalization PASSED: ${integrationBranch} @ ${commitSha.slice(0, 8)}`,
    registry: orchestratorRegistry,
    commitSha,
    finalAuditDecision: 'PASS',
  });
  await appendLog(
    artifactStore,
    runId,
    iteration,
    'FINALIZING',
    'integration finalization completed',
    'PASS',
    tagResult.tagCreated && tagResult.tagName ? `${commitSha} tag=${tagResult.tagName}` : commitSha,
  );

  return {
    status: 'passed',
    integration_branch: integrationBranch,
    final_commit_sha: commitSha,
    final_commit_message: commitMessage,
    tag_name: tagResult.tagName,
    tag_created: tagResult.tagCreated,
    commit_skipped: false,
    skip_reason: null,
    artifact_paths: artifactPaths,
    error_code: null,
    error_message: null,
  };
}

// ─── Evidence validation ──────────────────────────────────────

async function loadAndValidateR2Evidence(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  baseCommit: string;
  integrationBranch: string;
  stateStore: StateStore;
}): Promise<
  | { ok: true; value: R2Evidence }
  | { ok: false; code: ErrorCategoryType; message: string }
> {
  const { projectRoot, agentDir, runId, baseCommit, integrationBranch, stateStore } = params;
  const integrationDir = path.join(projectRoot, '.agent', 'integration');

  const planPath = path.join(integrationDir, 'integration-plan.json');
  const trackedDiffPath = path.join(integrationDir, 'tracked.diff');
  const changedFilesPath = path.join(integrationDir, 'changed-files.json');
  const untrackedFilesPath = path.join(integrationDir, 'untracked-files.json');
  const integratedMetadataPath = path.join(integrationDir, 'integrated-diff-metadata.json');
  const finalAuditContextPath = path.join(integrationDir, 'final-audit-context.json');
  const finalAuditMdPath = path.join(agentDir, 'final-audit.md');

  const missing: string[] = [];
  if (!existsSync(planPath)) missing.push('.agent/integration/integration-plan.json');
  if (!existsSync(trackedDiffPath)) missing.push('.agent/integration/tracked.diff');
  if (!existsSync(changedFilesPath)) missing.push('.agent/integration/changed-files.json');
  if (!existsSync(untrackedFilesPath)) missing.push('.agent/integration/untracked-files.json');
  if (!existsSync(integratedMetadataPath)) missing.push('.agent/integration/integrated-diff-metadata.json');
  if (!existsSync(finalAuditContextPath)) missing.push('.agent/integration/final-audit-context.json');
  if (!existsSync(finalAuditMdPath)) missing.push('.agent/final-audit.md');
  if (missing.length > 0) {
    return {
      ok: false,
      code: ErrorCategory.STATE_CONFLICT,
      message: `R2 evidence missing: ${missing.join(', ')}`,
    };
  }

  let plan: IntegrationPlanEvidence;
  let metadata: IntegratedDiffMetadata;
  let context: FinalAuditContext;
  let changedFilesEvidence: ChangedFilesSchema;
  let untrackedFilesEvidence: UntrackedFilesSchema;
  try {
    plan = await fs.readJson(planPath) as IntegrationPlanEvidence;
    changedFilesEvidence = await fs.readJson(changedFilesPath) as ChangedFilesSchema;
    untrackedFilesEvidence = await fs.readJson(untrackedFilesPath) as UntrackedFilesSchema;
    metadata = await fs.readJson(integratedMetadataPath) as IntegratedDiffMetadata;
    context = await fs.readJson(finalAuditContextPath) as FinalAuditContext;
  } catch (err) {
    return {
      ok: false,
      code: ErrorCategory.STATE_CONFLICT,
      message: `R2 evidence is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const mismatches: string[] = [];
  if (plan.run_id !== runId) mismatches.push(`plan.run_id ${plan.run_id} != ${runId}`);
  if (plan.base_commit !== baseCommit) mismatches.push(`plan.base_commit ${plan.base_commit} != ${baseCommit}`);
  if (plan.integration_branch !== integrationBranch) mismatches.push(`plan.integration_branch ${plan.integration_branch} != ${integrationBranch}`);

  if (metadata.run_id !== runId) mismatches.push(`metadata.run_id ${metadata.run_id} != ${runId}`);
  if (metadata.base_commit !== baseCommit) mismatches.push(`metadata.base_commit ${metadata.base_commit} != ${baseCommit}`);
  if (metadata.integration_branch !== integrationBranch) mismatches.push(`metadata.integration_branch ${metadata.integration_branch} != ${integrationBranch}`);

  if (changedFilesEvidence.base_commit !== baseCommit) {
    mismatches.push(`changed-files.base_commit ${changedFilesEvidence.base_commit} != ${baseCommit}`);
  }

  if (context.run_id !== runId) mismatches.push(`context.run_id ${context.run_id} != ${runId}`);
  if (context.base_commit !== baseCommit) mismatches.push(`context.base_commit ${context.base_commit} != ${baseCommit}`);
  if (context.integration_branch !== integrationBranch) mismatches.push(`context.integration_branch ${context.integration_branch} != ${integrationBranch}`);
  if (context.integration_head !== metadata.integration_head) {
    mismatches.push(`context.integration_head ${context.integration_head} != metadata ${metadata.integration_head}`);
  }
  if (context.integrated_diff_digest !== metadata.integrated_diff_digest) {
    mismatches.push(`context.integrated_diff_digest != metadata.integrated_diff_digest`);
  }

  let state: Awaited<ReturnType<StateStore['read']>>;
  try {
    state = await stateStore.read();
  } catch (err) {
    return {
      ok: false,
      code: ErrorCategory.STATE_CONFLICT,
      message: `state.json is unreadable during R2 evidence validation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (state.run_id !== runId) mismatches.push(`state.run_id ${state.run_id} != ${runId}`);
  if (state.base_commit !== baseCommit) mismatches.push(`state.base_commit ${state.base_commit} != ${baseCommit}`);
  if (state.branch !== integrationBranch) mismatches.push(`state.branch ${state.branch} != ${integrationBranch}`);
  if (state.audited_diff_digest !== metadata.integrated_diff_digest) {
    mismatches.push(`state.audited_diff_digest ${state.audited_diff_digest ?? 'null'} != metadata.integrated_diff_digest ${metadata.integrated_diff_digest}`);
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      code: ErrorCategory.STATE_CONFLICT,
      message: `R2 evidence mismatch: ${mismatches.join('; ')}`,
    };
  }

  // Final Aggregate Audit must be PASS for this run. R3 never reruns it.
  let decision: string | null = null;
  let finalAuditRunId: string | null = null;
  let finalAuditDiffDigest: string | null = null;
  try {
    const { frontMatter } = parseFinalAudit(readFileSync(finalAuditMdPath, 'utf8'), finalAuditMdPath);
    decision = frontMatter.decision;
    finalAuditRunId = frontMatter.run_id;
    finalAuditDiffDigest = frontMatter.diff_digest;
  } catch (err) {
    return {
      ok: false,
      code: ErrorCategory.FINAL_AUDIT_FAILED,
      message: `.agent/final-audit.md is invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (finalAuditRunId !== runId) {
    return {
      ok: false,
      code: ErrorCategory.STATE_CONFLICT,
      message: `.agent/final-audit.md run_id ${finalAuditRunId} != ${runId}`,
    };
  }
  if (decision !== 'PASS') {
    return {
      ok: false,
      code: ErrorCategory.FINAL_AUDIT_FAILED,
      message: `Final Aggregate Audit decision is ${decision}, not PASS. R3 will not finalize a non-PASS audit.`,
    };
  }
  if (finalAuditDiffDigest !== metadata.integrated_diff_digest) {
    return {
      ok: false,
      code: ErrorCategory.STATE_CONFLICT,
      message: `.agent/final-audit.md diff_digest does not match integrated diff digest`,
    };
  }

  return {
    ok: true,
    value: {
      plan,
      metadata,
      context,
      integratedDiffDigest: metadata.integrated_diff_digest,
      changedFiles: metadata.changed_files,
      changedFilesEvidence,
      untrackedFilesEvidence,
      integrationHead: metadata.integration_head,
    },
  };
}

interface R2Evidence {
  plan: IntegrationPlanEvidence;
  metadata: IntegratedDiffMetadata;
  context: FinalAuditContext;
  integratedDiffDigest: string;
  changedFiles: string[];
  changedFilesEvidence: ChangedFilesSchema;
  untrackedFilesEvidence: UntrackedFilesSchema;
  integrationHead: string;
}

// ─── Business diff verification ───────────────────────────────

async function verifyBusinessDiff(params: {
  projectRoot: string;
  baseCommit: string;
  evidence: R2Evidence;
}): Promise<
  | { ok: true; businessFiles: string[] }
  | { ok: false; message: string }
> {
  const diffResult = await collectDiff({
    projectRoot: params.projectRoot,
    baseCommit: params.baseCommit,
    iteration: 0,
  });
  const recomputedDigest = `sha256:${diffResult.diffDigest}` as Digest;
  const businessFiles = diffResult.changedFiles.files
    .map((file) => file.path)
    .filter((filePath) => !filePath.startsWith('.agent/'))
    .sort();
  const r2BusinessFiles = params.evidence.changedFiles
    .filter((filePath) => !filePath.startsWith('.agent/'))
    .sort();

  // The business file set must not have changed after R2.
  const businessSetChanged = !sameSet(businessFiles, r2BusinessFiles);
  const digestMatches = recomputedDigest === params.evidence.integratedDiffDigest;
  // On a stale-rerun where a prior R3 commit tracked .agent artifacts, the
  // recomputed digest diverges solely because .agent files are now tracked.
  const agentTracked = diffResult.changedFiles.files.some((file) => file.path.startsWith('.agent/'));

  if (businessSetChanged) {
    return {
      ok: false,
      message: `Business file set changed after R2 PASS. Expected ${r2BusinessFiles.join(', ') || '(none)'}, got ${businessFiles.join(', ') || '(none)'}.`,
    };
  }

  const expectedChangedFiles = businessChangedFileEntries(params.evidence.changedFilesEvidence.files);
  const actualChangedFiles = businessChangedFileEntries(diffResult.changedFiles.files);
  if (stableStringify(expectedChangedFiles) !== stableStringify(actualChangedFiles)) {
    return {
      ok: false,
      message: `Business changed-file metadata changed after R2 PASS. Expected ${stableStringify(expectedChangedFiles)}, got ${stableStringify(actualChangedFiles)}.`,
    };
  }

  const expectedUntrackedFiles = businessUntrackedFiles(params.evidence.untrackedFilesEvidence.files);
  const actualUntrackedFiles = businessUntrackedFiles(diffResult.untrackedFiles.files);
  if (stableStringify(expectedUntrackedFiles) !== stableStringify(actualUntrackedFiles)) {
    return {
      ok: false,
      message: `Business untracked file evidence changed after R2 PASS.`,
    };
  }

  const trackedPathspecs = trackedBusinessPathspecs(expectedChangedFiles);
  const expectedTrackedDiff = await collectTrackedBusinessDiff({
    projectRoot: params.projectRoot,
    baseCommit: params.baseCommit,
    compareRef: params.evidence.integrationHead,
    pathspecs: trackedPathspecs,
  });
  if (!expectedTrackedDiff.ok) {
    return { ok: false, message: expectedTrackedDiff.message };
  }
  const actualTrackedDiff = await collectTrackedBusinessDiff({
    projectRoot: params.projectRoot,
    baseCommit: params.baseCommit,
    pathspecs: trackedPathspecs,
  });
  if (!actualTrackedDiff.ok) {
    return { ok: false, message: actualTrackedDiff.message };
  }
  if (!expectedTrackedDiff.diff.equals(actualTrackedDiff.diff)) {
    return {
      ok: false,
      message: `Business tracked diff content changed after R2 PASS.`,
    };
  }

  if (!digestMatches && !agentTracked) {
    return {
      ok: false,
      message: `Integrated business diff digest mismatch after R2 PASS: expected ${params.evidence.integratedDiffDigest}, got ${recomputedDigest}.`,
    };
  }

  return { ok: true, businessFiles };
}

async function verifyLiveIntegrationHead(params: {
  projectRoot: string;
  integrationBranch: string;
  expectedHead: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await runGit(['rev-parse', '--verify', params.integrationBranch], params.projectRoot);
  if (result.exit_code !== 0) {
    return {
      ok: false,
      message: `Cannot verify ${params.integrationBranch} head: ${result.stderr || result.stdout}`,
    };
  }
  const actualHead = result.stdout.trim();
  if (actualHead !== params.expectedHead) {
    return {
      ok: false,
      message: `Integration branch head changed after R2 PASS: expected ${params.expectedHead}, got ${actualHead}.`,
    };
  }
  return { ok: true };
}

function businessChangedFileEntries(files: ChangedFile[]): ChangedFile[] {
  return files
    .filter((file) => !isAgentPath(file.path))
    .map((file) => ({
      path: file.path,
      status: file.status,
      ...(file.old_path ? { old_path: file.old_path } : {}),
      tracked: file.tracked,
      additions: file.additions,
      deletions: file.deletions,
    }))
    .sort(compareChangedFiles);
}

function businessUntrackedFiles(files: UntrackedFileEvidence[]): UntrackedFileEvidence[] {
  return files
    .filter((file) => !isAgentPath(file.path))
    .map((file) => ({ ...file }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function trackedBusinessPathspecs(files: ChangedFile[]): string[] {
  const pathspecs = new Set<string>();
  for (const file of files) {
    if (!file.tracked) continue;
    if (!isAgentPath(file.path)) pathspecs.add(file.path);
    if (file.old_path && !isAgentPath(file.old_path)) pathspecs.add(file.old_path);
  }
  return [...pathspecs].sort();
}

async function collectTrackedBusinessDiff(params: {
  projectRoot: string;
  baseCommit: string;
  compareRef?: string;
  pathspecs: string[];
}): Promise<{ ok: true; diff: Buffer } | { ok: false; message: string }> {
  if (params.pathspecs.length === 0) {
    return { ok: true, diff: Buffer.alloc(0) };
  }
  const args = params.compareRef
    ? ['diff', '--binary', '--find-renames', params.baseCommit, params.compareRef, '--', ...params.pathspecs]
    : ['diff', '--binary', '--find-renames', params.baseCommit, '--', ...params.pathspecs];
  const result = await runGitRaw(args, params.projectRoot);
  if (result.exit_code !== 0) {
    return {
      ok: false,
      message: `Failed to compute business tracked diff: ${result.stderr}`,
    };
  }
  return { ok: true, diff: result.stdout };
}

function compareChangedFiles(a: ChangedFile, b: ChangedFile): number {
  const byPath = a.path.localeCompare(b.path);
  if (byPath !== 0) return byPath;
  return (a.old_path ?? '').localeCompare(b.old_path ?? '');
}

function isAgentPath(filePath: string): boolean {
  return filePath === '.agent' || filePath.startsWith('.agent/');
}

// ─── Resume ───────────────────────────────────────────────────

async function tryResumeFromExistingCommit(params: {
  projectRoot: string;
  runId: string;
  baseCommit: string;
  integrationBranch: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  tag: boolean;
  iteration: number;
  finalCommitSha: string;
  evidence: R2Evidence;
  artifactPaths: string[];
}): Promise<
  | { outcome: 'passed'; result: IntegrationFinalizationResult }
  | { outcome: 'blocked'; result: IntegrationFinalizationResult }
  | { outcome: 'stale' }
> {
  const {
    projectRoot,
    runId,
    baseCommit,
    integrationBranch,
    stateStore,
    artifactStore,
    orchestratorRegistry,
    config,
    tag,
    iteration,
    finalCommitSha,
    evidence,
    artifactPaths,
  } = params;

  // 1. Commit must exist.
  if (!(await commitExists(projectRoot, finalCommitSha))) {
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'resume commit verification', 'FAIL', `commit ${finalCommitSha} not found`);
    return { outcome: 'stale' };
  }

  // 2. The recorded final commit must be the current integration branch tip.
  const branchTip = await runGit(['rev-parse', '--verify', integrationBranch], projectRoot);
  const onTip = branchTip.exit_code === 0 && branchTip.stdout.trim() === finalCommitSha;
  if (!onTip) {
    const actualTip = branchTip.exit_code === 0 ? branchTip.stdout.trim() : '(unreadable)';
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'resume commit verification', 'FAIL', `commit ${finalCommitSha} is not current ${integrationBranch} tip ${actualTip}`);
    return { outcome: 'stale' };
  }

  // 3. Required artifact paths exist in the commit tree.
  const treeCheck = await verifyCommitTree(projectRoot, finalCommitSha, REQUIRED_FINAL_COMMIT_ARTIFACTS);
  if (!treeCheck.valid) {
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'resume commit tree verification', 'FAIL', `commit ${finalCommitSha} missing: ${treeCheck.missing.join(', ')}`);
    return { outcome: 'stale' };
  }

  // 4. Committed .agent/final-audit.md belongs to this run with decision PASS.
  const showResult = await runGit(
    ['show', `${finalCommitSha}:.agent/final-audit.md`],
    projectRoot,
  );
  let auditVerified = false;
  let committedDigest: string | null = null;
  if (showResult.exit_code === 0) {
    try {
      const { frontMatter } = parseFinalAudit(showResult.stdout);
      auditVerified = frontMatter.run_id === runId && frontMatter.decision === 'PASS';
      committedDigest = frontMatter.diff_digest;
    } catch {
      auditVerified = false;
    }
  }
  if (!auditVerified) {
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'resume commit content verification', 'FAIL', `commit ${finalCommitSha} final-audit.md does not match run ${runId} PASS`);
    return { outcome: 'stale' };
  }

  // 5. Committed integration metadata matches run id, base commit, branch, digest.
  const committedMetadata = await readCommittedJson<IntegratedDiffMetadata>(
    projectRoot,
    finalCommitSha,
    '.agent/integration/integrated-diff-metadata.json',
  );
  const metadataMatches =
    committedMetadata !== null
    && committedMetadata.run_id === runId
    && committedMetadata.base_commit === baseCommit
    && committedMetadata.integration_branch === integrationBranch
    && committedMetadata.integrated_diff_digest === evidence.integratedDiffDigest
    && committedDigest === evidence.integratedDiffDigest;
  if (!metadataMatches) {
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'resume metadata verification', 'FAIL', `commit ${finalCommitSha} integration metadata does not match R2 evidence`);
    return { outcome: 'stale' };
  }

  // Commit is valid — no duplicate commit. Run tag handling only if needed.
  await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'resume commit verified', 'PASS', `final commit ${finalCommitSha.slice(0, 8)} already created`);

  const tagResult = await handleTag({
    projectRoot,
    stateStore,
    config,
    tag,
    runId,
    commitSha: finalCommitSha,
  });
  if (tagResult.outcome === 'blocked') {
    await stateStore.update(() => ({
      last_error: tagResult.error_message ?? 'tag failed',
      tag_name: tagResult.tagName,
      tag_created: false,
    }));
    await stateStore.transition(PhaseEnum.BLOCKED);
    return {
      outcome: 'blocked',
      result: blockedResult({
        integrationBranch,
        code: ErrorCategory.GIT_TAG_ERROR,
        message: tagResult.error_message ?? 'tag failed',
        artifactPaths,
        finalCommitSha: finalCommitSha,
        tagName: tagResult.tagName,
      }),
    };
  }

  await stateStore.update(() => ({
    branch: integrationBranch,
    final_commit_sha: finalCommitSha,
    commit_skipped: false,
    skip_reason: null,
    finalized_at: new Date().toISOString(),
    tag_name: tagResult.tagName,
    tag_created: tagResult.tagCreated,
  }));
  await stateStore.transition(PhaseEnum.PASSED);
  await emitProgress({
    projectRoot,
    stateStore,
    lastEvent: `Phase 8E R3 finalization PASSED (resumed) on ${integrationBranch}`,
    registry: orchestratorRegistry,
    commitSha: finalCommitSha,
    finalAuditDecision: 'PASS',
  });

  return {
    outcome: 'passed',
    result: {
      status: 'passed',
      integration_branch: integrationBranch,
      final_commit_sha: finalCommitSha,
      final_commit_message: (await stateStore.read()).final_commit_message,
      tag_name: tagResult.tagName,
      tag_created: tagResult.tagCreated,
      commit_skipped: false,
      skip_reason: null,
      artifact_paths: artifactPaths,
      error_code: null,
      error_message: null,
    },
  };
}

// ─── Tag handling ─────────────────────────────────────────────

async function handleTag(params: {
  projectRoot: string;
  stateStore: StateStore;
  config: ReviewLoopConfig;
  tag: boolean;
  runId: string;
  commitSha: string;
}): Promise<
  | { outcome: 'ok'; tagName: string | null; tagCreated: boolean }
  | { outcome: 'blocked'; tagName: string | null; error_message: string }
> {
  const { projectRoot, stateStore, config, tag, runId, commitSha } = params;

  const state = await stateStore.read();
  const retryRequestedTag = Boolean(state.tag_name && !state.tag_created);
  if (!(tag || config.git.create_tag || retryRequestedTag)) {
    return { outcome: 'ok', tagName: null, tagCreated: false };
  }

  let tagName: string;
  try {
    tagName = state.tag_name ?? renderTagName(config.git.tag_template, {
      run_id: runId,
      task_slug: state.task_slug,
    });
  } catch (err) {
    return {
      outcome: 'blocked',
      tagName: null,
      error_message: `Tag template error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const existingTarget = await getTagTarget(projectRoot, tagName);
  if (existingTarget !== null) {
    if (existingTarget === commitSha) {
      return { outcome: 'ok', tagName, tagCreated: true };
    }
    return {
      outcome: 'blocked',
      tagName,
      error_message: `Tag ${tagName} already exists pointing to ${existingTarget}, expected ${commitSha}`,
    };
  }

  const tagResult = await createTag(projectRoot, tagName, commitSha);
  if (!tagResult.success) {
    return {
      outcome: 'blocked',
      tagName,
      error_message: `Tag creation failed: ${tagResult.error}`,
    };
  }
  return { outcome: 'ok', tagName, tagCreated: true };
}

// ─── Branch switching ─────────────────────────────────────────

async function ensureOnIntegrationBranch(
  projectRoot: string,
  integrationBranch: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = await runGit(['branch', '--show-current'], projectRoot);
  if (current.exit_code !== 0) {
    return { ok: false, message: `Cannot determine current branch: ${current.stderr || current.stdout}` };
  }
  if (current.stdout.trim() === integrationBranch) {
    return { ok: true };
  }

  const branchExists = await runGit(['rev-parse', '--verify', `refs/heads/${integrationBranch}`], projectRoot);
  if (branchExists.exit_code !== 0) {
    return { ok: false, message: `Integration branch ${integrationBranch} does not exist` };
  }

  // Only switch when tracked working tree is clean; never disturb uncommitted work.
  const status = await runGit(['status', '--porcelain=v1', '--untracked-files=no'], projectRoot);
  if (status.exit_code !== 0 || status.stdout.trim().length > 0) {
    return { ok: false, message: `Cannot safely switch to ${integrationBranch}; tracked working tree changes are present` };
  }

  const switched = await runGit(['switch', integrationBranch], projectRoot);
  if (switched.exit_code !== 0) {
    return { ok: false, message: `Failed to switch to ${integrationBranch}: ${switched.stderr || switched.stdout}` };
  }
  return { ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────

function buildExistingAllowlistArtifacts(projectRoot: string): string[] {
  const all = [
    ...INTEGRATION_VERSIONED_ARTIFACT_PATHS,
    ...OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  ];
  return all.filter((filePath) => existsSync(path.join(projectRoot, filePath)));
}

async function readCommittedJson<T>(
  projectRoot: string,
  commitSha: string,
  treePath: string,
): Promise<T | null> {
  const result = await runGit(['show', `${commitSha}:${treePath}`], projectRoot);
  if (result.exit_code !== 0) return null;
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function blockFinalization(params: {
  stateStore: StateStore;
  integrationBranch: string;
  code: ErrorCategoryType;
  message: string;
  artifactPaths?: string[];
  finalCommitSha?: string | null;
  finalCommitMessage?: string | null;
  tagName?: string | null;
}): Promise<IntegrationFinalizationResult> {
  await params.stateStore.update(() => ({
    branch: params.integrationBranch,
    last_error: params.message,
    commit_skipped: false,
    skip_reason: null,
    ...(params.finalCommitSha !== undefined ? { final_commit_sha: params.finalCommitSha } : {}),
    ...(params.finalCommitMessage !== undefined ? { final_commit_message: params.finalCommitMessage } : {}),
    ...(params.tagName !== undefined ? { tag_name: params.tagName } : {}),
    ...(params.tagName !== undefined ? { tag_created: false } : {}),
  }));
  const state = await params.stateStore.read();
  if (state.phase !== PhaseEnum.BLOCKED) {
    await params.stateStore.transition(PhaseEnum.BLOCKED);
  }
  return blockedResult(params);
}

function blockedResult(params: {
  integrationBranch: string;
  code: ErrorCategoryType;
  message: string;
  artifactPaths?: string[];
  finalCommitSha?: string | null;
  finalCommitMessage?: string | null;
  tagName?: string | null;
}): IntegrationFinalizationResult {
  return {
    status: 'blocked',
    integration_branch: params.integrationBranch,
    final_commit_sha: params.finalCommitSha ?? null,
    final_commit_message: params.finalCommitMessage ?? null,
    tag_name: params.tagName ?? null,
    tag_created: false,
    commit_skipped: false,
    skip_reason: null,
    artifact_paths: params.artifactPaths ?? [],
    error_code: params.code,
    error_message: params.message,
  };
}

// Re-exported for callers/tests that need the allowlist.
export {
  INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  isIntegrationVersionedArtifact,
};
