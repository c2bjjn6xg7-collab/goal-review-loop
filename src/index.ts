/**
 * Public API — exports all core modules.
 */
export * from './types.js';

export { StateStore } from './orchestrator/state-store.js';
export { isLegalTransition, validateTransition, isTerminal, allowedNextPhases, nextAfterVerification, nextAfterAudit, shouldFailAfterRework, StateMachineError } from './orchestrator/state-machine.js';
export { runOrchestrator, type OrchestratorResult } from './orchestrator/run-orchestrator.js';

export { ArtifactStore, ARTIFACT_FILES, ARTIFACT_DIRS, VERSIONED_ARTIFACTS, LOCAL_ONLY_ARTIFACTS } from './artifacts/artifact-store.js';
export { parseFrontMatter, serializeFrontMatter, validateRequiredFields, validateEnumField, FrontMatterError } from './artifacts/front-matter.js';
export { parsePlan, parseGoal, parseHandoff, parseAuditReport, parseFinalAudit, parseIterationLog, validateIterationLogEntry, normalizeGoalCommands } from './artifacts/artifact-schemas.js';
export { loadConfig, loadConfigWithDefaults, generateSampleConfig, validateMvpConstraints, DEFAULT_CONFIG, ConfigError } from './artifacts/config.js';

export { LockManager, LockManagerError } from './runtime/lock-manager.js';
export { atomicWriteFile, atomicWriteJSON } from './runtime/atomic-file.js';
export { runProcess, ProcessRunnerError } from './runtime/process-runner.js';
export { computeDigest, computeDigestFromBuffer, computeFileDigest, verifyDigest, verifyFileDigest, recordArtifactDigests, verifyArtifactDigests, type Digest, type ArtifactDigestRecord, type ArtifactDigestViolation } from './runtime/digest.js';

export { createCLI } from './cli/index.js';

export { runGit, preflight, createTaskBranch, GitManagerError } from './git/git-manager.js';
export { parsePorcelainStatus, parseNameStatus, parseNumstat } from './git/git-parsers.js';
export { collectDiff, writeDiffArtifacts } from './git/diff-collector.js';

export { checkScope, checkSuspiciousTestMarkers, checkTestConfigDisabled, writeScopeReport } from './scope/scope-guard.js';

export { runVerification, VerificationRunnerError } from './verification/verification-runner.js';

// Phase 3: Agent modules
export { renderCommand, validateCommandTemplate, ALLOWED_PLACEHOLDERS, CommandRendererError, type CommandRenderValues } from './agents/command-renderer.js';
export { buildPlannerPrompt, buildDeveloperPrompt, buildAuditorPrompt, buildPrompt, loadPromptTemplate, writePromptFile, computePromptDigest, PROMPT_TEMPLATE_VERSION, type PromptBuildResult, type PlannerPromptContext, type DeveloperPromptContext, type AuditorPromptContext, PromptBuilderError } from './agents/prompt-builder.js';
export { runAgent, recordPreCallState, verifyArtifactFreshness, type PreCallArtifactState, type ArtifactFreshnessViolation } from './agents/agent-adapter.js';
export { buildPlannerInput, validatePlannerOutput, type PlannerValidationResult } from './agents/planner-adapter.js';
export { buildDeveloperInput, validateDeveloperOutput, type DeveloperValidationResult } from './agents/developer-adapter.js';
export { buildAuditorInput, validateAuditorOutput, type AuditorValidationResult } from './agents/auditor-adapter.js';
