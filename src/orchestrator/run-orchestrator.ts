/**
 * Run Orchestrator — multi-round orchestration loop with auto-rework.
 * Phase 4 §12: INITIALIZING → PLANNING → [DEVELOPING → VERIFYING → AUDITING]* → FINALIZING/FAILED/BLOCKED/CANCELLED
 *
 * Phase 4 capabilities:
 * - Automatic multi-round rework loop (up to max_iterations)
 * - Per-iteration history archiving
 * - Cancel request detection
 * - Rework instructions generation
 *
 * Phase 4 constraints (NOT Phase 5/6):
 * - No final audit, no auto commit/tag/push
 * - No GUI, no plugin packaging, no destructive git cleanup
 */

import { join, resolve, sep } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StateStore } from './state-store.js';
import { LockManager } from '../runtime/lock-manager.js';
import { ArtifactStore, ARTIFACT_FILES } from '../artifacts/artifact-store.js';
import { loadConfigWithDefaults } from '../artifacts/config.js';
import type { ReviewLoopConfig, ReworkFinding, CancelRequest } from '../types.js';
import { preflight, createTaskBranch } from '../git/git-manager.js';
import { collectDiff, writeDiffArtifacts } from '../git/diff-collector.js';
import { checkScope, writeScopeReport } from '../scope/scope-guard.js';
import { runVerification } from '../verification/verification-runner.js';
import { computeDigest as computeDigestLib, type Digest } from '../runtime/digest.js';
import { buildPlannerPrompt, buildDeveloperPrompt, buildReworkPrompt, buildAuditorPrompt, buildPrompt, deletePromptFile, type PromptCleanupResult } from '../agents/prompt-builder.js';
import { buildPlannerInput, validatePlannerOutput, snapshotWorkspaceBeforePlanner, validatePlannerWorkspaceOwnership } from '../agents/planner-adapter.js';
import { buildDeveloperInput, validateDeveloperOutput } from '../agents/developer-adapter.js';
import { buildAuditorInput, validateAuditorOutput } from '../agents/auditor-adapter.js';
import { runAgent } from '../agents/agent-adapter.js';
import { buildReworkInstructions, writeReworkInstructions, buildReworkFindingsFromScope, buildReworkFindingsFromVerification, buildReworkFindingsFromAudit } from './rework-instructions.js';
import { validateCancelRequest } from '../artifacts/json-schemas.js';
import type {
  Phase,
  ReviewLoopError,
  ErrorCategory,
  IterationLogEntry,
  OrchestratorFileRegistryEntry,
  OrchestratorRegistryVerificationResult,
  OrchestratorRegistryViolation,
  ScopeReportV2,
  VerificationManifest,
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
/** Resume context — passed when resuming an interrupted run. */
export interface ResumeContext {
  run_id: string;
  iteration: number;
  phase: Phase;
  branch: string;
  base_commit: string;
  task_slug: string;
  goal_digest: string | null;
}

export async function runOrchestrator(params: {
  project_root: string;
  request?: string;
  task_slug?: string;
  max_iterations?: number;
  config_path?: string;
  no_commit?: boolean;
  tag?: boolean;
  signal?: AbortSignal;
  resume_from?: ResumeContext;
}): Promise<OrchestratorResult> {
  const projectRoot = resolve(params.project_root);
  const agentDir = join(projectRoot, '.agent');
  let lockManager: LockManager | null = null;
  let stateStore: StateStore | null = null;
  let runId = ''; // Declared at function scope so finally block can access it

  // F-402: Create AbortController for SIGTERM handling.
  // When SIGTERM is received, we write cancel-request.json and abort the signal,
  // which propagates to all agent calls. The orchestrator loop will then detect
  // the cancel request and transition to CANCELLED cleanly.
  const abortController = new AbortController();
  const combinedSignal = abortController.signal;

  // If the caller provided an external signal, chain it
  if (params.signal) {
    params.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const sigtermHandler = () => {
    // Write cancel-request.json so the orchestrator loop can detect it
    try {
      const cancelRequest: CancelRequest = {
        schema_version: 1,
        run_id: runId || 'unknown',
        requested_at: new Date().toISOString(),
        requested_by: `signal:SIGTERM:${process.pid}`,
      };
      const cancelPath = join(agentDir, 'cancel-request.json');
      writeFileSync(cancelPath, JSON.stringify(cancelRequest, null, 2), 'utf8');
    } catch { /* best effort */ }
    abortController.abort();
  };

  process.on('SIGTERM', sigtermHandler);

  try {
    // ═══════════════════════════════════════════════════════════
    // §12.1 INITIALIZING
    // ═══════════════════════════════════════════════════════════

    if (!existsSync(projectRoot)) {
      return makeBlockedResult('', projectRoot, `Project root does not exist: ${projectRoot}`, 'CONFIG_ERROR');
    }

    // 2. Load configuration
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

    // ── Resume path ──────────────────────────────────────────
    // F-401: When resume_from is provided, skip INITIALIZING/PLANNING
    // and re-enter the iteration loop from the saved phase/iteration.
    if (params.resume_from) {
      const resume = params.resume_from;

      // Acquire lock for the resumed run
      lockManager = new LockManager(agentDir);
      runId = resume.run_id;
      try {
        await lockManager.acquire(runId);
      } catch (err) {
        return makeBlockedResult(runId, projectRoot, `Lock acquisition failed on resume: ${err instanceof Error ? err.message : String(err)}`, 'STATE_CONFLICT');
      }

      // Load existing state
      stateStore = new StateStore(agentDir);

      // F-403: Resume consistency checks — verify git branch and GOAL digest
      // Check current Git branch matches state.branch
      try {
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: projectRoot,
          encoding: 'utf8',
        }).trim();
        if (currentBranch !== resume.branch) {
          await transitionToBlocked(stateStore, `Resume branch mismatch: current=${currentBranch}, expected=${resume.branch}`);
          return makeBlockedResult(runId, projectRoot, `Current Git branch (${currentBranch}) does not match state.branch (${resume.branch})`, 'STATE_CONFLICT');
        }
      } catch {
        return makeBlockedResult(runId, projectRoot, 'Cannot determine current Git branch', 'PREFLIGHT_ERROR');
      }

      // Check base_commit still exists
      try {
        execSync(`git cat-file -t ${resume.base_commit}`, { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
      } catch {
        await transitionToBlocked(stateStore, `base_commit ${resume.base_commit} no longer exists`);
        return makeBlockedResult(runId, projectRoot, `base_commit ${resume.base_commit} no longer exists`, 'STATE_CONFLICT');
      }

      // Check GOAL.md digest matches
      const goalPath = join(agentDir, 'GOAL.md');
      if (!existsSync(goalPath)) {
        await transitionToBlocked(stateStore, 'GOAL.md missing — cannot resume');
        return makeBlockedResult(runId, projectRoot, 'GOAL.md missing — cannot resume', 'ARTIFACT_ERROR');
      }

      if (resume.goal_digest) {
        try {
          const goalContent = readFileSync(goalPath, 'utf8');
          const currentDigest = computeDigest(goalContent);
          if (currentDigest !== resume.goal_digest) {
            await transitionToBlocked(stateStore, 'GOAL.md digest mismatch on resume');
            return makeBlockedResult(runId, projectRoot, 'GOAL.md digest does not match state.goal_digest', 'STATE_CONFLICT');
          }
        } catch {
          return makeBlockedResult(runId, projectRoot, 'Cannot read GOAL.md to verify digest', 'ARTIFACT_ERROR');
        }
      }

      const goalValidation = validatePlannerOutput(projectRoot, runId);
      if (!goalValidation.valid) {
        await transitionToBlocked(stateStore, `GOAL.md validation failed on resume: ${goalValidation.errors.join('; ')}`);
        return makeBlockedResult(runId, projectRoot, `GOAL.md invalid on resume: ${goalValidation.errors.join('; ')}`, 'ARTIFACT_ERROR');
      }

      const goalFm = goalValidation.goalFrontMatter!;
      const verificationCommands = goalValidation.verificationCommands!;
      const goalDigest = goalValidation.goalDigest ?? resume.goal_digest ?? '';
      const currentBranch = resume.branch;
      const baseCommit = resume.base_commit;
      const maxIterations = params.max_iterations ?? config.loop.max_iterations;

      // Rebuild orchestrator registry from existing files
      const orchestratorRegistry = new OrchestratorFileRegistry();
      const registryDirs = [
        agentDir,
        join(agentDir, 'evidence'),
        join(agentDir, 'verification'),
        join(agentDir, 'history'),
        join(agentDir, 'debug'),
      ];
      for (const dir of registryDirs) {
        registerDirectoryFiles(dir, orchestratorRegistry);
      }
      // Register key individual files
      for (const f of ['state.json', 'run.lock', 'plan.md', 'GOAL.md', 'iteration-log.md', 'audit-report.md', 'rework-instructions.md', 'developer-handoff.md']) {
        const fp = join(agentDir, f);
        if (existsSync(fp)) {
          try {
            const d = computeDigest(readFileSync(fp, 'utf8'));
            orchestratorRegistry.register(fp, d);
          } catch { /* skip */ }
        }
      }

      // Determine the starting iteration based on the phase
      const startIteration = resume.iteration;
      // If we're resuming from VERIFYING or AUDITING, we re-run the current iteration
      // If from DEVELOPING/REWORKING, we also re-run the current iteration's developer
      // The loop will handle the phase-specific logic

      await appendLog(artifactStore, runId, startIteration, 'RESUMING', 'resume start', 'PASS', `Resuming from ${resume.phase} at iteration ${startIteration}`);

      // Enter the iteration loop at the recovered point
      // We skip the first `iteration > 1` rework setup since we're resuming mid-iteration
      return await runIterationLoop({
        projectRoot,
        agentDir,
        runId,
        stateStore,
        artifactStore,
        orchestratorRegistry,
        config,
        currentBranch,
        baseCommit,
        goalFm,
        verificationCommands,
        goalDigest,
        maxIterations,
        startIteration,
        resumePhase: resume.phase,
        combinedSignal,
      });
    }

    // ── Normal (non-resume) path ─────────────────────────────

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
    const taskSlug = params.task_slug || sanitizeSlug(params.request ?? 'resume');

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
          user_request: params.request ?? '',
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
        signal: combinedSignal,
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
    // §12.3–12.5 ITERATION LOOP (Phase 4: auto-rework)
    // ═══════════════════════════════════════════════════════════

    const currentBranch = branchResult.branch_name;
    const goalFm = plannerValidation.goalFrontMatter!;
    const verificationCommands = plannerValidation.verificationCommands!;
    const goalDigest = plannerValidation.goalDigest!;

    return await runIterationLoop({
      projectRoot,
      agentDir,
      runId,
      stateStore,
      artifactStore,
      orchestratorRegistry,
      config,
      currentBranch,
      baseCommit,
      goalFm,
      verificationCommands,
      goalDigest,
      maxIterations: params.max_iterations ?? config.loop.max_iterations,
      startIteration: 1,
      resumePhase: undefined,
      combinedSignal,
    });

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
    // F-402: Remove SIGTERM handler to avoid leaking listeners
    process.off('SIGTERM', sigtermHandler);

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

// ─── Iteration Loop ────────────────────────────────────────────

/** Parameters for the iteration loop, shared between normal and resume paths. */
interface IterationLoopParams {
  projectRoot: string;
  agentDir: string;
  runId: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  goalFm: import('../types.js').GoalFrontMatter;
  verificationCommands: import('../types.js').VerificationCommand[];
  goalDigest: string;
  maxIterations: number;
  startIteration: number;
  resumePhase?: Phase;
  combinedSignal: AbortSignal;
}

/**
 * Run the iteration loop — DEVELOPING → VERIFYING → AUDITING per iteration,
 * with auto-rework on failure.
 *
 * When `resumePhase` is set, the loop starts at that phase for the
 * `startIteration` iteration, skipping phases that have already completed.
 */
async function runIterationLoop(params: IterationLoopParams): Promise<OrchestratorResult> {
  const {
    projectRoot, agentDir, runId, stateStore, artifactStore,
    orchestratorRegistry, config, currentBranch, baseCommit,
    goalFm, verificationCommands, goalDigest, maxIterations,
    startIteration, resumePhase, combinedSignal,
  } = params;

  for (let iteration = startIteration; iteration <= maxIterations; iteration++) {
    // ── Cancel check at top of iteration ──
    const cancelReq = await checkCancelRequest(agentDir);
    if (cancelReq) {
      await stateStore.update(() => ({ cancel_requested_at: cancelReq.requested_at }));
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'cancel requested', 'CANCELLED');
      return makeResult(
        runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [],
        'Run cancelled by user request',
        `Cancel requested at ${cancelReq.requested_at}`,
        null,
      );
    }

    // ── DEVELOPING (or REWORKING for iteration > 1) ──

    if (iteration > 1) {
      // Archive previous iteration history
      if (config.loop.archive_history) {
        // F-406: Verify idempotency before archiving.
        const preArchiveDigests: Record<string, string> = {};
        const handoffPath = join(agentDir, ARTIFACT_FILES.HANDOFF);
        if (existsSync(handoffPath)) {
          preArchiveDigests[ARTIFACT_FILES.HANDOFF] = computeDigest(readFileSync(handoffPath, 'utf8'));
        }
        const auditPath = join(agentDir, ARTIFACT_FILES.AUDIT_REPORT);
        if (existsSync(auditPath)) {
          preArchiveDigests[ARTIFACT_FILES.AUDIT_REPORT] = computeDigest(readFileSync(auditPath, 'utf8'));
        }
        const reworkInstrPath = join(agentDir, ARTIFACT_FILES.REWORK_INSTRUCTIONS);
        if (existsSync(reworkInstrPath)) {
          preArchiveDigests[ARTIFACT_FILES.REWORK_INSTRUCTIONS] = computeDigest(readFileSync(reworkInstrPath, 'utf8'));
        }

        const idempotency = await artifactStore.verifyArchiveIdempotent(iteration - 1, preArchiveDigests);
        if (!idempotency.safe) {
          await transitionToBlocked(stateStore, `Archive idempotency violation for iteration ${iteration - 1}: ${idempotency.reason}`);
          return makeBlockedResult(
            runId, projectRoot,
            `Cannot safely archive iteration ${iteration - 1}: ${idempotency.reason}`,
            'STATE_CONFLICT',
            currentBranch,
          );
        }

        await artifactStore.archiveIterationFull(iteration - 1);

        // Register all archived files in the orchestrator registry
        const prevIterStr = String(iteration - 1).padStart(2, '0');
        const historyIterDir = join(agentDir, 'history', `iteration-${prevIterStr}`);
        registerDirectoryFiles(historyIterDir, orchestratorRegistry);
      }

      // Build rework findings from the previous iteration's failures
      const reworkFindings: ReworkFinding[] = [];
      const evidencePaths: string[] = [];
      const reworkVerificationCommands: string[] = [];

      const prevScopeReportPath = join(agentDir, 'evidence', `iteration-${String(iteration - 1).padStart(2, '0')}`, 'scope-report.json');
      if (existsSync(prevScopeReportPath)) {
        try {
          const scopeReportData = JSON.parse(readFileSync(prevScopeReportPath, 'utf8'));
          if (validateScopeReportData(scopeReportData)) {
            reworkFindings.push(...buildReworkFindingsFromScope(scopeReportData as ScopeReportV2, iteration, projectRoot));
            evidencePaths.push(prevScopeReportPath);
          }
        } catch { /* skip invalid scope report */ }
      }

      const prevManifestPath = join(agentDir, 'verification', 'manifest.json');
      if (existsSync(prevManifestPath)) {
        try {
          const manifestData = JSON.parse(readFileSync(prevManifestPath, 'utf8'));
          reworkFindings.push(...buildReworkFindingsFromVerification(manifestData as VerificationManifest, iteration));
          evidencePaths.push(prevManifestPath);
        } catch { /* skip invalid manifest */ }
      }

      const prevAuditPath = join(agentDir, 'audit-report.md');
      if (existsSync(prevAuditPath)) {
        try {
          const auditContent = readFileSync(prevAuditPath, 'utf8');
          reworkFindings.push(...buildReworkFindingsFromAudit(auditContent, iteration));
          evidencePaths.push(prevAuditPath);
        } catch { /* skip invalid audit report */ }
      }

      for (const cmd of verificationCommands) {
        reworkVerificationCommands.push(cmd.argv.join(' '));
      }

      const reworkSource = reworkFindings.length > 0
        ? reworkFindings[0].source
        : 'audit' as const;

      const reworkContent = buildReworkInstructions({
        run_id: runId,
        iteration,
        source: reworkSource,
        findings: reworkFindings,
        goal_path: join(projectRoot, '.agent/GOAL.md'),
        evidence_paths: evidencePaths,
        verification_commands: reworkVerificationCommands,
        project_root: projectRoot,
      });
      await writeReworkInstructions(projectRoot, reworkContent);

      const reworkInstrPath = join(agentDir, 'rework-instructions.md');
      if (existsSync(reworkInstrPath)) {
        const reworkDigest = computeDigest(readFileSync(reworkInstrPath, 'utf8'));
        orchestratorRegistry.register(reworkInstrPath, reworkDigest);
      }

      await stateStore.update(() => ({ iteration }));
      const currentState = await stateStore.read();
      if (currentState.phase !== PhaseEnum.REWORKING) {
        await stateStore.transition(PhaseEnum.REWORKING);
        await appendLog(artifactStore, runId, iteration, 'REWORKING', 'rework start', 'PASS');
      }

      await stateStore.transition(PhaseEnum.DEVELOPING);
      await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer rework start', 'PASS');
    }

    // ── Skip DEVELOPING if resuming from VERIFYING or AUDITING ──
    const skipDeveloper = resumePhase === PhaseEnum.VERIFYING || resumePhase === PhaseEnum.AUDITING;
    // Only skip for the first iteration of a resume
    const shouldSkipDeveloper = skipDeveloper && iteration === startIteration;

    // ── Skip VERIFYING if resuming from AUDITING ──
    // When resuming from AUDITING, verification has already passed — go straight to auditing
    const shouldSkipVerifying = resumePhase === PhaseEnum.AUDITING && iteration === startIteration;

    if (!shouldSkipDeveloper) {
      // Record plan/GOAL digests before Developer
      const preDevPlanDigest = computeDigest(readFileSync(join(projectRoot, '.agent/plan.md'), 'utf8'));
      const preDevGoalDigest = computeDigest(readFileSync(join(projectRoot, '.agent/GOAL.md'), 'utf8'));

      const preDevSystemPaths = snapshotSystemPaths(agentDir);

      // Build Developer prompt (initial or rework)
      let developerPrompt: string;
      let developerPromptFile: string | undefined;
      try {
        if (iteration === 1) {
          const promptResult = await buildPrompt(
            projectRoot,
            'developer.md',
            (template) => buildDeveloperPrompt(template, {
              run_id: runId,
              iteration,
              project_root: projectRoot,
              plan_path: join(projectRoot, '.agent/plan.md'),
              goal_path: join(projectRoot, '.agent/GOAL.md'),
              handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
            }),
            { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'developer' },
          );
          developerPrompt = promptResult.prompt;
          developerPromptFile = promptResult.prompt_file_path ?? undefined;
        } else {
          const promptResult = await buildPrompt(
            projectRoot,
            'rework.md',
            (template) => buildReworkPrompt(template, {
              run_id: runId,
              iteration,
              project_root: projectRoot,
              goal_path: join(projectRoot, '.agent/GOAL.md'),
              rework_instructions_path: join(projectRoot, '.agent/rework-instructions.md'),
              handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
            }),
            { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'developer-rework' },
          );
          developerPrompt = promptResult.prompt;
          developerPromptFile = promptResult.prompt_file_path ?? undefined;
        }
      } catch (err) {
        await transitionToBlocked(stateStore, `Developer prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
        return makeBlockedResult(runId, projectRoot, 'Developer prompt build failed', 'CONFIG_ERROR', currentBranch);
      }

      const preDevCancel = await checkCancelRequest(agentDir);
      if (preDevCancel) {
        await stateStore.update(() => ({ cancel_requested_at: preDevCancel.requested_at }));
        await stateStore.transition(PhaseEnum.CANCELLED);
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'cancel requested', 'CANCELLED');
        return makeResult(
          runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [],
          'Run cancelled by user request',
          `Cancel requested at ${preDevCancel.requested_at}`,
          null,
        );
      }

      let developerResult;
      let developerCleanupResult: PromptCleanupResult | undefined;
      try {
        const developerInput = buildDeveloperInput({
          run_id: runId,
          iteration,
          project_root: projectRoot,
          command_template: config.agents.developer.command,
          timeout_seconds: config.agents.developer.timeout_seconds,
          prompt: developerPrompt,
          prompt_file: developerPromptFile,
          signal: combinedSignal,
        });

        developerResult = await runAgent(developerInput, projectRoot);
      } finally {
        if (developerPromptFile) developerCleanupResult = await deletePromptFile(developerPromptFile);
      }

      if (developerCleanupResult && !developerCleanupResult.success) {
        await transitionToBlocked(stateStore, `Developer prompt cleanup failed: ${developerCleanupResult.error}`);
        return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${developerCleanupResult.error}`, 'STATE_CONFLICT', currentBranch);
      }

      if (developerResult.status !== 'success') {
        await transitionToBlocked(stateStore, `Developer failed: ${developerResult.error?.message ?? 'unknown'}`);
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'FAIL', developerResult.error?.message);
        return makeResult(runId, PhaseEnum.BLOCKED, 3, currentBranch, null, [], 'Fix Developer configuration or check agent availability', `Developer failed: ${developerResult.error?.message ?? 'unknown'}`, developerResult.error);
      }

      registerAgentLogs(developerResult, orchestratorRegistry);

      const registryVerification = await verifySystemProtectedPaths(
        projectRoot,
        orchestratorRegistry,
        preDevSystemPaths,
      );

      if (!registryVerification.valid) {
        const violationMsgs = registryVerification.violations.map(v => v.message).join('; ');
        await transitionToBlocked(stateStore, `Developer tampered with system-protected paths: ${violationMsgs}`);
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'system path integrity', 'FAIL', violationMsgs);
        return makeBlockedResult(
          runId, projectRoot,
          `Developer tampered with system-protected paths: ${violationMsgs}`,
          'STATE_CONFLICT',
          currentBranch,
        );
      }

      const developerValidation = validateDeveloperOutput(
        projectRoot,
        runId,
        iteration,
        preDevPlanDigest,
        preDevGoalDigest,
      );

      if (!developerValidation.valid) {
        await transitionToBlocked(stateStore, `Developer output validation failed: ${developerValidation.errors.join('; ')}`);
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'FAIL', developerValidation.errors.join('; '));
        return makeBlockedResult(runId, projectRoot, `Developer output invalid: ${developerValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', currentBranch);
      }

      if (developerValidation.isBlocked) {
        await transitionToBlocked(stateStore, 'Developer reported BLOCKED');
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'BLOCKED', 'Developer reported BLOCKED');
        return makeResult(runId, PhaseEnum.BLOCKED, 3, currentBranch, null, [], 'Resolve Developer BLOCKED issue and retry', 'Developer reported BLOCKED', null);
      }

      await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'PASS');
    }

    // ── VERIFYING ──
    // Skip verification when resuming from AUDITING (verification already passed)
    // When skipping, we still need diffResult and diffDigest for the auditing phase,
    // so we collect them from existing evidence files.
    let diffResult: Awaited<ReturnType<typeof collectDiff>>;
    let diffDigest: string;
    const scopeReportPath = join(agentDir, 'evidence', `iteration-${String(iteration).padStart(2, '0')}`, 'scope-report.json');

    if (!shouldSkipVerifying) {

    // Only transition if not already in VERIFYING (e.g. on resume)
    const preVerifyState = await stateStore.read();
    if (preVerifyState.phase !== PhaseEnum.VERIFYING) {
      await stateStore.transition(PhaseEnum.VERIFYING);
    }
    await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'verification start', 'PASS');

    diffResult = await collectDiff({
      projectRoot,
      baseCommit,
      iteration,
    });

    await writeDiffArtifacts(projectRoot, iteration, diffResult);

    registerDirectoryFiles(join(agentDir, 'evidence', `iteration-${String(iteration).padStart(2, '0')}`), orchestratorRegistry);

    const orchestratorOwnedFiles = orchestratorRegistry.getRelativePaths(projectRoot);
    const scopeResult = checkScope({
      allowedChanges: goalFm.allowed_changes,
      disallowedChanges: goalFm.disallowed_changes,
      changedFiles: diffResult.changedFiles,
      orchestratorOwnedFiles,
    });

    await writeScopeReport(projectRoot, iteration, scopeResult.report);

    if (existsSync(scopeReportPath)) {
      const scopeReportDigest = computeDigest(readFileSync(scopeReportPath, 'utf8'));
      orchestratorRegistry.register(scopeReportPath, scopeReportDigest);
    }

    if (!scopeResult.passed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const deniedPaths = scopeResult.report.denied.map(d => d.path).join(', ');
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'scope result', 'FAIL', `Denied: ${deniedPaths}`);

      if (iteration >= maxIterations) {
        await stateStore.transition(PhaseEnum.FAILED);
        return makeResult(
          runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
          'Max iterations reached — scope violation persists',
          `Scope violation after ${maxIterations} iterations: ${scopeResult.report.denied.map(d => `${d.path} (${d.reason})`).join(', ')}`,
          null,
        );
      }

      continue;
    }

    await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'scope result', 'PASS');

    const verificationResult = await runVerification({
      commands: verificationCommands,
      projectRoot,
      runId,
      iteration,
    });

    registerDirectoryFiles(join(agentDir, 'verification', `iteration-${String(iteration).padStart(2, '0')}`), orchestratorRegistry);

    const requiredPassed = verificationResult.manifest.commands
      .filter(c => c.required)
      .every(c => c.status === 'success');

    if (!requiredPassed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const failedCmds = verificationResult.manifest.commands
        .filter(c => c.required && c.status !== 'success')
        .map(c => c.id);
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'verification result', 'FAIL', `Failed: ${failedCmds.join(', ')}`);

      if (iteration >= maxIterations) {
        await stateStore.transition(PhaseEnum.FAILED);
        return makeResult(
          runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
          'Max iterations reached — required verification still fails',
          `Required verification failed after ${maxIterations} iterations: ${failedCmds.join(', ')}`,
          null,
        );
      }

      continue;
    }

    const allPassed = verificationResult.passed;
    await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'verification result', allPassed ? 'PASS' : 'FAIL');

    const verificationManifestPath = join(agentDir, 'verification', 'manifest.json');
    if (existsSync(verificationManifestPath)) {
      const manifestDigest = computeDigest(readFileSync(verificationManifestPath, 'utf8'));
      orchestratorRegistry.register(verificationManifestPath, manifestDigest);
    }

    // Set diffDigest after verification passes (used by auditing phase)
    diffDigest = `sha256:${diffResult.diffDigest}` as Digest;

    } else {
      // When skipping verification (resume from AUDITING), re-collect diff for auditing
      diffResult = await collectDiff({ projectRoot, baseCommit, iteration });
      diffDigest = `sha256:${diffResult.diffDigest}` as Digest;
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'verification skipped (resume)', 'PASS');
    }

    // ── AUDITING ──
    // diffResult and diffDigest are already set by either the VERIFYING block or the skip-else above.
    // Re-collect diff for post-verification scope check (files may have changed between verification and audit).
    const postVerificationDiffResult = await collectDiff({
      projectRoot,
      baseCommit,
      iteration,
    });
    await writeDiffArtifacts(projectRoot, iteration, postVerificationDiffResult);

    registerDirectoryFiles(join(agentDir, 'evidence', `iteration-${String(iteration).padStart(2, '0')}`), orchestratorRegistry);

    const postVerificationOrchestratorOwned = orchestratorRegistry.getRelativePaths(projectRoot);
    const postVerificationScopeResult = checkScope({
      allowedChanges: goalFm.allowed_changes,
      disallowedChanges: goalFm.disallowed_changes,
      changedFiles: postVerificationDiffResult.changedFiles,
      orchestratorOwnedFiles: postVerificationOrchestratorOwned,
    });
    await writeScopeReport(projectRoot, iteration, postVerificationScopeResult.report);

    if (existsSync(scopeReportPath)) {
      const scopeReportDigest = computeDigest(readFileSync(scopeReportPath, 'utf8'));
      orchestratorRegistry.register(scopeReportPath, scopeReportDigest);
    }

    if (!postVerificationScopeResult.passed) {
      await stateStore.transition(PhaseEnum.REWORKING);
      const deniedPaths = postVerificationScopeResult.report.denied.map(d => d.path).join(', ');
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'post-verification scope', 'FAIL', `Denied: ${deniedPaths}`);

      if (iteration >= maxIterations) {
        await stateStore.transition(PhaseEnum.FAILED);
        return makeResult(
          runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
          'Max iterations reached — post-verification scope violation persists',
          `Post-verification scope violation after ${maxIterations} iterations: ${deniedPaths}`,
          null,
        );
      }

      continue;
    }

    // Use diffDigest from VERIFYING phase (already set above)
    await stateStore.update(() => ({ audited_diff_digest: diffDigest }));

    // Skip auditor if resuming from AUDITING and we want to re-run it
    // (we always re-run the auditor on resume from AUDITING)
    // Only transition if not already in AUDITING (e.g. on resume)
    const preAuditState = await stateStore.read();
    if (preAuditState.phase !== PhaseEnum.AUDITING) {
      await stateStore.transition(PhaseEnum.AUDITING);
    }
    await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor start', 'PASS');

    const preAuditWorkspaceDigests = await snapshotWorkspaceDigests(projectRoot, diffResult);

    let auditorPrompt: string;
    let auditorPromptFile: string | undefined;
    try {
      const iterStr = String(iteration).padStart(2, '0');
      const promptResult = await buildPrompt(
        projectRoot,
        'auditor.md',
        (template) => buildAuditorPrompt(template, {
          run_id: runId,
          iteration,
          project_root: projectRoot,
          plan_path: join(projectRoot, '.agent/plan.md'),
          goal_path: join(projectRoot, '.agent/GOAL.md'),
          handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
          verification_manifest_path: join(agentDir, 'verification', 'manifest.json'),
          changed_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'changed-files.json'),
          untracked_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'untracked-files.json'),
          scope_report_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'scope-report.json'),
          tracked_diff_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'tracked.diff'),
          diff_metadata_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'diff-metadata.json'),
          audit_report_path: join(projectRoot, '.agent/audit-report.md'),
          goal_digest: goalDigest,
          diff_digest: diffDigest,
        }),
        { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'auditor' },
      );
      auditorPrompt = promptResult.prompt;
      auditorPromptFile = promptResult.prompt_file_path ?? undefined;
    } catch (err) {
      await transitionToBlocked(stateStore, `Auditor prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
      return makeBlockedResult(runId, projectRoot, 'Auditor prompt build failed', 'CONFIG_ERROR', currentBranch);
    }

    const preAuditCancel = await checkCancelRequest(agentDir);
    if (preAuditCancel) {
      await stateStore.update(() => ({ cancel_requested_at: preAuditCancel.requested_at }));
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'cancel requested', 'CANCELLED');
      return makeResult(
        runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [],
        'Run cancelled by user request',
        `Cancel requested at ${preAuditCancel.requested_at}`,
        null,
      );
    }

    let auditorResult;
    let auditorCleanupResult: PromptCleanupResult | undefined;
    try {
      const auditorInput = buildAuditorInput({
        run_id: runId,
        iteration,
        project_root: projectRoot,
        command_template: config.agents.auditor.command,
        timeout_seconds: config.agents.auditor.timeout_seconds,
        prompt: auditorPrompt,
        prompt_file: auditorPromptFile,
        signal: combinedSignal,
      });

      auditorResult = await runAgent(auditorInput, projectRoot);
    } finally {
      if (auditorPromptFile) auditorCleanupResult = await deletePromptFile(auditorPromptFile);
    }

    if (auditorCleanupResult && !auditorCleanupResult.success) {
      await transitionToBlocked(stateStore, `Auditor prompt cleanup failed: ${auditorCleanupResult.error}`);
      return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${auditorCleanupResult.error}`, 'STATE_CONFLICT', currentBranch);
    }

    if (auditorResult.status !== 'success') {
      await transitionToBlocked(stateStore, `Auditor failed: ${auditorResult.error?.message ?? 'unknown'}`);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL', auditorResult.error?.message);
      return makeResult(runId, PhaseEnum.BLOCKED, 3, currentBranch, null, [], 'Fix Auditor configuration or check agent availability', `Auditor failed: ${auditorResult.error?.message ?? 'unknown'}`, auditorResult.error);
    }

    registerAgentLogs(auditorResult, orchestratorRegistry);

    // Register audit-report.md in the orchestrator registry
    const auditReportPath = join(agentDir, 'audit-report.md');
    if (existsSync(auditReportPath)) {
      const auditReportDigest = computeDigest(readFileSync(auditReportPath, 'utf8'));
      orchestratorRegistry.register(auditReportPath, auditReportDigest);
    }

    const auditValidation = await validateAuditorOutput(
      projectRoot,
      runId,
      iteration,
      goalDigest,
      diffDigest,
      preAuditWorkspaceDigests,
    );

    if (!auditValidation.valid) {
      if (auditValidation.decision === 'PASS') {
        await stateStore.transition(PhaseEnum.REWORKING);
        await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL', `Mechanical check failure overrides PASS: ${auditValidation.errors.join('; ')}`);

        if (iteration >= maxIterations) {
          await stateStore.transition(PhaseEnum.FAILED);
          return makeResult(
            runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
            'Max iterations reached — mechanical check overrides Auditor PASS',
            `Mechanical check failure after ${maxIterations} iterations: ${auditValidation.errors.join('; ')}`,
            null,
          );
        }

        continue;
      }
      await transitionToBlocked(stateStore, `Auditor output validation failed: ${auditValidation.errors.join('; ')}`);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL', auditValidation.errors.join('; '));
      return makeBlockedResult(runId, projectRoot, `Auditor output invalid: ${auditValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', currentBranch);
    }

    const decision = auditValidation.effectiveDecision ?? auditValidation.decision;

    if (decision === 'PASS') {
      await stateStore.transition(PhaseEnum.FINALIZING);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'PASS');
      return makeResult(
        runId, PhaseEnum.FINALIZING, 0, currentBranch, 'PASS',
        ['.agent/plan.md', '.agent/GOAL.md', '.agent/developer-handoff.md', '.agent/audit-report.md'],
        'Audit PASSED. Not yet committed — Phase 5 will handle finalization.',
        'Audit PASSED. Not yet committed.',
        null,
      );
    }

    if (decision === 'FAIL') {
      await stateStore.transition(PhaseEnum.REWORKING);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL');

      if (iteration >= maxIterations) {
        await stateStore.transition(PhaseEnum.FAILED);
        return makeResult(
          runId, PhaseEnum.FAILED, 2, currentBranch, 'FAIL', [],
          'Max iterations reached — Auditor still returns FAIL',
          `Auditor FAIL after ${maxIterations} iterations. Not yet committed.`,
          null,
        );
      }

      continue;
    }

    // BLOCKED — no rework
    await transitionToBlocked(stateStore, 'Auditor returned BLOCKED');
    await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'BLOCKED');
    return makeResult(
      runId, PhaseEnum.BLOCKED, 3, currentBranch, 'BLOCKED', [],
      'Resolve BLOCKED issue and retry',
      'Auditor returned BLOCKED.',
      null,
    );
  } // end iteration loop

  // If we exit the loop without returning, max iterations was reached
  await stateStore.transition(PhaseEnum.FAILED);
  return makeResult(
    runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
    `Max iterations (${maxIterations}) reached without passing audit`,
    `Failed after ${maxIterations} iterations`,
    null,
  );
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
  projectRoot: string,
  message: string,
  code: ErrorCategory,
  branch?: string,
): OrchestratorResult {
  void projectRoot; // kept for API consistency — may be used in logging/future features
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

// ─── Phase 4 Helper Functions ────────────────────────────────

/**
 * Check for a cancel request in .agent/cancel-request.json.
 * Returns the parsed CancelRequest if present and valid, or null.
 */
async function checkCancelRequest(agentDir: string): Promise<CancelRequest | null> {
  const cancelPath = join(agentDir, 'cancel-request.json');
  if (!existsSync(cancelPath)) return null;

  try {
    const raw = readFileSync(cancelPath, 'utf8');
    const data = JSON.parse(raw);
    if (validateCancelRequest(data)) {
      return data as CancelRequest;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Snapshot all system-protected paths before Developer call.
 * Returns a Map of absolute paths to their digest, mode, and symlink status.
 */
function snapshotSystemPaths(
  agentDir: string,
): Map<string, { digest: string; mode: number; isSymlink: boolean }> {
  const paths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

  // Static protected files
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
          paths.set(filePath, {
            digest,
            mode: stat.mode,
            isSymlink: stat.isSymbolicLink(),
          });
        }
      } catch { /* skip unreadable */ }
    }
  }

  // All files in system-protected directories
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
          paths.set(fullPath, {
            digest,
            mode: stat.mode,
            isSymlink: stat.isSymbolicLink(),
          });
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable directory */ }
  }

  return paths;
}

/**
 * Register agent stdout/stderr log files in the orchestrator registry.
 */
function registerAgentLogs(
  agentResult: { stdout_path?: string; stderr_path?: string },
  registry: OrchestratorFileRegistry,
): void {
  if (agentResult.stdout_path && existsSync(agentResult.stdout_path)) {
    const stdoutDigest = computeDigest(readFileSync(agentResult.stdout_path, 'utf8'));
    registry.register(agentResult.stdout_path, stdoutDigest);
  }
  if (agentResult.stderr_path && existsSync(agentResult.stderr_path)) {
    const stderrDigest = computeDigest(readFileSync(agentResult.stderr_path, 'utf8'));
    registry.register(agentResult.stderr_path, stderrDigest);
  }
}

/**
 * Register all files in a directory in the orchestrator registry.
 */
function registerDirectoryFiles(dirPath: string, registry: OrchestratorFileRegistry): void {
  if (!existsSync(dirPath)) return;
  try {
    const entries = readdirSync(dirPath, { recursive: true, withFileTypes: false });
    for (const entry of entries) {
      const fullPath = join(dirPath, String(entry));
      try {
        const stat = lstatSync(fullPath);
        if (stat.isDirectory()) continue;
        const digest = computeDigest(readFileSync(fullPath, 'utf8'));
        registry.register(fullPath, digest);
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable directory */ }
}

/**
 * Basic validation that a parsed object looks like a ScopeReportV2.
 */
function validateScopeReportData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.schema_version === 'number'
    && typeof obj.passed === 'boolean'
    && Array.isArray(obj.denied);
}

/**
 * Snapshot workspace digests before Auditor call.
 * Uses git ls-files to enumerate all tracked and untracked files,
 * then computes digests for each.
 */
async function snapshotWorkspaceDigests(
  projectRoot: string,
  diffResult: { changedFiles: { files: Array<{ path: string }> } },
): Promise<Map<string, Digest>> {
  const digests = new Map<string, Digest>();
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
          digests.set(fullPath, computeDigest(readFileSync(fullPath, 'utf8')));
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
          digests.set(fullPath, computeDigest(readFileSync(fullPath, 'utf8')));
        } catch { /* skip unreadable */ }
      }
    }
  } catch {
    // Fallback: use only Developer-changed files
    const businessFiles = diffResult.changedFiles.files.map(f => join(projectRoot, f.path));
    for (const filePath of businessFiles) {
      if (existsSync(filePath)) {
        digests.set(filePath, computeDigest(readFileSync(filePath, 'utf8')));
      }
    }
  }
  return digests;
}
