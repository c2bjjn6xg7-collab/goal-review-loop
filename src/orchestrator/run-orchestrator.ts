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
import { runTaskGraphLoop } from './task-graph-loop.js';
import { runTaskGraphWaveLoop } from './task-graph-wave-loop.js';
import {
  R3_FINALIZATION_BLOCKED_MARKER,
  runIntegrationFinalization,
} from './integration-finalizer.js';
import { resolveTaskGraphResumeDecision } from './task-graph-resume.js';
import { recordSoftFailure, recordSoftFailurePass } from './failure-guard.js';
import { LockManager } from '../runtime/lock-manager.js';
import { ArtifactStore, ARTIFACT_FILES } from '../artifacts/artifact-store.js';
import { loadConfigWithDefaults } from '../artifacts/config.js';
import {
  resolveParallelExecution,
  ParallelExecutionConfigError,
} from '../scheduler/parallel-execution.js';
import type { ReviewLoopConfig, ReworkFinding, CancelRequest } from '../types.js';
import { preflight, createTaskBranch, runGit } from '../git/git-manager.js';
import { collectDiff, writeDiffArtifacts } from '../git/diff-collector.js';
import { checkScope, writeScopeReport } from '../scope/scope-guard.js';
import { runVerification } from '../verification/verification-runner.js';
import { computeDigest as computeDigestLib, computeFileDigest, type Digest } from '../runtime/digest.js';
import { buildPlannerPrompt, buildDeveloperPrompt, buildReworkPrompt, buildAuditorPrompt, buildFinalAuditorPrompt, buildPrompt, deletePromptFile, type PromptCleanupResult } from '../agents/prompt-builder.js';
import { buildPlannerInput, validatePlannerOutput, snapshotWorkspaceBeforePlanner, validatePlannerWorkspaceOwnership } from '../agents/planner-adapter.js';
import { buildDeveloperInput, validateDeveloperOutput } from '../agents/developer-adapter.js';
import { buildAuditorInput, validateAuditorOutput } from '../agents/auditor-adapter.js';
import { buildFinalAuditorInput, validateFinalAuditorOutput } from '../agents/final-auditor-adapter.js';
import { dispatchFeedbackBlocks } from './feedback-dispatcher.js';
import { readClarificationsForPlanner } from './feedback-dispatcher.js';
import { readFeedbackNotesForAudit } from './feedback-dispatcher.js';
import {
  renderCommitMessage,
  renderTagName,
  stageFiles,
  getStagedFiles,
  findStagedSetViolations,
  createCommit,
  createTag,
  getTagTarget,
  commitExists,
  verifyCommitTree,
  findTrackedLocalOnlyArtifacts,
  buildAllowedCommitSet,
  VERSIONED_ARTIFACT_PATHS,
} from '../git/commit-manager.js';
import { runAgent } from '../agents/agent-adapter.js';
import { resolveCommandForAgent } from '../providers/provider-registry.js';
import { parseFinalAudit } from '../artifacts/artifact-schemas.js';
import { buildProgressData, writeProgress, writeProgressMarkdown } from '../runtime/progress-writer.js';
import { buildTranscriptEntry, writeTranscript } from '../runtime/transcript-writer.js';
import { emitPermissionWarnings } from '../providers/permission-guard.js';
import { EventBus } from '../runtime/event-bus.js';
import type { IEventBus } from '../runtime/event-bus.js';
import type { EventDraft } from '../runtime/event-store.js';
import { classifyProviderFailure } from '../runtime/provider-failure.js';
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
  /** Phase 5: commit SHA if created. */
  commit_sha: string | null;
  /** Phase 5: whether commit was skipped. */
  commit_skipped: boolean;
  /** Phase 5: tag name if created. */
  tag_name: string | null;
  /** Phase 5: whether tag was created. */
  tag_created: boolean;
  /** Phase 5: reason commit was skipped. */
  skip_reason: string | null;
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
  /**
   * Phase 8D P5 Round 2B: explicit `--parallel` opt-in. On its own, this
   * requests parallel mode; combined with a worker count > 1 (from config or
   * `max_parallel_workers`) it resolves to `wave` mode, which the orchestrator
   * blocks here until Round 2E wires real worktree-backed execution.
   */
  parallel?: boolean;
  /**
   * Phase 8D P5 Round 2B: integer override in [1, 16] for the resolver. Alone
   * does not enable parallelism — `parallel === true` or `config.parallel.enabled`
   * is still required.
   */
  max_parallel_workers?: number;
}): Promise<OrchestratorResult> {
  const projectRoot = resolve(params.project_root);
  const agentDir = join(projectRoot, '.agent');
  let lockManager: LockManager | null = null;
  let stateStore: StateStore | null = null;
  let runId = ''; // Declared at function scope so finally block can access it
  // Phase 9 R1: observability event stream. Starts as a null bus; replaced
  // with a real EventBus once runId is known (fresh run at line ~605, resume
  // at line ~239). Emission is fail-soft and never affects scheduling.
  let eventBus: IEventBus = EventBus.createNull();

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

    // Phase 8D P5: resolve the parallel-execution decision from config + CLI
    // overrides. Invalid worker counts surface here as a clear CONFIG_ERROR
    // before any agent or git work begins. Wave-mode task-graph requests are
    // dispatched after planning once we know whether task-graph.json exists;
    // serial decisions (the default and one-worker explicit opt-in) flow
    // through to the existing path unchanged.
    let parallelDecision;
    try {
      parallelDecision = resolveParallelExecution(config, {
        parallel: params.parallel,
        maxParallelWorkers: params.max_parallel_workers,
      });
    } catch (err) {
      if (err instanceof ParallelExecutionConfigError) {
        return makeBlockedResult(
          '',
          projectRoot,
          `Parallel execution configuration error: ${err.message}`,
          'CONFIG_ERROR',
        );
      }
      throw err;
    }
    // Phase 6: Emit permission mode warnings
    emitPermissionWarnings(config);

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
      // Phase 9 R1: resume continues the same durable event stream.
      eventBus = new EventBus(agentDir, runId);
      try {
        await lockManager.acquireOrRecover(runId, config.runtime.lock_stale_seconds);
      } catch (err) {
        return makeBlockedResult(runId, projectRoot, `Lock acquisition failed on resume: ${err instanceof Error ? err.message : String(err)}`, 'STATE_CONFLICT');
      }
      await eventBus.emit({
        kind: 'run.resumed',
        phase: resume.phase,
        level: 'info',
        message: `Resuming from ${resume.phase} at iteration ${resume.iteration}`,
        status: resume.phase,
        payload: { resume_iteration: resume.iteration, resume_branch: resume.branch },
      });

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
          await transitionToBlocked(stateStore, `Resume branch mismatch: current=${currentBranch}, expected=${resume.branch}`, eventBus);
          return makeBlockedResult(runId, projectRoot, `Current Git branch (${currentBranch}) does not match state.branch (${resume.branch})`, 'STATE_CONFLICT');
        }
      } catch {
        return makeBlockedResult(runId, projectRoot, 'Cannot determine current Git branch', 'PREFLIGHT_ERROR');
      }

      // Check base_commit still exists
      try {
        execSync(`git cat-file -t ${resume.base_commit}`, { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
      } catch {
        await transitionToBlocked(stateStore, `base_commit ${resume.base_commit} no longer exists`, eventBus);
        return makeBlockedResult(runId, projectRoot, `base_commit ${resume.base_commit} no longer exists`, 'STATE_CONFLICT');
      }

      // Check GOAL.md digest matches
      const goalPath = join(agentDir, 'GOAL.md');
      if (!existsSync(goalPath)) {
        await transitionToBlocked(stateStore, 'GOAL.md missing — cannot resume', eventBus);
        return makeBlockedResult(runId, projectRoot, 'GOAL.md missing — cannot resume', 'ARTIFACT_ERROR');
      }

      if (resume.goal_digest) {
        try {
          const goalContent = readFileSync(goalPath, 'utf8');
          const currentDigest = computeDigest(goalContent);
          if (currentDigest !== resume.goal_digest) {
            await transitionToBlocked(stateStore, 'GOAL.md digest mismatch on resume', eventBus);
            return makeBlockedResult(runId, projectRoot, 'GOAL.md digest does not match state.goal_digest', 'STATE_CONFLICT');
          }
        } catch {
          return makeBlockedResult(runId, projectRoot, 'Cannot read GOAL.md to verify digest', 'ARTIFACT_ERROR');
        }
      }

      const goalValidation = validatePlannerOutput(projectRoot, runId);
      if (!goalValidation.valid) {
        await transitionToBlocked(stateStore, `GOAL.md validation failed on resume: ${goalValidation.errors.join('; ')}`, eventBus);
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
      for (const f of ['state.json', 'run.lock', 'events.jsonl', 'plan.md', 'GOAL.md', 'iteration-log.md', 'audit-report.md', 'rework-instructions.md', 'developer-handoff.md']) {
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

      // Phase 8B: If a task graph exists, resume the task graph loop from the
      // saved task index instead of the monolithic iteration loop.
      if (goalValidation.taskGraph) {
        const tgState = await stateStore.read();
        // Phase 8D P7: derive the resume index from per-task statuses instead
        // of trusting raw `current_task_index`. A failed/running/blocked task
        // restarts, otherwise the earliest pending task continues, otherwise
        // the task loop is skipped so integration verification/finalization runs.
        const resumeDecision = resolveTaskGraphResumeDecision(
          goalValidation.taskGraph,
          tgState.task_graph_state,
        );
        await appendLog(
          artifactStore,
          runId,
          startIteration,
          'RESUMING',
          'task-graph resume decision',
          'PASS',
          `${resumeDecision.kind} at index ${resumeDecision.taskIndex}${resumeDecision.taskId ? ` (${resumeDecision.taskId})` : ''}: ${resumeDecision.reason}`,
        );
        const resumeTaskIndex = resumeDecision.taskIndex;
        const r2IntegrationBranch = readR2IntegrationBranch(projectRoot, runId);
        const stateIntegrationBranch = tgState.branch === `integration/${runId}` ? tgState.branch : null;
        const hasR3IntegrationBranch = Boolean(r2IntegrationBranch ?? stateIntegrationBranch);
        const hasR3FinalizingResumeTarget = Boolean(
          r2IntegrationBranch
          ?? stateIntegrationBranch
          ?? (parallelDecision.mode === 'wave' ? `integration/${runId}` : null),
        );
        const hasR3BlockedMarker =
          typeof tgState.last_error === 'string'
          && tgState.last_error.startsWith(R3_FINALIZATION_BLOCKED_MARKER);
        const hasR3FinalCommitTagRetry = Boolean(tgState.final_commit_sha) && !tgState.tag_created;
        const isR3BlockedResume =
          resume.phase === PhaseEnum.BLOCKED
          && resumeDecision.kind === 'all_tasks_complete'
          && hasR3IntegrationBranch
          && (hasR3BlockedMarker || hasR3FinalCommitTagRetry);
        const isR3FinalizingResume =
          resume.phase === PhaseEnum.FINALIZING
          && resumeDecision.kind === 'all_tasks_complete'
          && hasR3FinalizingResumeTarget;
        if (isR3FinalizingResume || isR3BlockedResume) {
          const finalizationIteration = resumeDecision.taskIndex + 1;
          const integrationBranch = r2IntegrationBranch ?? stateIntegrationBranch;
          if (integrationBranch) {
            await appendLog(
              artifactStore,
              runId,
              finalizationIteration,
              'FINALIZING',
              'task graph resume into R3 finalization',
              'PASS',
              `R2 integration evidence found — resuming Phase 8E R3 finalization on ${integrationBranch}`,
            );
            const finalization = await runIntegrationFinalization({
              projectRoot,
              agentDir,
              runId,
              baseCommit,
              goalDigest,
              integrationBranch,
              iteration: finalizationIteration,
              stateStore,
              artifactStore,
              orchestratorRegistry,
              config,
              tag: params.tag ?? config.git.create_tag,
              noCommit: params.no_commit ?? !config.git.commit_on_pass,
            });
            registerDirectoryFiles(join(agentDir, 'integration'), orchestratorRegistry);
            if (finalization.status === 'blocked') {
              const message = finalization.error_message ?? 'Phase 8E R3 finalization BLOCKED';
              return makeResult(
                runId,
                PhaseEnum.BLOCKED,
                3,
                integrationBranch,
                'PASS',
                finalization.artifact_paths,
                'Resolve Phase 8E R3 finalization blocker, then resume',
                message,
                {
                  code: finalization.error_code ?? 'GIT_COMMIT_ERROR',
                  message,
                  resumable: true,
                  suggested_action: 'Review .agent/integration evidence and retry Phase 8E R3 finalization.',
                },
                finalization.final_commit_sha,
                false,
                finalization.tag_name,
                finalization.tag_created,
                null,
              );
            }
            return makeResult(
              runId,
              PhaseEnum.PASSED,
              0,
              integrationBranch,
              'PASS',
              finalization.artifact_paths,
              `Phase 8E R3 finalized integration branch ${integrationBranch}`,
              finalization.final_commit_sha
                ? `Phase 8E R3 finalization PASSED. Committed as ${finalization.final_commit_sha.slice(0, 8)}.`
                : 'Phase 8E R3 finalization PASSED. Commit skipped.',
              null,
              finalization.final_commit_sha,
              finalization.commit_skipped,
              finalization.tag_name,
              finalization.tag_created,
              finalization.skip_reason,
            );
          }
          if (parallelDecision.mode === 'wave' || stateIntegrationBranch) {
            const message = 'R2 integration evidence missing or unreadable on Phase 8E R3 FINALIZING resume; refusing to rerun Final Aggregate Audit.';
            await appendLog(
              artifactStore,
              runId,
              finalizationIteration,
              'FINALIZING',
              'task graph resume into R3 finalization',
              'FAIL',
              message,
            );
            await transitionToBlocked(stateStore, message, eventBus);
            return makeBlockedResult(
              runId,
              projectRoot,
              message,
              'STATE_CONFLICT',
              currentBranch,
            );
          }
        }
        if (
          resume.phase === PhaseEnum.BLOCKED
          && tgState.final_commit_sha
          && !tgState.tag_created
          && resumeDecision.kind === 'all_tasks_complete'
        ) {
          const finalizationIteration = resumeDecision.taskIndex + 1;
          await stateStore.forceTransitionForResume(PhaseEnum.FINALIZING);
          await appendLog(
            artifactStore,
            runId,
            finalizationIteration,
            'FINALIZING',
            'task graph tag retry',
            'PASS',
            'final commit exists and tag is incomplete — resuming serial finalization tag handling',
          );
          return await runFinalization({
            projectRoot,
            agentDir,
            runId,
            stateStore,
            artifactStore,
            config,
            currentBranch,
            baseCommit,
            goalFm,
            goalDigest,
            diffDigest: tgState.audited_diff_digest ?? goalDigest,
            iteration: finalizationIteration,
            noCommit: params.no_commit ?? !config.git.commit_on_pass,
            tag: params.tag ?? config.git.create_tag,
            combinedSignal,
            orchestratorRegistry,
            eventBus,
          });
        }
        if (resume.phase === PhaseEnum.FINALIZING && resumeDecision.kind === 'all_tasks_complete') {
          const finalizationIteration = resumeDecision.taskIndex + 1;
          await appendLog(
            artifactStore,
            runId,
            finalizationIteration,
            'FINALIZING',
            'task graph resume from FINALIZING',
            'PASS',
            'all task-graph tasks are complete — resuming finalization without re-running integration verification',
          );
          return await runFinalization({
            projectRoot,
            agentDir,
            runId,
            stateStore,
            artifactStore,
            config,
            currentBranch,
            baseCommit,
            goalFm,
            goalDigest,
            diffDigest: tgState.audited_diff_digest ?? goalDigest,
            iteration: finalizationIteration,
            noCommit: params.no_commit ?? !config.git.commit_on_pass,
            tag: params.tag ?? config.git.create_tag,
            combinedSignal,
            orchestratorRegistry,
            eventBus,
          });
        }
        // Phase 8B: a task-graph run may have BLOCKED on a failed task. BLOCKED has
        // no outgoing legal transitions, so force the phase back to DEVELOPING to
        // restart from the failed task. Successfully completed tasks are skipped.
        if (tgState.phase === PhaseEnum.BLOCKED) {
          await stateStore.forceTransitionForResume(PhaseEnum.DEVELOPING);
        }
        return await runTaskGraphLoop({
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
          taskGraph: goalValidation.taskGraph,
          maxIterations,
          combinedSignal,
          noCommit: params.no_commit ?? !config.git.commit_on_pass,
          tag: params.tag ?? config.git.create_tag,
          resumeTaskIndex,
          eventBus,
        });
      }

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
        noCommit: params.no_commit ?? !config.git.commit_on_pass,
        tag: params.tag ?? config.git.create_tag,
        eventBus,
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
    // Phase 9 R1: create the durable event stream for this run.
    eventBus = new EventBus(agentDir, runId);
    // Isolate event streams: archive any events.jsonl left by a previous run
    // so this run starts with a clean stream. Resume path (above) skips this
    // because the file already belongs to the same run_id.
    try {
      await eventBus.archivePreviousRun?.();
    } catch (err) {
      // Fail-soft: never block a run because archiving failed.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[event-bus] failed to archive previous run events: ${msg}`);
    }
    try {
      await lockManager.acquireOrRecover(runId, config.runtime.lock_stale_seconds);
    } catch (err) {
      return makeBlockedResult(runId, projectRoot, `Lock acquisition failed: ${err instanceof Error ? err.message : String(err)}`, 'STATE_CONFLICT');
    }
    await eventBus.emit({
      kind: 'run.started',
      phase: 'INITIALIZING',
      level: 'info',
      message: params.request ? `Run started: ${params.request.slice(0, 120)}` : 'Run started',
      payload: { task_slug: params.task_slug, base_commit: baseCommit },
    });

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
      join(agentDir, 'events.jsonl'),
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
    // Phase 10: read accumulated clarifications to inject into the Planner prompt.
    const plannerClarifications = config.feedback_protocol.enabled
      ? await readClarificationsForPlanner(projectRoot)
      : '';
    try {
      const promptResult = await buildPrompt(
        projectRoot,
        'planner.md',
        (template) => buildPlannerPrompt(template, {
          user_request: params.request ?? '',
          run_id: runId,
          project_root: projectRoot,
          base_commit: baseCommit,
          clarifications: plannerClarifications,
        }),
        { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'planner' },
      );
      plannerPrompt = promptResult.prompt;
      plannerPromptFile = promptResult.prompt_file_path ?? undefined;
    } catch (err) {
      await transitionToBlocked(stateStore, `Planner prompt build failed: ${err instanceof Error ? err.message : String(err)}`, eventBus);
      return makeBlockedResult(runId, projectRoot, 'Planner prompt build failed', 'CONFIG_ERROR', originalBranch);
    }

    // F-306R1 fix: Wrap Planner execution in try/finally to guarantee prompt cleanup
    // even on unexpected exceptions (e.g. recordArtifactDigests throws on directory path).
    // F-306R2 fix: Check cleanup result — prompt deletion failure must BLOCKED.
    let plannerResult: { result: import('../types.js').AgentRunResult; prePlannerSnapshot: Awaited<ReturnType<typeof snapshotWorkspaceBeforePlanner>> } | undefined;
    let plannerCleanupResult: PromptCleanupResult | undefined;
    try {
      // Snapshot workspace before Planner to detect unauthorized changes
      const prePlannerSnapshot = await snapshotWorkspaceBeforePlanner(projectRoot);

      // Phase 6 F-604: Emit progress at phase start
      await emitProgress({ projectRoot, stateStore, lastEvent: 'Starting Planner', registry: orchestratorRegistry });
      await eventBus.emit({
        kind: 'role.started',
        phase: 'PLANNING',
        level: 'info',
        message: 'Planner starting',
        role: 'planner',
        provider: config.agents.planner.provider ?? 'claude',
        artifact_refs: plannerPromptFile ? [{ type: 'prompt', path: plannerPromptFile }] : undefined,
      });

      const plannerInput = buildPlannerInput({
        run_id: runId,
        project_root: projectRoot,
        command_template: resolveCommandForAgent(config.agents.planner.command, config.agents.planner.provider, config),
        timeout_seconds: config.agents.planner.timeout_seconds,
        prompt: plannerPrompt,
        prompt_file: plannerPromptFile,
        signal: combinedSignal,
        eventBus,
      });

      // Planner retry loop: mirrors Developer retry (max_agent_retries).
      // Useful when the planner model (e.g. opencode/deepseek) stalls on
      // large prompts — a retry often succeeds.
      const maxPlannerRetries = config.loop.max_agent_retries ?? 0;
      for (let plannerAttempt = 0; plannerAttempt <= maxPlannerRetries; plannerAttempt++) {
        if (plannerAttempt > 0) {
          await appendLog(artifactStore, runId, 0, 'PLANNING', `planner retry ${plannerAttempt}`, 'FAIL', `Planner failed, retrying (attempt ${plannerAttempt + 1})`);
          await emitProgress({ projectRoot, stateStore, lastEvent: `Starting Planner (retry ${plannerAttempt})`, registry: orchestratorRegistry });
        }
        const pr = await runAgent(plannerInput, projectRoot);
        if (pr.status === 'success') {
          plannerResult = { result: pr, prePlannerSnapshot };
          break;
        }
        // Store last result even if failed (for transcript/emit below)
        plannerResult = { result: pr, prePlannerSnapshot };
        // Retry only on AGENT_ERROR (process crash / stall), not on cancel
        if (pr.status === 'cancelled' || plannerAttempt >= maxPlannerRetries) {
          break;
        }
        if (pr.error?.code !== 'AGENT_ERROR') {
          break;
        }
        // Loop continues to next retry
      }

      await eventBus.emit({
        kind: 'role.exited',
        phase: 'PLANNING',
        level: plannerResult!.result.status !== 'success' ? 'warn' : 'info',
        message: `Planner exited (${plannerResult!.result.status})`,
        role: 'planner',
        status: plannerResult!.result.status,
        exit_code: plannerResult!.result.exit_code ?? undefined,
        duration_ms: plannerResult!.result.duration_ms ?? null,
        provider: config.agents.planner.provider ?? 'claude',
        artifact_refs: [{ type: 'transcript', path: '.agent/transcripts/iteration-00-planner.md' }],
      });
    } finally {
      if (plannerPromptFile) plannerCleanupResult = await deletePromptFile(plannerPromptFile);
    }

    // Phase 6: Emit planner transcript and progress
    if (plannerResult!.result) {
      emitTranscript({ projectRoot, role: 'planner', iteration: 0, runId, startedAt: new Date().toISOString(), result: plannerResult!.result, registry: orchestratorRegistry });
    }
    await emitProgress({ projectRoot, stateStore, lastEvent: 'Planner completed', registry: orchestratorRegistry });

    // F-306R2: Prompt cleanup failure is a security boundary — must BLOCKED
    if (plannerCleanupResult && !plannerCleanupResult.success) {
      await transitionToBlocked(stateStore, `Planner prompt cleanup failed: ${plannerCleanupResult.error}`, eventBus);
      return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${plannerCleanupResult.error}`, 'STATE_CONFLICT', originalBranch);
    }

    if (plannerResult!.result.status === 'cancelled') {
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, 0, 'PLANNING', 'planner completed', 'CANCELLED', plannerResult!.result.error?.message);
      return makeResult(
        runId, PhaseEnum.CANCELLED, 4, originalBranch, null, [],
        'Run cancelled by user request',
        `Planner cancelled: ${plannerResult!.result.error?.message ?? 'unknown'}`,
        plannerResult!.result.error,
      );
    }

    if (plannerResult!.result.status !== 'success') {
      await emitProviderFailureIfClassified({
        eventBus,
        stderrPath: plannerResult!.result.stderr_path,
        exitCode: plannerResult!.result.exit_code,
        provider: config.agents.planner.provider ?? 'claude',
        role: 'planner',
        phase: 'PLANNING',
      });
      await transitionToBlocked(stateStore, `Planner failed: ${plannerResult!.result.error?.message ?? 'unknown'}`, eventBus);
      await appendLog(artifactStore, runId, 0, 'PLANNING', 'planner completed', 'FAIL', plannerResult!.result.error?.message);
      return makeResult(runId, PhaseEnum.BLOCKED, 3, originalBranch, null, [], 'Fix Planner configuration or check agent availability', `Planner failed: ${plannerResult!.result.error?.message ?? 'unknown'}`, plannerResult!.result.error);
    }

    // Validate Planner output
    const plannerValidation = validatePlannerOutput(projectRoot, runId);
    if (!plannerValidation.valid) {
      await transitionToBlocked(stateStore, `Planner output validation failed: ${plannerValidation.errors.join('; ')}`, eventBus);
      await appendLog(artifactStore, runId, 0, 'PLANNING', 'GOAL validation', 'FAIL', plannerValidation.errors.join('; '));
      return makeBlockedResult(runId, projectRoot, `Planner output invalid: ${plannerValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', originalBranch);
    }

    // Validate Planner workspace ownership — only plan.md and GOAL.md may change
    const plannerWorkspaceCheck = await validatePlannerWorkspaceOwnership(projectRoot, plannerResult!.prePlannerSnapshot);
    if (!plannerWorkspaceCheck.valid) {
      await transitionToBlocked(stateStore, `Planner workspace violation: ${plannerWorkspaceCheck.violations.join('; ')}`, eventBus);
      await appendLog(artifactStore, runId, 0, 'PLANNING', 'workspace ownership', 'FAIL', plannerWorkspaceCheck.violations.join('; '));
      return makeBlockedResult(runId, projectRoot, `Planner modified disallowed files: ${plannerWorkspaceCheck.violations.join('; ')}`, 'SCOPE_VIOLATION', originalBranch);
    }

    await appendLog(artifactStore, runId, 0, 'PLANNING', 'planner completed', 'PASS');
    // Phase 10: dispatch ReviewLoopRequest feedback blocks from plan.md (best-effort).
    await dispatchFeedbackBlocks({
      projectRoot, runId, role: 'planner',
      artifactPath: join(projectRoot, '.agent/plan.md'),
      config: config.feedback_protocol,
      registry: orchestratorRegistry,
    }).catch(() => { /* failure-safe */ });

    // F-307R2: Register Planner agent log files in the orchestrator registry.
    // These are created by the Process Runner infrastructure, not by the Planner agent itself.
    if (plannerResult!.result.stdout_path && existsSync(plannerResult!.result.stdout_path)) {
      const stdoutDigest = computeDigest(readFileSync(plannerResult!.result.stdout_path, 'utf8'));
      orchestratorRegistry.register(plannerResult!.result.stdout_path, stdoutDigest);
    }
    if (plannerResult!.result.stderr_path && existsSync(plannerResult!.result.stderr_path)) {
      const stderrDigest = computeDigest(readFileSync(plannerResult!.result.stderr_path, 'utf8'));
      orchestratorRegistry.register(plannerResult!.result.stderr_path, stderrDigest);
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
    // Phase 8B: Register task-graph.json so the Scope Guard excludes it.
    const taskGraphPath = join(agentDir, 'task-graph.json');
    if (existsSync(taskGraphPath)) {
      const tgDigest = computeDigest(readFileSync(taskGraphPath, 'utf8'));
      orchestratorRegistry.register(taskGraphPath, tgDigest);
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
      await transitionToBlocked(stateStore, `Branch creation failed: ${branchResult.error?.message ?? 'unknown'}`, eventBus);
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

    // ═══════════════════════════════════════════════════════════
    // Phase 8B: Task Graph branch
    // If the Planner produced a valid task-graph.json, execute tasks
    // sequentially in topological order. Otherwise fall back to the
    // monolithic iteration loop (backwards compatibility).
    // ═══════════════════════════════════════════════════════════
    if (plannerValidation.taskGraph) {
      if (parallelDecision.mode === 'wave') {
        return await runTaskGraphWaveLoop({
          projectRoot,
          agentDir,
          runId,
          stateStore,
          artifactStore,
          orchestratorRegistry,
          config,
          currentBranch,
          baseCommit,
          goalDigest,
          goalFm,
          verificationCommands,
          taskGraph: plannerValidation.taskGraph,
          maxIterations: params.max_iterations ?? config.loop.max_iterations,
          maxParallelWorkers: parallelDecision.maxParallelWorkers,
          combinedSignal,
          noCommit: params.no_commit ?? !config.git.commit_on_pass,
          tag: params.tag ?? config.git.create_tag,
          eventBus,
        });
      }
      return await runTaskGraphLoop({
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
        taskGraph: plannerValidation.taskGraph,
        maxIterations: params.max_iterations ?? config.loop.max_iterations,
        combinedSignal,
        noCommit: params.no_commit ?? !config.git.commit_on_pass,
        tag: params.tag ?? config.git.create_tag,
        resumeTaskIndex: undefined,
        eventBus,
      });
    }

    if (parallelDecision.mode === 'wave') {
      return makeBlockedResult(
        runId,
        projectRoot,
        'Parallel wave mode requires task-graph planning; no task-graph.json was produced. Re-run without --parallel or use a task-graph-capable planner.',
        'CONFIG_ERROR',
        currentBranch,
      );
    }

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
      noCommit: params.no_commit ?? !config.git.commit_on_pass,
      tag: params.tag ?? config.git.create_tag,
      eventBus,
    });

  } catch (err) {
    if (stateStore) {
      try {
        await transitionToBlocked(stateStore, `Unexpected error: ${err instanceof Error ? err.message : String(err)}`, eventBus);
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
  noCommit: boolean;
  tag: boolean;
  eventBus: IEventBus;
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
    startIteration, resumePhase, combinedSignal, eventBus,
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

    // Phase 8D P6: run-level circuit breaker. Cancel takes priority; this gate
    // runs before any iteration work begins.
    const breakerState = await stateStore.read();
    if (breakerState.consecutive_failure_count >= config.loop.max_consecutive_failures) {
      const count = breakerState.consecutive_failure_count;
      const max = config.loop.max_consecutive_failures;
      await stateStore.transition(PhaseEnum.FAILED);
      await appendLog(
        artifactStore, runId, iteration,
        breakerState.phase, 'circuit breaker tripped', 'FAIL',
        `consecutive_failure_count=${count}/${max}`,
      );
      await emitRunTerminal(eventBus, PhaseEnum.FAILED, `Circuit breaker tripped: consecutive_failure_count=${count}/${max}`);
      return makeResult(
        runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
        'Consecutive failure limit reached',
        `Consecutive soft failures reached ${count}/${max}. Review .agent/iteration-log.md for failure details.`,
        {
          code: 'CONSECUTIVE_FAILURE_LIMIT',
          message: `Consecutive soft failures reached ${count}/${max}. Review .agent/iteration-log.md for failure details.`,
          resumable: false,
          suggested_action: 'Review .agent/iteration-log.md, adjust GOAL/prompts/config, then start a new run',
        },
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
          await transitionToBlocked(stateStore, `Archive idempotency violation for iteration ${iteration - 1}: ${idempotency.reason}`, eventBus);
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

    // ── Skip DEVELOPING if resuming from VERIFYING, AUDITING, or FINALIZING ──
    const skipDeveloper = resumePhase === PhaseEnum.VERIFYING || resumePhase === PhaseEnum.AUDITING || resumePhase === PhaseEnum.FINALIZING;
    // Only skip for the first iteration of a resume
    const shouldSkipDeveloper = skipDeveloper && iteration === startIteration;

    // ── Skip VERIFYING if resuming from AUDITING or FINALIZING ──
    // When resuming from AUDITING, verification has already passed — go straight to auditing
    const shouldSkipVerifying = (resumePhase === PhaseEnum.AUDITING || resumePhase === PhaseEnum.FINALIZING) && iteration === startIteration;

    // ── Skip AUDITING if resuming from FINALIZING ──
    // When resuming from FINALIZING, the audit has already passed — go straight to finalization
    const shouldSkipAuditing = resumePhase === PhaseEnum.FINALIZING && iteration === startIteration;

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
        await transitionToBlocked(stateStore, `Developer prompt build failed: ${err instanceof Error ? err.message : String(err)}`, eventBus);
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
      // Phase 8D P6: retry budget comes from config.loop.max_agent_retries.
      // max_agent_retries = N yields N + 1 total Developer invocations (1 initial + N retries),
      // all using the same resolved Developer command/provider configuration.
      const maxDeveloperRetries = config.loop.max_agent_retries;
      for (let developerAttempt = 0; developerAttempt <= maxDeveloperRetries; developerAttempt++) {
        developerCleanupResult = undefined;
        try {
          // Phase 6 F-604: Emit progress at phase start
          await emitProgress({ projectRoot, stateStore, lastEvent: `Starting Developer (iter ${iteration}${developerAttempt > 0 ? ` retry ${developerAttempt}` : ''})`, registry: orchestratorRegistry });
          await eventBus.emit({
            kind: 'role.started',
            phase: iteration === 1 ? 'DEVELOPING' : 'REWORKING',
            level: 'info',
            message: `Developer starting (iter ${iteration}${developerAttempt > 0 ? ` retry ${developerAttempt}` : ''})`,
            role: 'developer',
            provider: config.agents.developer.provider ?? 'claude',
            artifact_refs: developerPromptFile ? [{ type: 'prompt', path: developerPromptFile }] : undefined,
          });

          // Rebuild prompt file on retry (previous attempt's finally block deleted it)
          if (developerAttempt > 0) {
            const retryPromptResult = iteration === 1
              ? await buildPrompt(projectRoot, 'developer.md', (template) => buildDeveloperPrompt(template, { run_id: runId, iteration, project_root: projectRoot, plan_path: join(projectRoot, '.agent/plan.md'), goal_path: join(projectRoot, '.agent/GOAL.md'), handoff_path: join(projectRoot, '.agent/developer-handoff.md') }), { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'developer' })
              : await buildPrompt(projectRoot, 'rework.md', (template) => buildReworkPrompt(template, { run_id: runId, iteration, project_root: projectRoot, goal_path: join(projectRoot, '.agent/GOAL.md'), rework_instructions_path: join(projectRoot, '.agent/rework-instructions.md'), handoff_path: join(projectRoot, '.agent/developer-handoff.md') }), { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'developer-rework' });
            developerPrompt = retryPromptResult.prompt;
            developerPromptFile = retryPromptResult.prompt_file_path ?? undefined;
          }

          const developerInput = buildDeveloperInput({
            run_id: runId,
            iteration,
            // F-8D-T-001 fix: 1-indexed attempt prevents log filename collision
            // between AGENT_ERROR retries within the same iteration.
            attempt: developerAttempt + 1,
            project_root: projectRoot,
            command_template: resolveCommandForAgent(config.agents.developer.command, config.agents.developer.provider, config),
            timeout_seconds: config.agents.developer.timeout_seconds,
            prompt: developerPrompt,
            prompt_file: developerPromptFile,
            signal: combinedSignal,
            eventBus,
          });

          developerResult = await runAgent(developerInput, projectRoot);
        } finally {
          if (developerPromptFile) developerCleanupResult = await deletePromptFile(developerPromptFile);
        }

        // If Developer failed due to AGENT_ERROR (e.g. API empty response), retry up to maxDeveloperRetries times
        if (developerResult.status === 'failed' && developerResult.error?.code === 'AGENT_ERROR' && developerAttempt < maxDeveloperRetries) {
          registerAgentLogs(developerResult, orchestratorRegistry);
          await appendLog(artifactStore, runId, iteration, 'DEVELOPING', `developer retry ${developerAttempt + 1}`, 'FAIL', `Developer failed with AGENT_ERROR, retrying: ${developerResult.error?.message ?? 'unknown'}`);
          refreshSystemPathSnapshot(preDevSystemPaths, join(agentDir, ARTIFACT_FILES.ITERATION_LOG));
          continue;
        }
        break;
      }

      if (!developerResult) {
        await transitionToBlocked(stateStore, 'Developer produced no result', eventBus);
        return makeBlockedResult(runId, projectRoot, 'Developer produced no result', 'AGENT_ERROR', currentBranch);
      }

      // Phase 6: Emit developer transcript and progress
      if (developerResult) {
        emitTranscript({ projectRoot, role: 'developer', iteration, runId, startedAt: new Date().toISOString(), result: developerResult, registry: orchestratorRegistry });
        await eventBus.emit({
          kind: 'role.exited',
          phase: iteration === 1 ? 'DEVELOPING' : 'REWORKING',
          level: developerResult.status !== 'success' ? 'warn' : 'info',
          message: `Developer exited (${developerResult.status}, iter ${iteration})`,
          role: 'developer',
          status: developerResult.status,
          exit_code: developerResult.exit_code ?? undefined,
          duration_ms: developerResult.duration_ms ?? null,
          provider: config.agents.developer.provider ?? 'claude',
          artifact_refs: [{ type: 'transcript', path: `.agent/transcripts/iteration-${String(iteration).padStart(2, '0')}-developer.md` }],
        });
      }
      await emitProgress({ projectRoot, stateStore, lastEvent: `Developer completed (iter ${iteration})`, registry: orchestratorRegistry });

      if (developerCleanupResult && !developerCleanupResult.success) {
        await transitionToBlocked(stateStore, `Developer prompt cleanup failed: ${developerCleanupResult.error}`, eventBus);
        return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${developerCleanupResult.error}`, 'STATE_CONFLICT', currentBranch);
      }

      if (developerResult.status === 'cancelled') {
        await stateStore.transition(PhaseEnum.CANCELLED);
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'CANCELLED', developerResult.error?.message);
        return makeResult(
          runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [],
          'Run cancelled by user request',
          `Developer cancelled: ${developerResult.error?.message ?? 'unknown'}`,
          developerResult.error,
        );
      }

      if (developerResult.status !== 'success') {
        await emitProviderFailureIfClassified({
          eventBus,
          stderrPath: developerResult.stderr_path,
          exitCode: developerResult.exit_code,
          provider: config.agents.developer.provider ?? 'claude',
          role: 'developer',
          phase: iteration === 1 ? 'DEVELOPING' : 'REWORKING',
        });
        await transitionToBlocked(stateStore, `Developer failed: ${developerResult.error?.message ?? 'unknown'}`, eventBus);
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
        await transitionToBlocked(stateStore, `Developer tampered with system-protected paths: ${violationMsgs}`, eventBus);
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
        await transitionToBlocked(stateStore, `Developer output validation failed: ${developerValidation.errors.join('; ')}`, eventBus);
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'FAIL', developerValidation.errors.join('; '));
        return makeBlockedResult(runId, projectRoot, `Developer output invalid: ${developerValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', currentBranch);
      }

      if (developerValidation.isBlocked) {
        await transitionToBlocked(stateStore, 'Developer reported BLOCKED', eventBus);
        await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'BLOCKED', 'Developer reported BLOCKED');
        return makeResult(runId, PhaseEnum.BLOCKED, 3, currentBranch, null, [], 'Resolve Developer BLOCKED issue and retry', 'Developer reported BLOCKED', null);
      }

      await appendLog(artifactStore, runId, iteration, 'DEVELOPING', 'developer completed', 'PASS');
      // Phase 10: dispatch ReviewLoopRequest feedback blocks from developer-handoff.md (best-effort).
      await dispatchFeedbackBlocks({
        projectRoot, runId, role: 'developer',
        artifactPath: join(projectRoot, '.agent/developer-handoff.md'),
        config: config.feedback_protocol,
        registry: orchestratorRegistry,
      }).catch(() => { /* failure-safe */ });
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

      // Phase 8D P6: track soft failure before rework/terminal handling.
      await recordSoftFailure(stateStore, config, 'verification_failed');

      if (iteration >= maxIterations) {
        await stateStore.transition(PhaseEnum.FAILED);
        await emitRunTerminal(eventBus, PhaseEnum.FAILED, `Scope violation after ${maxIterations} iterations`);
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

    await eventBus.emit({
      kind: 'verification.started',
      phase: 'VERIFYING',
      level: 'info',
      message: `Verification starting (iter ${iteration})`,
      payload: { command_ids: verificationCommands.map((c) => c.id) },
    });
    const verificationStartTs = Date.now();
    const verificationResult = await runVerification({
      commands: verificationCommands,
      projectRoot,
      runId,
      iteration,
      signal: combinedSignal,
    });
    await eventBus.emit({
      kind: verificationResult.passed ? 'verification.completed' : 'verification.failed',
      phase: 'VERIFYING',
      level: verificationResult.passed ? 'info' : 'warn',
      message: `Verification ${verificationResult.passed ? 'passed' : 'failed'} (iter ${iteration})`,
      status: verificationResult.passed ? 'PASS' : 'FAIL',
      duration_ms: Date.now() - verificationStartTs,
      exit_code: verificationResult.passed ? 0 : 1,
      artifact_refs: [{ type: 'verification-log', path: '.agent/verification/manifest.json' }],
    });

    // If verification was cancelled, transition to CANCELLED
    if (combinedSignal.aborted) {
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, iteration, 'VERIFYING', 'verification result', 'CANCELLED');
      return makeResult(
        runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [],
        'Run cancelled by user request',
        'Verification cancelled by abort signal',
        null,
      );
    }

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

      // Phase 8D P6: track soft failure before rework/terminal handling.
      await recordSoftFailure(stateStore, config, 'verification_failed');

      if (iteration >= maxIterations) {
        await stateStore.transition(PhaseEnum.FAILED);
        await emitRunTerminal(eventBus, PhaseEnum.FAILED, `Required verification failed after ${maxIterations} iterations: ${failedCmds.join(', ')}`);
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
        await emitRunTerminal(eventBus, PhaseEnum.FAILED, `Post-verification scope violation after ${maxIterations} iterations: ${deniedPaths}`);
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

    // ── Skip AUDITING if resuming from FINALIZING ──
    // When resuming from FINALIZING, the audit has already passed — go straight to finalization
    if (shouldSkipAuditing) {
      // Read the existing audit report to get the decision
      const auditReportPath = join(agentDir, 'audit-report.md');
      if (!existsSync(auditReportPath)) {
        await transitionToBlocked(stateStore, 'Audit report not found on resume from FINALIZING', eventBus);
        return makeBlockedResult(runId, projectRoot, 'Audit report not found on resume from FINALIZING', 'ARTIFACT_ERROR', currentBranch);
      }
      // The audit already passed, so proceed directly to finalization
      // Only transition if not already in FINALIZING (e.g. on resume)
      const preFinalizationState = await stateStore.read();
      if (preFinalizationState.phase !== PhaseEnum.FINALIZING) {
        await stateStore.transition(PhaseEnum.FINALIZING);
      }
      await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'resume from FINALIZING', 'PASS', 'skipping audit — already passed');

      return await runFinalization({
        projectRoot,
        agentDir,
        runId,
        stateStore,
        artifactStore,
        config,
        currentBranch,
        baseCommit,
        goalFm,
        goalDigest,
        diffDigest,
        iteration,
        noCommit: params.noCommit ?? !config.git.commit_on_pass,
        tag: params.tag ?? config.git.create_tag,
        combinedSignal,
        orchestratorRegistry,
        eventBus,
      });
    }

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
      const feedbackNotes = await readFeedbackNotesForAudit(projectRoot);
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
          feedback_notes: feedbackNotes,
          feedback_notes_path: '.agent/feedback-notes.md',
        }),
        { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'auditor' },
      );
      auditorPrompt = promptResult.prompt;
      auditorPromptFile = promptResult.prompt_file_path ?? undefined;
    } catch (err) {
      await transitionToBlocked(stateStore, `Auditor prompt build failed: ${err instanceof Error ? err.message : String(err)}`, eventBus);
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
      // Phase 6 F-604: Emit progress at phase start
      await emitProgress({ projectRoot, stateStore, lastEvent: `Starting Auditor (iter ${iteration})`, registry: orchestratorRegistry });
      await eventBus.emit({
        kind: 'role.started',
        phase: 'AUDITING',
        level: 'info',
        message: `Auditor starting (iter ${iteration})`,
        role: 'auditor',
        provider: config.agents.auditor.provider ?? 'codex',
        artifact_refs: auditorPromptFile ? [{ type: 'prompt', path: auditorPromptFile }] : undefined,
      });
      const auditorInput = buildAuditorInput({
        run_id: runId,
        iteration,
        project_root: projectRoot,
        command_template: resolveCommandForAgent(config.agents.auditor.command, config.agents.auditor.provider, config),
        timeout_seconds: config.agents.auditor.timeout_seconds,
        prompt: auditorPrompt,
        prompt_file: auditorPromptFile,
        signal: combinedSignal,
        eventBus,
      });

      auditorResult = await runAgent(auditorInput, projectRoot);
      await eventBus.emit({
        kind: 'role.exited',
        phase: 'AUDITING',
        level: auditorResult.status !== 'success' ? 'warn' : 'info',
        message: `Auditor exited (${auditorResult.status}, iter ${iteration})`,
        role: 'auditor',
        status: auditorResult.status,
        exit_code: auditorResult.exit_code ?? undefined,
        duration_ms: auditorResult.duration_ms ?? null,
        provider: config.agents.auditor.provider ?? 'codex',
        artifact_refs: [{ type: 'transcript', path: `.agent/transcripts/iteration-${String(iteration).padStart(2, '0')}-auditor.md` }],
      });
    } finally {
      if (auditorPromptFile) auditorCleanupResult = await deletePromptFile(auditorPromptFile);
    }

    // Phase 6: Emit auditor transcript and progress
    if (auditorResult) {
      emitTranscript({ projectRoot, role: 'auditor', iteration, runId, startedAt: new Date().toISOString(), result: auditorResult, registry: orchestratorRegistry });
    }
    await emitProgress({ projectRoot, stateStore, lastEvent: `Auditor completed (iter ${iteration})`, registry: orchestratorRegistry });

    if (auditorCleanupResult && !auditorCleanupResult.success) {
      await transitionToBlocked(stateStore, `Auditor prompt cleanup failed: ${auditorCleanupResult.error}`, eventBus);
      return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${auditorCleanupResult.error}`, 'STATE_CONFLICT', currentBranch);
    }

    if (auditorResult.status === 'cancelled') {
      await stateStore.transition(PhaseEnum.CANCELLED);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'CANCELLED', auditorResult.error?.message);
      return makeResult(
        runId, PhaseEnum.CANCELLED, 4, currentBranch, null, [],
        'Run cancelled by user request',
        `Auditor cancelled: ${auditorResult.error?.message ?? 'unknown'}`,
        auditorResult.error,
      );
    }

    if (auditorResult.status !== 'success') {
      await emitProviderFailureIfClassified({
        eventBus,
        stderrPath: auditorResult.stderr_path,
        exitCode: auditorResult.exit_code,
        provider: config.agents.auditor.provider ?? 'codex',
        role: 'auditor',
        phase: 'AUDITING',
      });
      await transitionToBlocked(stateStore, `Auditor failed: ${auditorResult.error?.message ?? 'unknown'}`, eventBus);
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

        // Phase 8D P6: track soft failure before rework/terminal handling.
        await recordSoftFailure(stateStore, config, 'verification_failed');

        if (iteration >= maxIterations) {
          await stateStore.transition(PhaseEnum.FAILED);
          await emitRunTerminal(eventBus, PhaseEnum.FAILED, `Mechanical check failure after ${maxIterations} iterations: ${auditValidation.errors.join('; ')}`);
          return makeResult(
            runId, PhaseEnum.FAILED, 2, currentBranch, null, [],
            'Max iterations reached — mechanical check overrides Auditor PASS',
            `Mechanical check failure after ${maxIterations} iterations: ${auditValidation.errors.join('; ')}`,
            null,
          );
        }

        continue;
      }
      await transitionToBlocked(stateStore, `Auditor output validation failed: ${auditValidation.errors.join('; ')}`, eventBus);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL', auditValidation.errors.join('; '));
      return makeBlockedResult(runId, projectRoot, `Auditor output invalid: ${auditValidation.errors.join('; ')}`, 'ARTIFACT_ERROR', currentBranch);
    }

    const decision = auditValidation.effectiveDecision ?? auditValidation.decision;

    await eventBus.emit({
      kind: 'audit.decision',
      phase: 'AUDITING',
      level: decision === 'PASS' ? 'info' : 'warn',
      message: `Auditor decision: ${decision} (iter ${iteration})`,
      role: 'auditor',
      status: String(decision),
      artifact_refs: [{ type: 'audit-report', path: '.agent/audit-report.md' }],
      payload: {
        diff_digest: diffDigest,
        finding_count: auditValidation.errors.length,
        ...(decision !== 'PASS' ? { rework_reason: '.agent/audit-report.md' } : {}),
      },
    });

    if (decision === 'PASS') {
      await stateStore.transition(PhaseEnum.FINALIZING);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'PASS');

      // Phase 8D P6: passing iteration resets the run-level failure counter.
      await recordSoftFailurePass(stateStore, config);
      // Phase 10: dispatch ReviewLoopRequest feedback blocks from audit-report.md (best-effort).
      await dispatchFeedbackBlocks({
        projectRoot, runId, role: 'auditor',
        artifactPath: join(projectRoot, '.agent/audit-report.md'),
        config: config.feedback_protocol,
        registry: orchestratorRegistry,
      }).catch(() => { /* failure-safe */ });

      // Phase 5: Run the finalization pipeline
      return await runFinalization({
        projectRoot,
        agentDir,
        runId,
        stateStore,
        artifactStore,
        config,
        currentBranch,
        baseCommit,
        goalFm,
        goalDigest,
        diffDigest,
        iteration,
        noCommit: params.noCommit ?? !config.git.commit_on_pass,
        tag: params.tag ?? config.git.create_tag,
        combinedSignal,
        orchestratorRegistry,
        eventBus,
      });
    }

    if (decision === 'FAIL') {
      await stateStore.transition(PhaseEnum.REWORKING);
      await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'FAIL');

      // Phase 8D P6: track soft failure before rework/terminal handling.
      await recordSoftFailure(stateStore, config, 'auditor_block');

      if (iteration >= maxIterations) {
        await stateStore.transition(PhaseEnum.FAILED);
        await emitRunTerminal(eventBus, PhaseEnum.FAILED, `Auditor FAIL after ${maxIterations} iterations`);
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
    await transitionToBlocked(stateStore, 'Auditor returned BLOCKED', eventBus);
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
  await emitRunTerminal(eventBus, PhaseEnum.FAILED, `Max iterations (${maxIterations}) reached without passing audit`);
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
export class OrchestratorFileRegistry {
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
export async function verifySystemProtectedPaths(
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

export async function transitionToBlocked(stateStore: StateStore, reason: string, eventBus?: IEventBus): Promise<void> {
  try {
    await stateStore.update(() => ({ last_error: reason }));
    await stateStore.transition(PhaseEnum.BLOCKED);
    if (eventBus) {
      await eventBus.emit({
        kind: 'run.blocked',
        phase: 'BLOCKED',
        level: 'warn',
        message: reason,
        status: 'BLOCKED',
      });
    }
  } catch { /* best effort */ }
}

export async function appendLog(
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

export function computeDigest(content: string): Digest {
  return computeDigestLib(content);
}

/**
 * Run the finalization pipeline after Auditor PASS.
 * Phase 5 §6: FINALIZING → Final Audit → pre-commit checks → commit → tag → PASSED
 */
export async function runFinalization(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  goalFm: import('../types.js').GoalFrontMatter;
  goalDigest: string;
  diffDigest: string;
  iteration: number;
  noCommit: boolean;
  tag: boolean;
  combinedSignal: AbortSignal;
  orchestratorRegistry: OrchestratorFileRegistry;
  eventBus: IEventBus;
}): Promise<OrchestratorResult> {
  const {
    projectRoot, agentDir, runId, stateStore, artifactStore, config,
    currentBranch, baseCommit, goalFm, goalDigest, iteration,
    noCommit, tag, combinedSignal, orchestratorRegistry, eventBus,
  } = params;

  // §6.5: Reject git.push: true
  if (config.git.push) {
    await transitionToBlocked(stateStore, 'git.push is not supported in Phase 5', eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      'git.push is not supported in Phase 5. Remove git.push: true from configuration.',
      'UNSUPPORTED_PUSH',
      currentBranch,
    );
  }

  // §6.3a: Early check — if commit already exists (e.g., resume from FINALIZING
  // after commit), skip the entire Final Audit pipeline and go directly to tag creation.
  // This prevents re-running the Final Auditor when the commit is already done.
  const earlyState = await stateStore.read();
  if (earlyState.final_commit_sha) {
    // F-503: Verify the commit actually exists in git before trusting it
    const commitExistsResult = await commitExists(projectRoot, earlyState.final_commit_sha);
    if (!commitExistsResult) {
      // Commit doesn't exist — clear the stale sha and fall through to full finalization
      await stateStore.update(() => ({
        final_commit_sha: null,
        final_commit_message: null,
      }));
      await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'commit verification', 'FAIL', `commit sha ${earlyState.final_commit_sha} not found in git — will re-run finalization`);
    } else {
      // F-503R1: Verify the commit tree contains required versioned artifacts
      const requiredCommitPaths = VERSIONED_ARTIFACT_PATHS.map(p => p);
      const treeCheck = await verifyCommitTree(projectRoot, earlyState.final_commit_sha, requiredCommitPaths);
      if (!treeCheck.valid) {
        // Commit exists but is missing required artifacts — not a valid finalization commit
        await stateStore.update(() => ({
          final_commit_sha: null,
          final_commit_message: null,
        }));
        await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'commit tree verification', 'FAIL', `commit ${earlyState.final_commit_sha} missing: ${treeCheck.missing.join(', ')} — will re-run finalization`);
      } else {
      // F-503R2: Verify the commit's final-audit.md belongs to this run.
      // Check run_id and decision from the commit's final-audit.md frontmatter.
      // Note: We intentionally don't compare diff_digest — the diff changes after
      // commit (committed files shift from untracked→tracked), making digest comparison
      // unreliable on resume. The run_id check proves ownership; the tree check proves
      // artifact presence; the decision check proves Final Auditor approval.
      const showResult = await runGit(
        ['show', `${earlyState.final_commit_sha}:.agent/final-audit.md`],
        projectRoot,
      );
      let commitVerified = false;
      if (showResult.exit_code === 0) {
        try {
          const { frontMatter: commitAuditFm } = parseFinalAudit(showResult.stdout);
          commitVerified =
            commitAuditFm.run_id === runId
            && commitAuditFm.decision === 'PASS';
        } catch {
          commitVerified = false;
        }
      }
      if (!commitVerified) {
        await stateStore.update(() => ({
          final_commit_sha: null,
          final_commit_message: null,
        }));
        await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'commit content verification', 'FAIL', `commit ${earlyState.final_commit_sha} final-audit.md does not match current run — will re-run finalization`);
      } else {
      // Commit already created and fully verified — skip to tag creation
      const existingCommitSha = earlyState.final_commit_sha;
      await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'commit already exists', 'PASS', `skipping finalization — ${existingCommitSha.slice(0, 8)} already created`);

      // §6.4: Create tag if requested (and not already created)
      let tagName: string | null = earlyState.tag_name;
      let tagCreated = earlyState.tag_created;

      if ((tag || config.git.create_tag) && !tagCreated) {
        try {
          const state = await stateStore.read();
          tagName = renderTagName(config.git.tag_template, {
            run_id: runId,
            task_slug: state.task_slug,
          });
        } catch (err) {
          await stateStore.update(() => ({
            last_error: `Tag template error: ${err instanceof Error ? err.message : String(err)}`,
            tag_name: null,
            tag_created: false,
          }));
          await stateStore.transition(PhaseEnum.BLOCKED);
          return makeResult(
            runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
            VERSIONED_ARTIFACT_PATHS.map(p => p),
            'Commit exists but tag template error',
            `Commit ${existingCommitSha.slice(0, 8)} exists but tag template error: ${err instanceof Error ? err.message : String(err)}`,
            {
              code: 'GIT_TAG_ERROR',
              message: `Tag template error: ${err instanceof Error ? err.message : String(err)}`,
              resumable: true,
              suggested_action: 'Fix tag template and resume to create tag',
            },
            existingCommitSha, false, null, false,
          );
        }

        const existingTarget = await getTagTarget(projectRoot, tagName);
        if (existingTarget !== null) {
          if (existingTarget === existingCommitSha) {
            tagCreated = true;
          } else {
            await stateStore.update(() => ({
              last_error: `Tag ${tagName} already exists pointing to ${existingTarget}, expected ${existingCommitSha}`,
              tag_name: tagName,
              tag_created: false,
            }));
            await stateStore.transition(PhaseEnum.BLOCKED);
            return makeResult(
              runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
              VERSIONED_ARTIFACT_PATHS.map(p => p),
              'Commit exists but tag conflict',
              `Commit ${existingCommitSha.slice(0, 8)} exists but tag ${tagName} points to different commit ${existingTarget.slice(0, 8)}`,
              {
                code: 'GIT_TAG_ERROR',
                message: `Tag ${tagName} already exists pointing to ${existingTarget}`,
                resumable: false,
                suggested_action: 'Resolve tag conflict manually',
              },
              existingCommitSha, false, tagName, false,
            );
          }
        } else {
          const tagResult = await createTag(projectRoot, tagName, existingCommitSha);
          if (!tagResult.success) {
            await stateStore.update(() => ({
              last_error: `Tag creation failed: ${tagResult.error}`,
              tag_name: tagName,
              tag_created: false,
            }));
            await stateStore.transition(PhaseEnum.BLOCKED);
            return makeResult(
              runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
              VERSIONED_ARTIFACT_PATHS.map(p => p),
              'Commit exists but tag failed',
              `Commit ${existingCommitSha.slice(0, 8)} exists but tag failed: ${tagResult.error}`,
              {
                code: 'GIT_TAG_ERROR',
                message: `Tag creation failed: ${tagResult.error}`,
                resumable: true,
                suggested_action: 'Fix tag issue and resume to create tag',
              },
              existingCommitSha, false, tagName, false,
            );
          }
          tagCreated = true;
        }
      }

      // Transition to PASSED
      await stateStore.update(() => ({
        finalized_at: new Date().toISOString(),
        tag_name: tagName,
        tag_created: tagCreated,
      }));
      await stateStore.transition(PhaseEnum.PASSED);
      await emitProgress({ projectRoot, stateStore, lastEvent: 'Finalization PASSED (commit exists)', registry: orchestratorRegistry, commitSha: existingCommitSha, finalAuditDecision: 'PASS' });
      await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'finalization completed', 'PASS');

      const artifactPaths = VERSIONED_ARTIFACT_PATHS.map(p => p);
      await emitRunTerminal(eventBus, PhaseEnum.PASSED, `Finalization PASSED. Commit ${existingCommitSha.slice(0, 8)} already exists.`, { artifact_refs: [...artifactPaths.map((p) => ({ type: 'state' as const, path: p })), { type: 'final-audit' as const, path: '.agent/final-audit.md' }] });
      return makeResult(
        runId, PhaseEnum.PASSED, 0, currentBranch, 'PASS',
        artifactPaths,
        `Final Audit PASSED. Commit ${existingCommitSha.slice(0, 8)} already exists${tagCreated && tagName ? `, tagged ${tagName}` : ''}.`,
        `Final Audit PASSED. Commit ${existingCommitSha.slice(0, 8)} already exists.`,
        null,
        existingCommitSha, false, tagName, tagCreated,
      );
      } // end else — commit content verified
      } // end else — commit tree verified
    } // end else — commit exists and verified
  } // end if (earlyState.final_commit_sha)

  // §6.1 step 1: Collect final diff artifacts
  const finalDiffResult = await collectDiff({ projectRoot, baseCommit, iteration });
  await writeDiffArtifacts(projectRoot, iteration, finalDiffResult);

  // §6.1 step 2: Run final Scope Guard
  const orchestratorOwnedFiles = orchestratorRegistry.getRelativePaths(projectRoot);
  const finalScopeResult = checkScope({
    allowedChanges: goalFm.allowed_changes,
    disallowedChanges: goalFm.disallowed_changes,
    changedFiles: finalDiffResult.changedFiles,
    orchestratorOwnedFiles,
  });

  if (!finalScopeResult.passed) {
    const deniedPaths = finalScopeResult.report.denied.map(d => d.path).join(', ');
    await transitionToBlocked(stateStore, `Pre-commit scope violation: ${deniedPaths}`, eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      `Pre-commit scope violation: ${deniedPaths}`,
      'PRE_COMMIT_SCOPE_VIOLATION',
      currentBranch,
    );
  }

  // §6.1 step 3: Verify verification manifest is current and passed
  const verificationManifestPath = join(agentDir, 'verification', 'manifest.json');
  let verificationManifestDigest: string = '';
  if (existsSync(verificationManifestPath)) {
    try {
      const manifestContent = readFileSync(verificationManifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent) as VerificationManifest;
      verificationManifestDigest = computeDigest(manifestContent);

      if (manifest.run_id !== runId) {
        await transitionToBlocked(stateStore, `Verification manifest run_id "${manifest.run_id}" does not match current run "${runId}"`, eventBus);
        return makeBlockedResult(
          runId, projectRoot,
          `Verification manifest run_id mismatch: expected ${runId}, got ${manifest.run_id}`,
          'PRE_COMMIT_DIGEST_MISMATCH',
          currentBranch,
        );
      }
      if (manifest.iteration !== iteration) {
        await transitionToBlocked(stateStore, `Verification manifest iteration ${manifest.iteration} does not match current iteration ${iteration}`, eventBus);
        return makeBlockedResult(
          runId, projectRoot,
          `Verification manifest iteration mismatch: expected ${iteration}, got ${manifest.iteration}`,
          'PRE_COMMIT_DIGEST_MISMATCH',
          currentBranch,
        );
      }
      if (!manifest.passed) {
        await transitionToBlocked(stateStore, 'Verification manifest shows not passed', eventBus);
        return makeBlockedResult(
          runId, projectRoot,
          'Verification manifest shows not passed — cannot commit',
          'PRE_COMMIT_DIGEST_MISMATCH',
          currentBranch,
        );
      }
    } catch {
      await transitionToBlocked(stateStore, 'Cannot parse verification manifest', eventBus);
      return makeBlockedResult(
        runId, projectRoot,
        'Cannot parse verification manifest for pre-commit check',
        'PRE_COMMIT_DIGEST_MISMATCH',
        currentBranch,
      );
    }
  } else {
    await transitionToBlocked(stateStore, 'Verification manifest not found', eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      'Verification manifest not found — cannot verify pre-commit',
      'PRE_COMMIT_DIGEST_MISMATCH',
      currentBranch,
    );
  }

  // §6.1 step 4: Compute current digests for pre-commit check
  const currentGoalDigest = computeDigest(readFileSync(join(agentDir, 'GOAL.md'), 'utf8'));
  const currentDiffDigest = `sha256:${finalDiffResult.diffDigest}` as import('../runtime/digest.js').Digest;
  const auditReportPath = join(agentDir, 'audit-report.md');
  let currentAuditReportDigest = '';
  if (existsSync(auditReportPath)) {
    currentAuditReportDigest = computeDigest(readFileSync(auditReportPath, 'utf8'));
  }

  // §6.1 step 5: Check for tracked local-only artifacts
  const trackedLocalOnly = await findTrackedLocalOnlyArtifacts(projectRoot);
  if (trackedLocalOnly.length > 0) {
    await transitionToBlocked(stateStore, `Local-only artifacts are tracked by git: ${trackedLocalOnly.join(', ')}`, eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      `Local-only artifacts are tracked by git: ${trackedLocalOnly.join(', ')}. Remove them from git tracking before committing.`,
      'PRE_COMMIT_STAGED_SET_VIOLATION',
      currentBranch,
    );
  }

  // §6.1 step 6: Cancel check before Final Auditor
  const preFinalAuditCancel = await checkCancelRequest(agentDir);
  if (preFinalAuditCancel) {
    await stateStore.update(() => ({ cancel_requested_at: preFinalAuditCancel.requested_at }));
    await stateStore.transition(PhaseEnum.CANCELLED);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'cancel requested', 'CANCELLED');
    return makeResult(
      runId, PhaseEnum.CANCELLED, 4, currentBranch, 'PASS', [],
      'Run cancelled by user request',
      `Cancel requested at ${preFinalAuditCancel.requested_at}`,
      null,
    );
  }

  // F-501R1: Snapshot digests of all business files before Final Auditor runs.
  // After Final Auditor, re-compute and compare to detect content-level tampering
  // that path/status comparison alone would miss.
  const preFinalAuditBusinessDigests = new Map<string, Digest>();
  for (const f of finalDiffResult.changedFiles.files) {
    if (f.path.startsWith('.agent/')) continue;
    const fullPath = join(projectRoot, f.path);
    if (existsSync(fullPath)) {
      preFinalAuditBusinessDigests.set(f.path, await computeFileDigest(fullPath));
    }
  }
  for (const f of finalDiffResult.untrackedFiles.files) {
    if (f.path.startsWith('.agent/')) continue;
    const fullPath = join(projectRoot, f.path);
    if (existsSync(fullPath)) {
      preFinalAuditBusinessDigests.set(f.path, await computeFileDigest(fullPath));
    }
  }

  // §6.1 step 7: Run Final Auditor
  // Phase 6 F-604: Emit progress at phase start
  await emitProgress({ projectRoot, stateStore, lastEvent: 'Starting Final Auditor', registry: orchestratorRegistry });
  await eventBus.emit({
    kind: 'role.started',
    phase: 'FINALIZING',
    level: 'info',
    message: 'Final Auditor starting',
    role: 'final-auditor',
    provider: config.agents.final_auditor.provider ?? 'codex',
  });
  let finalAuditorPrompt: string;
  let finalAuditorPromptFile: string | undefined;
  try {
    const iterStr = String(iteration).padStart(2, '0');
    const finalFeedbackNotes = await readFeedbackNotesForAudit(projectRoot);
    const promptResult = await buildPrompt(
      projectRoot,
      'final-auditor.md',
      (template) => buildFinalAuditorPrompt(template, {
        run_id: runId,
        iteration,
        project_root: projectRoot,
        plan_path: join(projectRoot, '.agent/plan.md'),
        goal_path: join(projectRoot, '.agent/GOAL.md'),
        handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
        audit_report_path: join(projectRoot, '.agent/audit-report.md'),
        verification_manifest_path: join(agentDir, 'verification', 'manifest.json'),
        changed_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'changed-files.json'),
        untracked_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'untracked-files.json'),
        scope_report_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'scope-report.json'),
        diff_metadata_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'diff-metadata.json'),
        final_audit_path: join(projectRoot, '.agent/final-audit.md'),
        goal_digest: currentGoalDigest,
        diff_digest: currentDiffDigest,
        audit_report_digest: currentAuditReportDigest,
        verification_manifest_digest: verificationManifestDigest,
        feedback_notes: finalFeedbackNotes,
        feedback_notes_path: '.agent/feedback-notes.md',
      }),
      { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'final-auditor' },
    );
    finalAuditorPrompt = promptResult.prompt;
    finalAuditorPromptFile = promptResult.prompt_file_path ?? undefined;
  } catch (err) {
    await transitionToBlocked(stateStore, `Final Auditor prompt build failed: ${err instanceof Error ? err.message : String(err)}`, eventBus);
    return makeBlockedResult(runId, projectRoot, 'Final Auditor prompt build failed', 'CONFIG_ERROR', currentBranch);
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
      eventBus,
    });

    finalAuditorResult = await runAgent(finalAuditorInput, projectRoot);
  } finally {
    if (finalAuditorPromptFile) finalAuditorCleanupResult = await deletePromptFile(finalAuditorPromptFile);
  }

  // Phase 6: Emit final-auditor transcript and progress
  if (finalAuditorResult) {
    emitTranscript({ projectRoot, role: 'final-auditor', iteration, runId, startedAt: new Date().toISOString(), result: finalAuditorResult, registry: orchestratorRegistry });
    await eventBus.emit({
      kind: 'role.exited',
      phase: 'FINALIZING',
      level: finalAuditorResult.status !== 'success' ? 'warn' : 'info',
      message: `Final Auditor exited (${finalAuditorResult.status})`,
      role: 'final-auditor',
      status: finalAuditorResult.status,
      exit_code: finalAuditorResult.exit_code ?? undefined,
      duration_ms: finalAuditorResult.duration_ms ?? null,
      provider: config.agents.final_auditor.provider ?? 'codex',
      artifact_refs: [{ type: 'transcript', path: `.agent/transcripts/iteration-${String(iteration).padStart(2, '0')}-final-auditor.md` }],
    });
  }
  await emitProgress({ projectRoot, stateStore, lastEvent: 'Final Auditor completed', registry: orchestratorRegistry });

  if (finalAuditorCleanupResult && !finalAuditorCleanupResult.success) {
    await transitionToBlocked(stateStore, `Final Auditor prompt cleanup failed: ${finalAuditorCleanupResult.error}`, eventBus);
    return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${finalAuditorCleanupResult.error}`, 'STATE_CONFLICT', currentBranch);
  }

  if (finalAuditorResult.status === 'cancelled') {
    await stateStore.transition(PhaseEnum.CANCELLED);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final auditor completed', 'CANCELLED', finalAuditorResult.error?.message);
    return makeResult(
      runId, PhaseEnum.CANCELLED, 4, currentBranch, 'PASS', [],
      'Run cancelled by user request',
      `Final Auditor cancelled: ${finalAuditorResult.error?.message ?? 'unknown'}`,
      null,
    );
  }

  if (finalAuditorResult.status !== 'success') {
    await emitProviderFailureIfClassified({
      eventBus,
      stderrPath: finalAuditorResult.stderr_path,
      exitCode: finalAuditorResult.exit_code,
      provider: config.agents.final_auditor.provider ?? 'codex',
      role: 'final-auditor',
      phase: 'FINALIZING',
    });
    await transitionToBlocked(stateStore, `Final Auditor failed: ${finalAuditorResult.error?.message ?? 'unknown'}`, eventBus);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final auditor completed', 'FAIL', finalAuditorResult.error?.message);
    return makeBlockedResult(runId, projectRoot, `Final Auditor failed: ${finalAuditorResult.error?.message ?? 'unknown'}`, 'AGENT_ERROR', currentBranch);
  }

  // §6.1 step 8: Validate Final Auditor output
  const finalAuditValidation = validateFinalAuditorOutput({
    projectRoot,
    runId,
    iteration,
    expectedGoalDigest: currentGoalDigest,
    expectedDiffDigest: currentDiffDigest,
    expectedAuditReportDigest: currentAuditReportDigest,
    expectedVerificationManifestDigest: verificationManifestDigest,
  });

  if (!finalAuditValidation.valid) {
    const errorCode = finalAuditValidation.decision === 'PASS'
      ? 'FINAL_AUDIT_SCHEMA_ERROR' as ErrorCategory
      : 'FINAL_AUDIT_FAILED' as ErrorCategory;
    await transitionToBlocked(stateStore, `Final Audit validation failed: ${finalAuditValidation.errors.join('; ')}`, eventBus);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final audit validation', 'FAIL', finalAuditValidation.errors.join('; '));
    return makeBlockedResult(
      runId, projectRoot,
      `Final Audit validation failed: ${finalAuditValidation.errors.join('; ')}`,
      errorCode,
      currentBranch,
    );
  }

  const finalAuditDecision = finalAuditValidation.effectiveDecision ?? finalAuditValidation.decision;

  if (finalAuditDecision !== 'PASS') {
    await transitionToBlocked(stateStore, `Final Audit decision: ${finalAuditDecision}`, eventBus);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final audit completed', finalAuditDecision === 'FAILED' ? 'FAIL' : 'BLOCKED');
    return makeBlockedResult(
      runId, projectRoot,
      `Final Audit decision: ${finalAuditDecision}. Cannot commit.`,
      'FINAL_AUDIT_FAILED',
      currentBranch,
    );
  }

  await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final audit completed', 'PASS');
  // Phase 10: dispatch ReviewLoopRequest feedback blocks from final-audit.md (best-effort).
  await dispatchFeedbackBlocks({
    projectRoot, runId, role: 'final_auditor',
    artifactPath: join(projectRoot, '.agent/final-audit.md'),
    config: config.feedback_protocol,
    registry: orchestratorRegistry,
  }).catch(() => { /* failure-safe */ });

  // F-501R2: Verify Final Auditor workspace immutability via exhaustive digest comparison.
  // Pass 1: For EVERY file in the pre-snapshot, re-compute current digest regardless of
  // whether it appears in the post-diff. This catches revert-to-base (file matches base,
  // so it disappears from git diff, but content differs from the pre-snapshot).
  // Pass 2: Detect new business files not in the pre-snapshot.
  const postFinalAuditDiffResult = await collectDiff({ projectRoot, baseCommit, iteration });
  const finalAuditBusinessViolations: string[] = [];

  // Pass 1: Exhaustive re-verification of all pre-snapshot business files
  for (const [path, preDigest] of preFinalAuditBusinessDigests) {
    const fullPath = join(projectRoot, path);
    if (!existsSync(fullPath)) {
      finalAuditBusinessViolations.push(`${path} (deleted by final auditor)`);
    } else {
      const currentDigest = await computeFileDigest(fullPath);
      if (currentDigest !== preDigest) {
        finalAuditBusinessViolations.push(`${path} (content modified)`);
      }
    }
  }

  // Pass 2: Detect new business files (in post-diff but not in pre-snapshot)
  for (const f of postFinalAuditDiffResult.changedFiles.files) {
    if (f.path.startsWith('.agent/')) continue;
    if (!preFinalAuditBusinessDigests.has(f.path)) {
      finalAuditBusinessViolations.push(`${f.path} (new)`);
    }
  }
  for (const f of postFinalAuditDiffResult.untrackedFiles.files) {
    if (f.path.startsWith('.agent/')) continue;
    if (!preFinalAuditBusinessDigests.has(f.path)) {
      finalAuditBusinessViolations.push(`${f.path} (new untracked)`);
    }
  }

  if (finalAuditBusinessViolations.length > 0) {
    await transitionToBlocked(stateStore, `Final Auditor modified business files: ${finalAuditBusinessViolations.join(', ')}`, eventBus);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final auditor workspace', 'FAIL', `Modified: ${finalAuditBusinessViolations.join(', ')}`);
    return makeBlockedResult(
      runId, projectRoot,
      `Final Auditor modified business files: ${finalAuditBusinessViolations.join(', ')}. Only .agent/final-audit.md may be written.`,
      'SCOPE_VIOLATION',
      currentBranch,
    );
  }

  // F-501: Use post-Final-Auditor diff for commit (includes final-audit.md)
  const commitDiffResult = postFinalAuditDiffResult;

  // §6.3: --no-commit path
  if (noCommit || !config.git.commit_on_pass) {
    await stateStore.update(() => ({
      commit_skipped: true,
      skip_reason: noCommit ? '--no-commit' : 'commit_on_pass is false',
      finalized_at: new Date().toISOString(),
    }));
    await stateStore.transition(PhaseEnum.PASSED);
    await emitProgress({ projectRoot, stateStore, lastEvent: 'Finalization PASSED (commit skipped)', registry: orchestratorRegistry, finalAuditDecision: 'PASS' });
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'finalization completed', 'PASS', 'commit skipped');

    const artifactPaths = VERSIONED_ARTIFACT_PATHS.map(p => p);
    await emitRunTerminal(eventBus, PhaseEnum.PASSED, 'Finalization PASSED. Commit skipped.', { artifact_refs: [...artifactPaths.map((p) => ({ type: 'state' as const, path: p })), { type: 'final-audit' as const, path: '.agent/final-audit.md' }] });
    return makeResult(
      runId, PhaseEnum.PASSED, 0, currentBranch, 'PASS',
      artifactPaths,
      'Final Audit PASSED. Commit skipped (--no-commit).',
      'Final Audit PASSED. Commit skipped.',
      null,
      null, true, null, false, noCommit ? '--no-commit' : 'commit_on_pass is false',
    );
  }

  // §6.1 step 9: Build the set of files to commit
  // F-501: Use commitDiffResult (post-Final-Auditor) instead of finalDiffResult
  const versionedArtifacts = VERSIONED_ARTIFACT_PATHS.filter(p => existsSync(join(projectRoot, p)));
  const businessFiles = commitDiffResult.changedFiles.files
    .map(f => f.path)
    .filter(p => !p.startsWith('.agent/'));
  const allCommitFiles = [...versionedArtifacts, ...businessFiles];
  const allowedSet = buildAllowedCommitSet(versionedArtifacts, businessFiles);

  // §6.1 step 10: Stage files
  const stageResult = await stageFiles(projectRoot, allCommitFiles);
  if (!stageResult.success) {
    await transitionToBlocked(stateStore, `Staging failed: ${stageResult.error}`, eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      `Staging failed: ${stageResult.error}`,
      'GIT_COMMIT_ERROR',
      currentBranch,
    );
  }

  // §6.1 step 11: Verify staged set
  const stagedFiles = await getStagedFiles(projectRoot);
  const violations = findStagedSetViolations(stagedFiles, allowedSet);
  if (violations.length > 0) {
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    await transitionToBlocked(stateStore, `Staged set violation: ${violations.join(', ')}`, eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      `Staged set contains disallowed files: ${violations.join(', ')}`,
      'PRE_COMMIT_STAGED_SET_VIOLATION',
      currentBranch,
    );
  }

  // §6.1 step 12: Create commit
  let commitMessage: string;
  try {
    const shortGoalDigest = goalDigest.replace('sha256:', '').slice(0, 12);
    commitMessage = renderCommitMessage(config.git.commit_template, {
      task_slug: (await stateStore.read()).task_slug,
      run_id: runId,
      iteration,
      short_goal_digest: shortGoalDigest,
    });
  } catch (err) {
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    await transitionToBlocked(stateStore, `Commit message template error: ${err instanceof Error ? err.message : String(err)}`, eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      `Commit message template error: ${err instanceof Error ? err.message : String(err)}`,
      'GIT_COMMIT_ERROR',
      currentBranch,
    );
  }

  const commitResult = await createCommit(projectRoot, commitMessage);
  if (!commitResult.success) {
    await transitionToBlocked(stateStore, `Commit failed: ${commitResult.error}`, eventBus);
    return makeBlockedResult(
      runId, projectRoot,
      `Commit failed: ${commitResult.error}`,
      'GIT_COMMIT_ERROR',
      currentBranch,
    );
  }

  const commitSha = commitResult.commitSha!;

  // Record commit in state
  await stateStore.update(() => ({
    final_commit_sha: commitSha,
    final_commit_message: commitMessage,
  }));

  // §6.4: Create tag if requested
  let tagName: string | null = null;
  let tagCreated = false;

  if (tag || config.git.create_tag) {
    try {
      const state = await stateStore.read();
      tagName = renderTagName(config.git.tag_template, {
        run_id: runId,
        task_slug: state.task_slug,
      });
    } catch (err) {
      await stateStore.update(() => ({
        last_error: `Tag template error: ${err instanceof Error ? err.message : String(err)}`,
        tag_name: null,
        tag_created: false,
      }));
      await stateStore.transition(PhaseEnum.BLOCKED);
      return makeResult(
        runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
        VERSIONED_ARTIFACT_PATHS.map(p => p),
        'Commit created but tag template error',
        `Commit ${commitSha.slice(0, 8)} created but tag template error: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: 'GIT_TAG_ERROR',
          message: `Tag template error: ${err instanceof Error ? err.message : String(err)}`,
          resumable: true,
          suggested_action: 'Fix tag template and resume to create tag',
        },
        commitSha, false, null, false,
      );
    }

    const existingTarget = await getTagTarget(projectRoot, tagName);
    if (existingTarget !== null) {
      if (existingTarget === commitSha) {
        tagCreated = true;
      } else {
        await stateStore.update(() => ({
          last_error: `Tag ${tagName} already exists pointing to ${existingTarget}, expected ${commitSha}`,
          tag_name: tagName,
          tag_created: false,
        }));
        await stateStore.transition(PhaseEnum.BLOCKED);
        return makeResult(
          runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
          VERSIONED_ARTIFACT_PATHS.map(p => p),
          'Commit created but tag conflict',
          `Commit ${commitSha.slice(0, 8)} created but tag ${tagName} points to different commit ${existingTarget.slice(0, 8)}`,
          {
            code: 'GIT_TAG_ERROR',
            message: `Tag ${tagName} already exists pointing to ${existingTarget}`,
            resumable: false,
            suggested_action: 'Resolve tag conflict manually',
          },
          commitSha, false, tagName, false,
        );
      }
    } else {
      const tagResult = await createTag(projectRoot, tagName, commitSha);
      if (!tagResult.success) {
        await stateStore.update(() => ({
          last_error: `Tag creation failed: ${tagResult.error}`,
          tag_name: tagName,
          tag_created: false,
        }));
        await stateStore.transition(PhaseEnum.BLOCKED);
        return makeResult(
          runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
          VERSIONED_ARTIFACT_PATHS.map(p => p),
          'Commit created but tag failed',
          `Commit ${commitSha.slice(0, 8)} created but tag failed: ${tagResult.error}`,
          {
            code: 'GIT_TAG_ERROR',
            message: `Tag creation failed: ${tagResult.error}`,
            resumable: true,
            suggested_action: 'Fix tag issue and resume to create tag',
          },
          commitSha, false, tagName, false,
        );
      }
      tagCreated = true;
    }
  }

  // §6.1 step 13: Transition to PASSED
  await stateStore.update(() => ({
    finalized_at: new Date().toISOString(),
    tag_name: tagName,
    tag_created: tagCreated,
  }));
  await stateStore.transition(PhaseEnum.PASSED);
  await emitProgress({ projectRoot, stateStore, lastEvent: 'Finalization PASSED', registry: orchestratorRegistry, commitSha: commitSha, finalAuditDecision: 'PASS' });
  await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'finalization completed', 'PASS');

  const artifactPaths = VERSIONED_ARTIFACT_PATHS.map(p => p);
  await emitRunTerminal(eventBus, PhaseEnum.PASSED, `Finalization PASSED. Committed as ${commitSha.slice(0, 8)}.`, {
    artifact_refs: [
      { type: 'diff', path: '.agent/evidence/diff.patch' },
      ...artifactPaths.map((p) => ({ type: 'state' as const, path: p })),
      { type: 'final-audit', path: '.agent/final-audit.md' },
    ],
    payload: { commit_sha: commitSha, tag_name: tagName, tag_created: tagCreated },
  });
  return makeResult(
    runId, PhaseEnum.PASSED, 0, currentBranch, 'PASS',
    artifactPaths,
    `Final Audit PASSED. Committed as ${commitSha.slice(0, 8)}${tagCreated && tagName ? `, tagged ${tagName}` : ''}.`,
    `Final Audit PASSED. Committed as ${commitSha.slice(0, 8)}.`,
    null,
    commitSha, false, tagName, tagCreated,
  );
}

/**
 * Phase 9 R1: classify an agent failure as a provider failure and emit a
 * structured `provider.failure` event when the stderr matches a known
 * provider signature (quota, rate-limit, overload, auth). Fail-soft and
 * observability-only — never affects scheduling.
 *
 * Returns true if a provider.failure was emitted, false otherwise.
 */
export async function emitProviderFailureIfClassified(params: {
  eventBus: IEventBus;
  stderrPath?: string;
  exitCode?: number | null;
  provider?: string;
  model?: string;
  role: string;
  phase: string;
}): Promise<boolean> {
  const { eventBus, stderrPath, exitCode, provider, model, role, phase } = params;
  if (!stderrPath || !provider) return false;
  try {
    const classification = await classifyProviderFailure({
      stderrPath,
      provider,
      exitCode,
    });
    if (!classification) return false;
    await eventBus.emit({
      kind: 'provider.failure',
      phase,
      level: 'error',
      message: `${role} provider failure (${provider}): ${classification.classification}`,
      role,
      provider,
      model,
      artifact_refs: [{ type: 'stderr', path: stderrPath }],
      payload: {
        classification: classification.classification,
        retry_recommended: classification.retry_recommended,
        evidence: classification.evidence,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase 9 R1: emit a terminal run event for observability. Fail-soft.
 * Maps the orchestrator terminal phase to the matching event kind.
 */
export async function emitRunTerminal(
  eventBus: IEventBus,
  phase: Phase,
  message: string,
  extra?: Partial<EventDraft>,
): Promise<void> {
  const kind: EventDraft['kind'] =
    phase === PhaseEnum.PASSED ? 'run.completed'
    : phase === PhaseEnum.BLOCKED ? 'run.blocked'
    : phase === PhaseEnum.FAILED ? 'run.failed'
    : 'run.completed';
  const level: EventDraft['level'] =
    phase === PhaseEnum.PASSED ? 'info'
    : phase === PhaseEnum.FAILED ? 'error'
    : 'warn';
  await eventBus.emit({
    kind,
    phase,
    level,
    message,
    status: phase,
    ...extra,
  });
}

export function makeResult(
  runId: string,
  phase: Phase,
  exitCode: number,
  branch: string,
  auditDecision: string | null,
  artifactPaths: string[],
  nextAction: string,
  message: string,
  error: ReviewLoopError | null,
  commitSha: string | null = null,
  commitSkipped: boolean = false,
  tagName: string | null = null,
  tagCreated: boolean = false,
  skipReason: string | null = null,
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
    commit_sha: commitSha,
    commit_skipped: commitSkipped,
    tag_name: tagName,
    tag_created: tagCreated,
    skip_reason: skipReason,
  };
}

export function makeBlockedResult(
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

function readR2IntegrationBranch(projectRoot: string, runId: string): string | null {
  const metadataPath = join(projectRoot, '.agent', 'integration', 'integrated-diff-metadata.json');
  if (!existsSync(metadataPath)) return null;

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      run_id?: unknown;
      integration_branch?: unknown;
    };
    if (metadata.run_id !== runId) return null;
    if (typeof metadata.integration_branch !== 'string') return null;
    return metadata.integration_branch;
  } catch {
    return null;
  }
}

// ─── Phase 4 Helper Functions ────────────────────────────────

/**
 * Check for a cancel request in .agent/cancel-request.json.
 * Returns the parsed CancelRequest if present and valid, or null.
 */
export async function checkCancelRequest(agentDir: string): Promise<CancelRequest | null> {
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
export function snapshotSystemPaths(
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
    join(agentDir, 'task-graph.json'),
    join(agentDir, 'task-results.json'),
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

function refreshSystemPathSnapshot(
  paths: Map<string, { digest: string; mode: number; isSymlink: boolean }>,
  filePath: string,
): void {
  if (!existsSync(filePath)) return;
  try {
    const stat = lstatSync(filePath);
    if (stat.isDirectory()) return;
    paths.set(filePath, {
      digest: computeDigest(readFileSync(filePath, 'utf8')),
      mode: stat.mode,
      isSymlink: stat.isSymbolicLink(),
    });
  } catch { /* best effort: verification will report if the file is invalid */ }
}

/**
 * Register agent stdout/stderr log files in the orchestrator registry.
 */
export function registerAgentLogs(
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
export function registerDirectoryFiles(dirPath: string, registry: OrchestratorFileRegistry): void {
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

// ─── Phase 6: Progress & Transcript Helpers ──────────────────

export async function emitProgress(params: {
  projectRoot: string;
  stateStore: StateStore;
  lastEvent: string;
  registry?: OrchestratorFileRegistry;
  commitSha?: string | null;
  finalAuditDecision?: string | null;
}): Promise<void> {
  try {
    const state = await params.stateStore.read();
    // Phase 8B: preserve task_graph progress across non-task progress writes
    // (e.g. finalization) so the final progress.json still reflects task state.
    let preservedTaskGraph: import('../types.js').TaskProgressInfo | null = null;
    const existingProgressPath = join(params.projectRoot, '.agent', 'progress.json');
    if (existsSync(existingProgressPath)) {
      try {
        const existing = JSON.parse(readFileSync(existingProgressPath, 'utf8'));
        if (existing?.task_graph) preservedTaskGraph = existing.task_graph;
      } catch { /* ignore */ }
    }
    const data = buildProgressData({
      run_id: state.run_id,
      phase: state.phase,
      iteration: state.iteration,
      max_iterations: state.max_iterations,
      branch: state.branch,
      task_slug: state.task_slug,
      started_at: state.started_at,
      stages: state.stages as Record<string, import('../types.js').StageInfo>,
      commit_sha: params.commitSha ?? state.final_commit_sha,
      final_audit_decision: params.finalAuditDecision ?? null,
      last_event: params.lastEvent,
      task_graph: state.task_graph_state ? preservedTaskGraph : null,
    });
    await writeProgress(params.projectRoot, data);
    writeProgressMarkdown(params.projectRoot, data);
    // Register as orchestrator-owned so Scope Guard excludes them
    if (params.registry) {
      const jsonPath = join(params.projectRoot, '.agent', 'progress.json');
      const mdPath = join(params.projectRoot, '.agent', 'progress.md');
      if (existsSync(jsonPath)) params.registry.register(jsonPath, computeDigest(readFileSync(jsonPath, 'utf8')));
      if (existsSync(mdPath)) params.registry.register(mdPath, computeDigest(readFileSync(mdPath, 'utf8')));
    }
  } catch { /* progress writing is best-effort */ }
}

export function emitTranscript(params: {
  projectRoot: string;
  role: import('../types.js').TranscriptEntry['role'];
  iteration: number;
  runId: string;
  startedAt: string;
  result: import('../types.js').AgentRunResult;
  registry?: OrchestratorFileRegistry;
}): void {
  try {
    const entry = buildTranscriptEntry({
      role: params.role,
      iteration: params.iteration,
      run_id: params.runId,
      started_at: params.startedAt,
      result: params.result,
    });
    writeTranscript(params.projectRoot, entry);
    // Register as orchestrator-owned so Scope Guard excludes it
    if (params.registry) {
      const iterStr = String(params.iteration).padStart(2, '0');
      const transcriptPath = join(params.projectRoot, '.agent', 'transcripts', `iteration-${iterStr}-${params.role}.md`);
      if (existsSync(transcriptPath)) {
        params.registry.register(transcriptPath, computeDigest(readFileSync(transcriptPath, 'utf8')));
      }
    }
  } catch { /* transcript writing is best-effort */ }
}
