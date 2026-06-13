/**
 * Run Orchestrator — first-round orchestration loop.
 * Phase 3 §12: INITIALIZING → PLANNING → DEVELOPING → VERIFYING → AUDITING → FINALIZING/REWORKING/BLOCKED
 *
 * Phase 3 constraints:
 * - Only executes iteration 1 (no auto-rework)
 * - No resume, cancel, commit, tag, or push
 * - All external commands through Process Runner
 * - All Git operations through Git Manager
 * - Mechanical checks override Agent self-assessment
 */

import { join, resolve, sep } from 'node:path';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StateStore } from './state-store.js';
import { LockManager } from '../runtime/lock-manager.js';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import { loadConfigWithDefaults } from '../artifacts/config.js';
import type { ReviewLoopConfig } from '../types.js';
import { preflight, createTaskBranch } from '../git/git-manager.js';
import { collectDiff, writeDiffArtifacts } from '../git/diff-collector.js';
import { checkScope, writeScopeReport } from '../scope/scope-guard.js';
import { runVerification } from '../verification/verification-runner.js';
import { computeDigest as computeDigestLib, type Digest } from '../runtime/digest.js';
import { buildPlannerPrompt, buildDeveloperPrompt, buildAuditorPrompt, buildPrompt, deletePromptFile, type PromptCleanupResult } from '../agents/prompt-builder.js';
import { buildPlannerInput, validatePlannerOutput, snapshotWorkspaceBeforePlanner, validatePlannerWorkspaceOwnership } from '../agents/planner-adapter.js';
import { buildDeveloperInput, validateDeveloperOutput } from '../agents/developer-adapter.js';
import { buildAuditorInput, validateAuditorOutput } from '../agents/auditor-adapter.js';
import { runAgent } from '../agents/agent-adapter.js';
import type {
  Phase,
  ReviewLoopError,
  ErrorCategory,
  IterationLogEntry,
  OrchestratorFileRegistryEntry,
  OrchestratorRegistryVerificationResult,
  OrchestratorRegistryViolation,
} from '../types.js';
import { Phase as PhaseEnum } from '../types.js';

/** Orchestrator result returned to CLI. */
export interface OrchestratorResult {
  run_id: string;
  phase: Phase;
  exit_code: number;
  branch: string;
  audit_decision: string | null;
  artifact_paths: string[];
  next_action: string;
  message: string;
  error: ReviewLoopError | null;
}

/**
 * Run the first-round orchestration loop.
 */
export async function runOrchestrator(params: {
  project_root: string;
  request: string;
  task_slug?: string;
  max_iterations?: number;
  config_path?: string;
  no_commit?: boolean;
  tag?: boolean;
  signal?: AbortSignal;
}): Promise<OrchestratorResult> {
  const projectRoot = resolve(params.project_root);
  const agentDir = join(projectRoot, '.agent');
  let lockManager: LockManager | null = null;
  let stateStore: StateStore | null = null;
  let runId = ''; // Declared at function scope so finally block can access it

  try {
    // ═══════════════════════════════════════════════════════════
    // §12.1 INITIALIZING
    // ═══════════════════════════════════════════════════════════

    if (!existsSync(projectRoot)) {
      return makeBlockedResult('', projectRoot, `Project root does not exist: ${projectRoot}`, 'CONFIG_ERROR');
    }

    // 2. Load configuration
    // F-309 fix: pass explicit config_path from --config CLI flag
    let config: ReviewLoopConfig;
    try {
      config = await loadConfigWithDefaults(projectRoot, params.config_path);
    } catch (err) {
      return makeBlockedResult('', projectRoot, `Configuration error: ${err instanceof Error ? err.message : String(err)}`, 'CONFIG_ERROR');
    }

    // 3. Initialize Artifact Store
    const artifactStore = new ArtifactStore(projectRoot);
    if (!await artifactStore.exists()) {
      await artifactStore.init();
    }

    // 4. Execute Git preflight
    const preflightResult = await preflight(projectRoot);
    if (preflightResult.status === 'error') {
      return makeBlockedResult('', projectRoot, `Git preflight failed: ${preflightResult.error?.message ?? 'unknown error'}`, 'PREFLIGHT_ERROR');
    }

    const baseCommit = preflightResult.head_sha!;
    const originalBranch = preflightResult.branch!;

    // 5. Acquire run lock
    lockManager = new LockManager(agentDir);
    runId = generateRunId();
    try {
      await lockManager.acquire(runId);
    } catch (err) {
      return makeBlockedResult(runId, projectRoot, `Lock acquisition failed: ${err instanceof Error ? err.message : String(err)}`, 'STATE_CONFLICT');
    }

    // 6. Generate task_slug
    const taskSlug = params.task_slug || sanitizeSlug(params.request);

    // 7. Create initial state
    stateStore = new StateStore(agentDir);
    const maxIterations = params.max_iterations ?? config.loop.max_iterations;
    await stateStore.create({
      run_id: runId,
      task_slug: taskSlug,
      project_root: projectRoot,
      base_commit: baseCommit,
      branch: originalBranch,
      max_iterations: maxIterations,
    });

    // 8. Transition to PLANNING
    await stateStore.transition(PhaseEnum.PLANNING);
    await appendLog(artifactStore, runId, 0, 'PLANNING', 'planner start', 'PASS');

    // F-307R2: Initialize orchestrator file registry for explicit ownership tracking.
    // Every file the orchestrator writes will be registered here.
    const orchestratorRegistry = new OrchestratorFileRegistry();

    // Register files created before the registry was initialized.
    // These are orchestrator-owned but were created during INITIALIZING.
    const preRegistryFiles = [
      join(agentDir, 'state.json'),
      join(agentDir, 'run.lock'),
    ];
    for (const filePath of preRegistryFiles) {
      if (existsSync(filePath)) {
        try {
          const digest = computeDigest(readFileSync(filePath, 'utf8'));
          orchestratorRegistry.register(filePath, digest);
        } catch { /* skip unreadable */ }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // §12.2 PLANNING
    // ═══════════════════════════════════════════════════════════

    let plannerPrompt: string;
    let plannerPromptFile: string | undefined;
    try {
      const promptResult = await buildPrompt(
        projectRoot,
        'planner.md',
        (template) => buildPlannerPrompt(template, {
          user_request: params.request,
          run_id: runId,
          project_root: projectRoot,
          base_commit: baseCommit,
        }),
        { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'planner' },
      );
      plannerPrompt = promptResult.prompt;
      plannerPromptFile = promptResult.prompt_file_path ?? undefined;
    } catch (err) {
      await transitionToBlocked(stateStore, `Planner prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
      return makeBlockedResult(runId, projectRoot, 'Planner prompt build failed', 'CONFIG_ERROR', originalBranch);
    }

    // F-306R1 fix: Wrap Planner execution in try/finally to guarantee prompt cleanup
    // even on unexpected exceptions (e.g. recordArtifactDigests throws on directory path).
    // F-306R2 fix: Check cleanup result — prompt deletion failure must BLOCKED.
    let plannerResult;
    let plannerCleanupResult: PromptCleanupResult | undefined;
    try {
      // Snapshot workspace before Planner to detect unauthorized changes
      const prePlannerSnapshot = await snapshotWorkspaceBeforePlanner(projectRoot);

      const plannerInput = buildPlannerInput({
        run_id: runId,
        project_root: projectRoot,
        command_template: config.agents.planner.command,
        timeout_seconds: config.agents.planner.timeout_seconds,
        prompt: plannerPrompt,
        prompt_file: plannerPromptFile,
        signal: params.signal,
      });

      plannerResult = { result: await runAgent(plannerInput, projectRoot), prePlannerSnapshot };
    } finally {
      if (plannerPromptFile) plannerCleanupResult = await deletePromptFile(plannerPromptFile);
    }

    // F-306R2: Prompt cleanup failure is a security boundary — must BLOCKED
    if (plannerCleanupResult && !plannerCleanupResult.success) {
      await transitionToBlocked(stateStore, `Planner prompt cleanup failed: ${plannerCleanupResult.error}`);
      return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${plannerCleanupResult.error}`, 'STATE_CONFLICT', originalBranch);
    }

    if (plannerResult.result.status !== 'success') {
      await transitionToBlocked(stateStore, `Planner failed: ${plannerResult.result.error?.message ?? 'unknown'}`);
      await appendLog(artifactStore, runId, 0, 'PLANNING', 'planner completed', 'FAIL', plannerResult.result.error?.message);
      return makeResult(runId, PhaseEnum.BLOCKED, 3, originalBranch, null, [], 'Fix Planner configuration or check agent availability', `Planner failed: ${plannerResult.result.error?.message ?? 'unknown'}`, plannerResult.result.error);
    }

    // Validate Planner output
    const plannerValidation = validatePlannerOutput(projectRoot, runId);
    if (!plannerValidation.valid) {
      await transitionToBlocked(stateStore, `Planner output validation failed: ${plannerValidation.errors.join('; ')}`);
      await appendLog(artifactStore, runId, 0, 'PLANNING', 'GOAL validation', 'FAIL', plannerValidation.errors.join('; '));
      return makeBlockedResult(runId, projectRoot, `Planner output invalid: ${plannerValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', originalBranch);
    }

    // Validate Planner workspace ownership — only plan.md and GOAL.md may change
    const plannerWorkspaceCheck = await validatePlannerWorkspaceOwnership(projectRoot, plannerResult.prePlannerSnapshot);
    if (!plannerWorkspaceCheck.valid) {
      await transitionToBlocked(stateStore, `Planner workspace violation: ${plannerWorkspaceCheck.violations.join('; ')}`);
      await appendLog(artifactStore, runId, 0, 'PLANNING', 'workspace ownership', 'FAIL', plannerWorkspaceCheck.violations.join('; '));
      return makeBlockedResult(runId, projectRoot, `Planner modified disallowed files: ${plannerWorkspaceCheck.violations.join('; ')}`, 'SCOPE_VIOLATION', originalBranch);
    }

    await appendLog(artifactStore, runId, 0, 'PLANNING', 'planner completed', 'PASS');

    // F-307R2: Register Planner agent log files in the orchestrator registry.
    // These are created by the Process Runner infrastructure, not by the Planner agent itself.
    if (plannerResult.result.stdout_path && existsSync(plannerResult.result.stdout_path)) {
      const stdoutDigest = computeDigest(readFileSync(plannerResult.result.stdout_path, 'utf8'));
      orchestratorRegistry.register(plannerResult.result.stdout_path, stdoutDigest);
    }
    if (plannerResult.result.stderr_path && existsSync(plannerResult.result.stderr_path)) {
      const stderrDigest = computeDigest(readFileSync(plannerResult.result.stderr_path, 'utf8'));
      orchestratorRegistry.register(plannerResult.result.stderr_path, stderrDigest);
    }

    // F-307R2: Register Planner-produced artifacts (plan.md, GOAL.md) and iteration-log.md.
    // These are orchestrator-owned files that appear in changedFiles during scope checks.
    const planMdPath = join(agentDir, 'plan.md');
    if (existsSync(planMdPath)) {
      const planDigest = computeDigest(readFileSync(planMdPath, 'utf8'));
      orchestratorRegistry.register(planMdPath, planDigest);
    }
    const goalMdPath = join(agentDir, 'GOAL.md');
    if (existsSync(goalMdPath)) {
      const goalDigest = computeDigest(readFileSync(goalMdPath, 'utf8'));
      orchestratorRegistry.register(goalMdPath, goalDigest);
    }
    const iterLogPath = join(agentDir, 'iteration-log.md');
    if (existsSync(iterLogPath)) {
      const iterLogDigest = computeDigest(readFileSync(iterLogPath, 'utf8'));
      orchestratorRegistry.register(iterLogPath, iterLogDigest);
    }

    // Save GOAL digest to state
    if (plannerValidation.goalDigest) {
      await stateStore.update(() => ({ goal_digest: plannerValidation.goalDigest! }));
    }

    // Create task branch
    const branchResult = await createTaskBranch(
      projectRoot,
      runId,
      taskSlug,
      baseCommit,
      originalBranch,
      config.git.branch_template,
    );

    if (branchResult.status === 'error') {
      await transitionToBlocked(stateStore, `Branch creation failed: ${branchResult.error?.message ?? 'unknown'}`);
      return makeBlockedResult(runId, projectRoot, `Branch creation failed: ${branchResult.error?.message}`, 'STATE_CONFLICT', originalBranch);
    }

    await stateStore.update(() => ({ branch: branchResult.branch_name }));
    await appendLog(artifactStore, runId, 0, 'PLANNING', 'branch creation', 'PASS', branchResult.branch_name);

    // Transition to DEVELOPING
    await stateStore.update(() => ({ iteration: 1 }));
    await stateStore.transition(PhaseEnum.DEVELOPING);
    await appendLog(artifactStore, runId, 1, 'DEVELOPING', 'developer start', 'PASS');

    // ═══════════════════════════════════════════════════════════
    // §12.3 DEVELOPING
    // ═══════════════════════════════════════════════════════════

    // Record plan/GOAL digests before Developer
    const preDevPlanDigest = computeDigest(readFileSync(join(projectRoot, '.agent/plan.md'), 'utf8'));
    const preDevGoalDigest = computeDigest(readFileSync(join(projectRoot, '.agent/GOAL.md'), 'utf8'));

    // F-307R2 fix: Snapshot ALL system-protected paths before Developer call.
    // This replaces the F-307R1 digest guard with a comprehensive registry-based approach.
    // After Developer returns, we verify:
    // 1. All registered orchestrator files are intact (digest match)
    // 2. All pre-existing system-protected files are unchanged
    // 3. No new unregistered files in system-protected directories
    // 4. No symlink replacements of registered files
    // Only .agent/developer-handoff.md may be written by Developer.
    const preDevSystemPaths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

    // Register static protected files (state.json, run.lock, iteration-log.md, plan.md, GOAL.md)
    const staticProtectedFiles = [
      join(agentDir, 'state.json'),
      join(agentDir, 'run.lock'),
      join(agentDir, 'iteration-log.md'),
      join(agentDir, 'plan.md'),
      join(agentDir, 'GOAL.md'),
    ];
    for (const filePath of staticProtectedFiles) {
      if (existsSync(filePath)) {
        try {
          const stat = lstatSync(filePath);
          if (!stat.isDirectory()) {
            const digest = computeDigest(readFileSync(filePath, 'utf8'));
            preDevSystemPaths.set(filePath, {
              digest,
              mode: stat.mode,
              isSymlink: stat.isSymbolicLink(),
            });
          }
        } catch { /* skip unreadable */ }
      }
    }

    // Register all files in system-protected directories
    const protectedDirs = [
      join(agentDir, 'evidence'),
      join(agentDir, 'verification'),
      join(agentDir, 'history'),
      join(agentDir, 'debug'),
    ];
    for (const dir of protectedDirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { recursive: true, withFileTypes: false });
        for (const entry of entries) {
          const fullPath = join(dir, String(entry));
          try {
            const stat = lstatSync(fullPath);
            if (stat.isDirectory()) continue;
            const digest = computeDigest(readFileSync(fullPath, 'utf8'));
            preDevSystemPaths.set(fullPath, {
              digest,
              mode: stat.mode,
              isSymlink: stat.isSymbolicLink(),
            });
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable directory */ }
    }

    // Build Developer prompt
    let developerPrompt: string;
    let developerPromptFile: string | undefined;
    try {
      const promptResult = await buildPrompt(
        projectRoot,
        'developer.md',
        (template) => buildDeveloperPrompt(template, {
          run_id: runId,
          iteration: 1,
          project_root: projectRoot,
          plan_path: join(projectRoot, '.agent/plan.md'),
          goal_path: join(projectRoot, '.agent/GOAL.md'),
          handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
        }),
        { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'developer' },
      );
      developerPrompt = promptResult.prompt;
      developerPromptFile = promptResult.prompt_file_path ?? undefined;
    } catch (err) {
      await transitionToBlocked(stateStore, `Developer prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
      return makeBlockedResult(runId, projectRoot, 'Developer prompt build failed', 'CONFIG_ERROR', branchResult.branch_name);
    }

    // F-306R1 fix: Wrap Developer execution in try/finally for prompt cleanup
    // F-306R2 fix: Check cleanup result — prompt deletion failure must BLOCKED.
    let developerResult;
    let developerCleanupResult: PromptCleanupResult | undefined;
    try {
      const developerInput = buildDeveloperInput({
        run_id: runId,
        iteration: 1,
        project_root: projectRoot,
        command_template: config.agents.developer.command,
        timeout_seconds: config.agents.developer.timeout_seconds,
        prompt: developerPrompt,
        prompt_file: developerPromptFile,
        signal: params.signal,
      });

      developerResult = await runAgent(developerInput, projectRoot);
    } finally {
      if (developerPromptFile) developerCleanupResult = await deletePromptFile(developerPromptFile);
    }

    // F-306R2: Prompt cleanup failure is a security boundary — must BLOCKED
    if (developerCleanupResult && !developerCleanupResult.success) {
      await transitionToBlocked(stateStore, `Developer prompt cleanup failed: ${developerCleanupResult.error}`);
      return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${developerCleanupResult.error}`, 'STATE_CONFLICT', branchResult.branch_name);
    }

    if (developerResult.status !== 'success') {
      await transitionToBlocked(stateStore, `Developer failed: ${developerResult.error?.message ?? 'unknown'}`);
      await appendLog(artifactStore, runId, 1, 'DEVELOPING', 'developer completed', 'FAIL', developerResult.error?.message);
      return makeResult(runId, PhaseEnum.BLOCKED, 3, branchResult.branch_name, null, [], 'Fix Developer configuration or check agent availability', `Developer failed: ${developerResult.error?.message ?? 'unknown'}`, developerResult.error);
    }

    // F-307R2: Register Developer agent log files in the orchestrator registry.
    // These are created by the Process Runner infrastructure, not by the Developer agent itself.
    if (developerResult.stdout_path && existsSync(developerResult.stdout_path)) {
      const stdoutDigest = computeDigest(readFileSync(developerResult.stdout_path, 'utf8'));
      orchestratorRegistry.register(developerResult.stdout_path, stdoutDigest);
    }
    if (developerResult.stderr_path && existsSync(developerResult.stderr_path)) {
      const stderrDigest = computeDigest(readFileSync(developerResult.stderr_path, 'utf8'));
      orchestratorRegistry.register(developerResult.stderr_path, stderrDigest);
    }

    // F-307R2 fix: Verify all system-protected paths after Developer call.
    // This replaces the F-307R1 digest guard with comprehensive registry-based verification.
    const registryVerification = await verifySystemProtectedPaths(
      projectRoot,
      orchestratorRegistry,
      preDevSystemPaths,
    );

    if (!registryVerification.valid) {
      const violationMsgs = registryVerification.violations.map(v => v.message).join('; ');
      await transitionToBlocked(stateStore, `Developer tampered with system-protected paths: ${violationMsgs}`);
      await appendLog(artifactStore, runId, 1, 'DEVELOPING', 'system path integrity', 'FAIL', violationMsgs);
      return makeBlockedResult(
        runId, projectRoot,
        `Developer tampered with system-protected paths: ${violationMsgs}`,
        'STATE_CONFLICT',
        branchResult.branch_name,
      );
    }

    // Validate Developer output
    const developerValidation = validateDeveloperOutput(
      projectRoot,
      runId,
      1,
      preDevPlanDigest,
      preDevGoalDigest,
    );

    if (!developerValidation.valid) {
      await transitionToBlocked(stateStore, `Developer output validation failed: ${developerValidation.errors.join('; ')}`);
      await appendLog(artifactStore, runId, 1, 'DEVELOPING', 'developer completed', 'FAIL', developerValidation.errors.join('; '));
      return makeBlockedResult(runId, projectRoot, `Developer output invalid: ${developerValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', branchResult.branch_name);
    }

    // Developer BLOCKED → run enters BLOCKED
    if (developerValidation.isBlocked) {
      await transitionToBlocked(stateStore, 'Developer reported BLOCKED');
      await appendLog(artifactStore, runId, 1, 'DEVELOPING', 'developer completed', 'BLOCKED', 'Developer reported BLOCKED');
      return makeResult(runId, PhaseEnum.BLOCKED, 3, branchResult.branch_name, null, [], 'Resolve Developer BLOCKED issue and retry', 'Developer reported BLOCKED', null);
    }

    await appendLog(artifactStore, runId, 1, 'DEVELOPING', 'developer completed', 'PASS');

    // Transition to VERIFYING
    await stateStore.transition(PhaseEnum.VERIFYING);
    await appendLog(artifactStore, runId, 1, 'VERIFYING', 'verification start', 'PASS');

    // ═══════════════════════════════════════════════════════════
    // §12.4 MECHANICAL CHECKS AND VERIFICATION
    // ═══════════════════════════════════════════════════════════

    // 1. Collect cumulative diff from base commit
    const diffResult = await collectDiff({
      projectRoot,
      baseCommit,
      iteration: 1,
    });

    // 2. Write iteration-01 evidence
    await writeDiffArtifacts(projectRoot, 1, diffResult);

    // F-307R2: Register evidence files in the orchestrator registry
    const evidenceDir = join(agentDir, 'evidence', 'iteration-01');
    if (existsSync(evidenceDir)) {
      try {
        const evidenceEntries = readdirSync(evidenceDir, { recursive: true, withFileTypes: false });
        for (const entry of evidenceEntries) {
          const fullPath = join(evidenceDir, String(entry));
          try {
            const stat = lstatSync(fullPath);
            if (!stat.isDirectory()) {
              const digest = computeDigest(readFileSync(fullPath, 'utf8'));
              orchestratorRegistry.register(fullPath, digest);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable directory */ }
    }

    // 3. Execute Scope Guard
    const goalFm = plannerValidation.goalFrontMatter!;
    // F-307R2 fix: Use explicit registry paths instead of pattern-based inference.
    // Only files the orchestrator has actually written are considered orchestrator-owned.
    const orchestratorOwnedFiles = orchestratorRegistry.getRelativePaths(projectRoot);
    const scopeResult = checkScope({
      allowedChanges: goalFm.allowed_changes,
      disallowedChanges: goalFm.disallowed_changes,
      changedFiles: diffResult.changedFiles,
      orchestratorOwnedFiles,
    });

    await writeScopeReport(projectRoot, 1, scopeResult.report);

    // F-307R2: Register scope report in the orchestrator registry
    const scopeReportPath = join(agentDir, 'evidence', 'iteration-01', 'scope-report.json');
    if (existsSync(scopeReportPath)) {
      const scopeReportDigest = computeDigest(readFileSync(scopeReportPath, 'utf8'));
      orchestratorRegistry.register(scopeReportPath, scopeReportDigest);
    }

    if (!scopeResult.passed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const deniedPaths = scopeResult.report.denied.map(d => d.path).join(', ');
      await appendLog(artifactStore, runId, 1, 'VERIFYING', 'scope result', 'FAIL', `Denied: ${deniedPaths}`);
      return makeResult(
        runId, PhaseEnum.REWORKING, 2, branchResult.branch_name, null, [],
        'Phase 4 or manual rework needed — scope violation detected',
        `Scope violation: ${scopeResult.report.denied.map(d => `${d.path} (${d.reason})`).join(', ')}`,
        null,
      );
    }

    await appendLog(artifactStore, runId, 1, 'VERIFYING', 'scope result', 'PASS');

    // 4. Execute GOAL verification commands
    const verificationCommands = plannerValidation.verificationCommands!;
    const verificationResult = await runVerification({
      commands: verificationCommands,
      projectRoot,
      runId,
      iteration: 1,
    });

    // F-307R2: Register verification log files in the orchestrator registry.
    // These are created by the verification runner in .agent/verification/iteration-NN/.
    const verificationLogDir = join(agentDir, 'verification', 'iteration-01');
    if (existsSync(verificationLogDir)) {
      try {
        const logEntries = readdirSync(verificationLogDir, { recursive: true, withFileTypes: false });
        for (const entry of logEntries) {
          const fullPath = join(verificationLogDir, String(entry));
          try {
            const stat = lstatSync(fullPath);
            if (!stat.isDirectory()) {
              const digest = computeDigest(readFileSync(fullPath, 'utf8'));
              orchestratorRegistry.register(fullPath, digest);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable directory */ }
    }

    const requiredPassed = verificationResult.manifest.commands
      .filter(c => c.required)
      .every(c => c.status === 'success');

    if (!requiredPassed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const failedCmds = verificationResult.manifest.commands
        .filter(c => c.required && c.status !== 'success')
        .map(c => c.id);
      await appendLog(artifactStore, runId, 1, 'VERIFYING', 'verification result', 'FAIL', `Failed: ${failedCmds.join(', ')}`);
      return makeResult(
        runId, PhaseEnum.REWORKING, 2, branchResult.branch_name, null, [],
        'Phase 4 or manual rework needed — required verification failed',
        `Required verification failed: ${failedCmds.join(', ')}`,
        null,
      );
    }

    const allPassed = verificationResult.passed;
    await appendLog(artifactStore, runId, 1, 'VERIFYING', 'verification result', allPassed ? 'PASS' : 'FAIL');

    // F-307R2: Register verification manifest in the orchestrator registry
    const verificationManifestPath = join(agentDir, 'verification', 'manifest.json');
    if (existsSync(verificationManifestPath)) {
      const manifestDigest = computeDigest(readFileSync(verificationManifestPath, 'utf8'));
      orchestratorRegistry.register(verificationManifestPath, manifestDigest);
    }

    // ═══════════════════════════════════════════════════════════
    // §12.5 AUDITING
    // ═══════════════════════════════════════════════════════════

    // F-304 fix: Re-collect diff AFTER verification, because verification
    // commands (e.g. npm test) may create or modify files. The Auditor must
    // see the true final workspace state.
    const postVerificationDiffResult = await collectDiff({
      projectRoot,
      baseCommit,
      iteration: 1,
    });
    await writeDiffArtifacts(projectRoot, 1, postVerificationDiffResult);

    // F-307R2: Register post-verification evidence files in the orchestrator registry
    // (writeDiffArtifacts may have overwritten or created new evidence files)
    if (existsSync(evidenceDir)) {
      try {
        const evidenceEntries = readdirSync(evidenceDir, { recursive: true, withFileTypes: false });
        for (const entry of evidenceEntries) {
          const fullPath = join(evidenceDir, String(entry));
          try {
            const stat = lstatSync(fullPath);
            if (!stat.isDirectory()) {
              const digest = computeDigest(readFileSync(fullPath, 'utf8'));
              orchestratorRegistry.register(fullPath, digest);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable directory */ }
    }

    // Re-run Scope Guard on the post-verification diff
    // F-307R2 fix: Use explicit registry paths instead of pattern-based inference.
    const postVerificationOrchestratorOwned = orchestratorRegistry.getRelativePaths(projectRoot);

    const postVerificationScopeResult = checkScope({
      allowedChanges: goalFm.allowed_changes,
      disallowedChanges: goalFm.disallowed_changes,
      changedFiles: postVerificationDiffResult.changedFiles,
      orchestratorOwnedFiles: postVerificationOrchestratorOwned,
    });
    await writeScopeReport(projectRoot, 1, postVerificationScopeResult.report);

    // F-307R2: Register post-verification scope report in the orchestrator registry
    if (existsSync(scopeReportPath)) {
      const scopeReportDigest = computeDigest(readFileSync(scopeReportPath, 'utf8'));
      orchestratorRegistry.register(scopeReportPath, scopeReportDigest);
    }

    if (!postVerificationScopeResult.passed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const deniedPaths = postVerificationScopeResult.report.denied.map(d => d.path).join(', ');
      await appendLog(artifactStore, runId, 1, 'VERIFYING', 'post-verification scope', 'FAIL', `Denied: ${deniedPaths}`);
      return makeResult(
        runId, PhaseEnum.REWORKING, 2, branchResult.branch_name, null, [],
        'Phase 4 or manual rework needed — post-verification scope violation',
        `Post-verification scope violation: ${deniedPaths}`,
        null,
      );
    }

    // Use the post-verification diff for the rest of the pipeline
    const diffDigest = `sha256:${postVerificationDiffResult.diffDigest}` as Digest;
    await stateStore.update(() => ({ audited_diff_digest: diffDigest }));

    // 3. Transition to AUDITING
    await stateStore.transition(PhaseEnum.AUDITING);
    await appendLog(artifactStore, runId, 1, 'AUDITING', 'auditor start', 'PASS');

    // Record workspace state before Auditor
    // F-303 fix: snapshot ALL workspace files, not just Developer-changed files,
    // so that Auditor additions and deletions are detected.
    const preAuditWorkspaceDigests = new Map<string, Digest>();
    try {
      const { execFileSync } = await import('child_process');
      // Get all tracked files
      const trackedResult = execFileSync('git', ['ls-files', '-z'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const trackedFiles = trackedResult.split('\0').filter(Boolean);
      for (const relPath of trackedFiles) {
        const fullPath = join(projectRoot, relPath);
        if (existsSync(fullPath)) {
          try {
            preAuditWorkspaceDigests.set(fullPath, computeDigest(readFileSync(fullPath, 'utf8')));
          } catch { /* skip unreadable */ }
        }
      }
      // Get untracked files too
      const untrackedResult = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const untrackedFiles = untrackedResult.split('\0').filter(Boolean);
      for (const relPath of untrackedFiles) {
        const fullPath = join(projectRoot, relPath);
        if (existsSync(fullPath)) {
          try {
            preAuditWorkspaceDigests.set(fullPath, computeDigest(readFileSync(fullPath, 'utf8')));
          } catch { /* skip unreadable */ }
        }
      }
    } catch {
      // Fallback: use only Developer-changed files (less complete but better than nothing)
      const businessFiles = diffResult.changedFiles.files.map(f => join(projectRoot, f.path));
      for (const filePath of businessFiles) {
        if (existsSync(filePath)) {
          preAuditWorkspaceDigests.set(filePath, computeDigest(readFileSync(filePath, 'utf8')));
        }
      }
    }

    // Build Auditor prompt
    let auditorPrompt: string;
    let auditorPromptFile: string | undefined;
    try {
      const promptResult = await buildPrompt(
        projectRoot,
        'auditor.md',
        (template) => buildAuditorPrompt(template, {
          run_id: runId,
          iteration: 1,
          project_root: projectRoot,
          plan_path: join(projectRoot, '.agent/plan.md'),
          goal_path: join(projectRoot, '.agent/GOAL.md'),
          handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
          verification_manifest_path: join(agentDir, 'verification', 'manifest.json'),
          changed_files_path: join(agentDir, 'evidence', 'iteration-01', 'changed-files.json'),
          untracked_files_path: join(agentDir, 'evidence', 'iteration-01', 'untracked-files.json'),
          scope_report_path: join(agentDir, 'evidence', 'iteration-01', 'scope-report.json'),
          tracked_diff_path: join(agentDir, 'evidence', 'iteration-01', 'tracked.diff'),
          diff_metadata_path: join(agentDir, 'evidence', 'iteration-01', 'diff-metadata.json'),
          audit_report_path: join(projectRoot, '.agent/audit-report.md'),
          goal_digest: plannerValidation.goalDigest!,
          diff_digest: diffDigest,
        }),
        { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'auditor' },
      );
      auditorPrompt = promptResult.prompt;
      auditorPromptFile = promptResult.prompt_file_path ?? undefined;
    } catch (err) {
      await transitionToBlocked(stateStore, `Auditor prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
      return makeBlockedResult(runId, projectRoot, 'Auditor prompt build failed', 'CONFIG_ERROR', branchResult.branch_name);
    }

    // F-306R1 fix: Wrap Auditor execution in try/finally for prompt cleanup
    // F-306R2 fix: Check cleanup result — prompt deletion failure must BLOCKED.
    let auditorResult;
    let auditorCleanupResult: PromptCleanupResult | undefined;
    try {
      const auditorInput = buildAuditorInput({
        run_id: runId,
        iteration: 1,
        project_root: projectRoot,
        command_template: config.agents.auditor.command,
        timeout_seconds: config.agents.auditor.timeout_seconds,
        prompt: auditorPrompt,
        prompt_file: auditorPromptFile,
        signal: params.signal,
      });

      auditorResult = await runAgent(auditorInput, projectRoot);
    } finally {
      if (auditorPromptFile) auditorCleanupResult = await deletePromptFile(auditorPromptFile);
    }

    // F-306R2: Prompt cleanup failure is a security boundary — must BLOCKED
    if (auditorCleanupResult && !auditorCleanupResult.success) {
      await transitionToBlocked(stateStore, `Auditor prompt cleanup failed: ${auditorCleanupResult.error}`);
      return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${auditorCleanupResult.error}`, 'STATE_CONFLICT', branchResult.branch_name);
    }

    if (auditorResult.status !== 'success') {
      await transitionToBlocked(stateStore, `Auditor failed: ${auditorResult.error?.message ?? 'unknown'}`);
      await appendLog(artifactStore, runId, 1, 'AUDITING', 'auditor completed', 'FAIL', auditorResult.error?.message);
      return makeResult(runId, PhaseEnum.BLOCKED, 3, branchResult.branch_name, null, [], 'Fix Auditor configuration or check agent availability', `Auditor failed: ${auditorResult.error?.message ?? 'unknown'}`, auditorResult.error);
    }

    // F-307R2: Register Auditor agent log files in the orchestrator registry.
    // These are created by the Process Runner infrastructure, not by the Auditor agent itself.
    if (auditorResult.stdout_path && existsSync(auditorResult.stdout_path)) {
      const stdoutDigest = computeDigest(readFileSync(auditorResult.stdout_path, 'utf8'));
      orchestratorRegistry.register(auditorResult.stdout_path, stdoutDigest);
    }
    if (auditorResult.stderr_path && existsSync(auditorResult.stderr_path)) {
      const stderrDigest = computeDigest(readFileSync(auditorResult.stderr_path, 'utf8'));
      orchestratorRegistry.register(auditorResult.stderr_path, stderrDigest);
    }

    // Validate Auditor output
    const auditValidation = await validateAuditorOutput(
      projectRoot,
      runId,
      1,
      plannerValidation.goalDigest!,
      diffDigest,
      preAuditWorkspaceDigests,
    );

    if (!auditValidation.valid) {
      // Mechanical check failure overrides Auditor PASS
      if (auditValidation.decision === 'PASS') {
        await stateStore.transition(PhaseEnum.REWORKING);
        await appendLog(artifactStore, runId, 1, 'AUDITING', 'auditor completed', 'FAIL', `Mechanical check failure overrides PASS: ${auditValidation.errors.join('; ')}`);
        return makeResult(
          runId, PhaseEnum.REWORKING, 2, branchResult.branch_name, null, [],
          'Phase 4 or manual rework needed — mechanical check overrides Auditor PASS',
          `Mechanical check failure: ${auditValidation.errors.join('; ')}`,
          null,
        );
      }
      await transitionToBlocked(stateStore, `Auditor output validation failed: ${auditValidation.errors.join('; ')}`);
      await appendLog(artifactStore, runId, 1, 'AUDITING', 'auditor completed', 'FAIL', auditValidation.errors.join('; '));
      return makeBlockedResult(runId, projectRoot, `Auditor output invalid: ${auditValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', branchResult.branch_name);
    }

    // Process audit decision
    const decision = auditValidation.effectiveDecision ?? auditValidation.decision;

    if (decision === 'PASS') {
      await stateStore.transition(PhaseEnum.FINALIZING);
      await appendLog(artifactStore, runId, 1, 'AUDITING', 'auditor completed', 'PASS');
      return makeResult(
        runId, PhaseEnum.FINALIZING, 0, branchResult.branch_name, 'PASS',
        ['.agent/plan.md', '.agent/GOAL.md', '.agent/developer-handoff.md', '.agent/audit-report.md'],
        'Audit PASSED. Not yet committed — Phase 5 will handle finalization.',
        'Audit PASSED. Not yet committed.',
        null,
      );
    }

    if (decision === 'FAIL') {
      await stateStore.transition(PhaseEnum.REWORKING);
      await appendLog(artifactStore, runId, 1, 'AUDITING', 'auditor completed', 'FAIL');
      return makeResult(
        runId, PhaseEnum.REWORKING, 2, branchResult.branch_name, 'FAIL', [],
        'Phase 4 or manual rework needed — Auditor FAIL',
        'Auditor returned FAIL. Not yet committed.',
        null,
      );
    }

    // BLOCKED
    await transitionToBlocked(stateStore, 'Auditor returned BLOCKED');
    await appendLog(artifactStore, runId, 1, 'AUDITING', 'auditor completed', 'BLOCKED');
    return makeResult(
      runId, PhaseEnum.BLOCKED, 3, branchResult.branch_name, 'BLOCKED', [],
      'Resolve BLOCKED issue and retry',
      'Auditor returned BLOCKED.',
      null,
    );

  } catch (err) {
    if (stateStore) {
      try {
        await transitionToBlocked(stateStore, `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* best effort */ }
    }
    return makeBlockedResult(
      '', projectRoot,
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      'AGENT_ERROR',
    );
  } finally {
    if (lockManager) {
      try {
        // Try to read state for run_id, but fall back to the runId variable
        // which is always available in this scope. This ensures lock release
        // even when state.json is corrupted or deleted by a malicious agent.
        let releaseRunId = runId;
        try {
          const state = stateStore ? await stateStore.read() : null;
          if (state?.run_id) releaseRunId = state.run_id;
        } catch { /* state.json may be corrupted — use the runId we captured */ }
        await lockManager.release(releaseRunId);
      } catch { /* best effort */ }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * F-307R2: Orchestrator File Registry — explicit ownership tracking.
 * Every file the orchestrator writes is registered with its path and digest.
 * This replaces pattern-based inference of orchestrator-owned files,
 * preventing Developer from forging files under .agent/evidence/ etc.
 */
class OrchestratorFileRegistry {
  private entries: OrchestratorFileRegistryEntry[] = [];

  /**
   * Register a file that the orchestrator has written.
   * Records the absolute path, digest, and registration timestamp.
   */
  register(filePath: string, digest: string): void {
    // De-duplicate: if already registered, update the entry
    const existing = this.entries.findIndex(e => e.path === filePath);
    const entry: OrchestratorFileRegistryEntry = {
      path: filePath,
      digest,
      registered_at: new Date().toISOString(),
    };
    if (existing >= 0) {
      this.entries[existing] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  /**
   * Get all registered file paths (posix-relative to project root).
   */
  getRelativePaths(projectRoot: string): string[] {
    return this.entries.map(e => {
      const rel = e.path.startsWith(projectRoot)
        ? e.path.slice(projectRoot.length + 1)
        : e.path;
      return rel.split(sep).join('/');
    });
  }

  /**
   * Get all registered entries.
   */
  getEntries(): ReadonlyArray<OrchestratorFileRegistryEntry> {
    return this.entries;
  }
}

/**
 * F-307R2: Verify all system-protected paths after Developer call.
 * Checks:
 * 1. All registered orchestrator files still exist with matching digests
 * 2. No new files appeared in system-protected directories that weren't registered
 * 3. No files were deleted from system-protected directories
 * 4. No mode/symlink changes on registered files
 *
 * Only `.agent/developer-handoff.md` is allowed to be written by Developer.
 */
async function verifySystemProtectedPaths(
  projectRoot: string,
  registry: OrchestratorFileRegistry,
  preDevSystemPaths: Map<string, { digest: string; mode: number; isSymlink: boolean }>,
): Promise<OrchestratorRegistryVerificationResult> {
  const violations: OrchestratorRegistryViolation[] = [];
  const agentDir = join(projectRoot, '.agent');

  // 1. Verify all registered files that existed before Developer are intact.
  //    Files registered AFTER Developer (evidence, scope report, etc.) are not checked
  //    for digest match because the orchestrator itself modifies them after registration.
  //    We only check that Developer didn't delete or symlink-replace them.
  for (const entry of registry.getEntries()) {
    // Skip digest check for files not in preDevSystemPaths — they were registered
    // after Developer ran (evidence files, scope reports, etc.) and the orchestrator
    // may have modified them since registration.
    const existedBeforeDev = preDevSystemPaths.has(entry.path);

    if (!existsSync(entry.path)) {
      // Only report deletion for files that existed before Developer
      if (existedBeforeDev) {
        violations.push({
          path: entry.path,
          violation: 'deleted',
          message: `Orchestrator-registered file was deleted: ${entry.path}`,
        });
      }
      continue;
    }

    // Check for symlink creation (file was not a symlink before)
    const preDev = preDevSystemPaths.get(entry.path);
    if (preDev && !preDev.isSymlink) {
      try {
        const stat = lstatSync(entry.path);
        if (stat.isSymbolicLink()) {
          violations.push({
            path: entry.path,
            violation: 'symlink_created',
            message: `Orchestrator-registered file was replaced with symlink: ${entry.path}`,
          });
          continue;
        }
      } catch {
        violations.push({
          path: entry.path,
          violation: 'deleted',
          message: `Cannot stat orchestrator-registered file: ${entry.path}`,
        });
        continue;
      }
    }

    // Check digest only for files that existed before Developer
    if (existedBeforeDev && preDev) {
      try {
        const currentDigest = computeDigest(readFileSync(entry.path, 'utf8'));
        if (currentDigest !== preDev.digest) {
          violations.push({
            path: entry.path,
            violation: 'digest_mismatch',
            message: `Orchestrator-registered file was modified: ${entry.path}`,
          });
        }
      } catch {
        violations.push({
          path: entry.path,
          violation: 'deleted',
          message: `Cannot read orchestrator-registered file: ${entry.path}`,
        });
      }
    }
  }

  // 2. Verify all pre-Developer system-protected paths still exist with matching digests
  //    (catches deletion of files that existed before Developer but aren't in the registry)
  for (const [filePath, preDevInfo] of preDevSystemPaths) {
    // Skip developer-handoff.md — Developer is allowed to write this
    const relPath = filePath.startsWith(projectRoot)
      ? filePath.slice(projectRoot.length + 1).split(sep).join('/')
      : filePath;
    if (relPath === '.agent/developer-handoff.md') continue;

    // Skip if already checked as a registered file
    if (registry.getEntries().some(e => e.path === filePath)) continue;

    if (!existsSync(filePath)) {
      violations.push({
        path: filePath,
        violation: 'deleted',
        message: `System-protected file was deleted: ${filePath}`,
      });
      continue;
    }

    // Check for symlink creation
    if (!preDevInfo.isSymlink) {
      try {
        const stat = lstatSync(filePath);
        if (stat.isSymbolicLink()) {
          violations.push({
            path: filePath,
            violation: 'symlink_created',
            message: `System-protected file was replaced with symlink: ${filePath}`,
          });
          continue;
        }
      } catch {
        // File might have been deleted between existsSync and lstatSync
        continue;
      }
    }

    // Check digest
    try {
      const currentDigest = computeDigest(readFileSync(filePath, 'utf8'));
      if (currentDigest !== preDevInfo.digest) {
        violations.push({
          path: filePath,
          violation: 'digest_mismatch',
          message: `System-protected file was modified: ${filePath}`,
        });
      }
    } catch {
      violations.push({
        path: filePath,
        violation: 'deleted',
        message: `Cannot read system-protected file: ${filePath}`,
      });
    }
  }

  // 3. Scan system-protected directories for new unregistered files
  const protectedDirs = [
    join(agentDir, 'evidence'),
    join(agentDir, 'verification'),
    join(agentDir, 'history'),
    join(agentDir, 'debug'),
  ];

  const registeredPaths = new Set(registry.getEntries().map(e => e.path));
  const preDevPaths = new Set(preDevSystemPaths.keys());

  for (const dir of protectedDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { recursive: true, withFileTypes: false });
      for (const entry of entries) {
        const fullPath = join(dir, String(entry));
        // Skip directories
        if (!existsSync(fullPath)) continue;
        try {
          const stat = lstatSync(fullPath);
          if (stat.isDirectory()) continue;
        } catch { continue; }

        // Check if this file was registered by the orchestrator or existed before Developer
        if (!registeredPaths.has(fullPath) && !preDevPaths.has(fullPath)) {
          violations.push({
            path: fullPath,
            violation: 'unregistered_new',
            message: `New file in system-protected directory not registered by orchestrator: ${fullPath}`,
          });
        }
      }
    } catch {
      // Cannot read directory — skip
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

function generateRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function sanitizeSlug(request: string): string {
  // First try: extract ASCII-safe segments
  const asciiSlug = request
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

  if (asciiSlug.length > 0) {
    return asciiSlug;
  }

  // F-308 fix: For non-ASCII input (Chinese, emoji, etc.), generate a stable
  // non-empty slug from a short hash of the request content.
  const hash = createHash('sha256').update(request, 'utf8').digest('hex');
  return `task-${hash.slice(0, 12)}`;
}

async function transitionToBlocked(stateStore: StateStore, reason: string): Promise<void> {
  try {
    await stateStore.update(() => ({ last_error: reason }));
    await stateStore.transition(PhaseEnum.BLOCKED);
  } catch { /* best effort */ }
}

async function appendLog(
  artifactStore: ArtifactStore,
  runId: string,
  iteration: number,
  phase: string,
  event: string,
  result: 'PASS' | 'FAIL' | 'BLOCKED' | 'TIMEOUT' | 'CANCELLED',
  detail?: string,
): Promise<void> {
  try {
    const entry: IterationLogEntry = {
      timestamp: new Date().toISOString(),
      run_id: runId,
      iteration,
      phase: phase as IterationLogEntry['phase'],
      event,
      result,
      ...(detail ? { detail } : {}),
    };
    // ArtifactStore.appendIterationLog expects a string
    await artifactStore.appendIterationLog(JSON.stringify(entry));
  } catch { /* log failure should not block */ }
}

function computeDigest(content: string): Digest {
  return computeDigestLib(content);
}

function makeResult(
  runId: string,
  phase: Phase,
  exitCode: number,
  branch: string,
  auditDecision: string | null,
  artifactPaths: string[],
  nextAction: string,
  message: string,
  error: ReviewLoopError | null,
): OrchestratorResult {
  return {
    run_id: runId,
    phase,
    exit_code: exitCode,
    branch,
    audit_decision: auditDecision,
    artifact_paths: artifactPaths,
    next_action: nextAction,
    message,
    error,
  };
}

function makeBlockedResult(
  runId: string,
  _projectRoot: string,
  message: string,
  code: ErrorCategory,
  branch?: string,
): OrchestratorResult {
  return makeResult(
    runId,
    PhaseEnum.BLOCKED,
    3,
    branch ?? '',
    null,
    [],
    'Resolve BLOCKED issue and retry',
    message,
    {
      code,
      message,
      resumable: false,
      suggested_action: 'Check configuration and try again',
    },
  );
}
