/**
 * Phase enumeration — all legal states in the Goal Review Loop.
 * Design doc §7.2
 */
export const Phase = {
  INITIALIZING: 'INITIALIZING',
  PLANNING: 'PLANNING',
  DEVELOPING: 'DEVELOPING',
  VERIFYING: 'VERIFYING',
  AUDITING: 'AUDITING',
  REWORKING: 'REWORKING',
  FINALIZING: 'FINALIZING',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

/** Terminal phases — no automatic transition out of these. */
export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set([
  Phase.PASSED,
  Phase.FAILED,
  Phase.BLOCKED,
  Phase.CANCELLED,
]);

/** Active (non-terminal) phases. */
export const ACTIVE_PHASES: ReadonlySet<Phase> = new Set(
  (Object.values(Phase) as Phase[]).filter((p) => !TERMINAL_PHASES.has(p)),
);

/**
 * Legal state transitions — Design doc §7.3
 * Key = current phase, Value = set of allowed next phases.
 */
export const LEGAL_TRANSITIONS: ReadonlyMap<Phase, ReadonlySet<Phase>> = new Map([
  [Phase.INITIALIZING, new Set([Phase.PLANNING, Phase.BLOCKED, Phase.CANCELLED])],
  [Phase.PLANNING, new Set([Phase.DEVELOPING, Phase.BLOCKED, Phase.CANCELLED])],
  [Phase.DEVELOPING, new Set([Phase.VERIFYING, Phase.BLOCKED, Phase.CANCELLED])],
  [Phase.VERIFYING, new Set([Phase.AUDITING, Phase.REWORKING, Phase.BLOCKED, Phase.CANCELLED])],
  [Phase.AUDITING, new Set([Phase.FINALIZING, Phase.REWORKING, Phase.BLOCKED, Phase.CANCELLED])],
  [Phase.REWORKING, new Set([Phase.DEVELOPING, Phase.VERIFYING, Phase.BLOCKED, Phase.FAILED, Phase.CANCELLED])],
  [Phase.FINALIZING, new Set([Phase.PASSED, Phase.BLOCKED])],
  // Terminal phases — no outgoing transitions
  [Phase.PASSED, new Set()],
  [Phase.FAILED, new Set()],
  [Phase.BLOCKED, new Set()],
  [Phase.CANCELLED, new Set()],
]);

/**
 * Stage status within a phase.
 */
export const StageStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type StageStatus = (typeof StageStatus)[keyof typeof StageStatus];

/**
 * Stage info for state.json
 */
export interface StageInfo {
  status: StageStatus;
  attempts: number;
  at?: string; // ISO timestamp
}

/**
 * state.json schema — Design doc §7
 */
export interface RunState {
  schema_version: 1;
  run_id: string;
  task_slug: string;
  phase: Phase;
  iteration: number;
  max_iterations: number;
  project_root: string;
  base_commit: string;
  branch: string;
  goal_digest: string | null;
  audited_diff_digest: string | null;
  started_at: string;
  updated_at: string;
  last_error: string | null;
  /** ISO timestamp when cancel was requested, or null. */
  cancel_requested_at: string | null;
  stages: Record<string, StageInfo>;
}

/**
 * Agent result — Design doc §9.1
 * Phase 2 legacy interface; retained for backward compatibility.
 */
export const AgentResultStatus = {
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
} as const;

export type AgentResultStatus = (typeof AgentResultStatus)[keyof typeof AgentResultStatus];

export interface AgentResult {
  status: AgentResultStatus;
  exit_code: number | null;
  stdout_path: string;
  stderr_path: string;
  artifact_path: string | null;
  error: string | null;
}

/**
 * Phase 3: Agent Run Input — §8.1
 * Unified input for all three role adapters.
 */
export interface AgentRunInput {
  role: 'planner' | 'developer' | 'auditor';
  project_root: string;
  run_id: string;
  iteration: number;
  prompt: string;
  prompt_file?: string;
  expected_artifacts: string[];
  timeout_seconds: number;
  command_template: string[];
  signal?: AbortSignal;
}

/**
 * Phase 3: Agent Run Result — §8.2
 * Unified output from all three role adapters.
 */
export interface AgentRunResult {
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  exit_code: number | null;
  stdout_path: string;
  stderr_path: string;
  artifact_paths: string[];
  prompt_digest: string;
  duration_ms: number;
  error: ReviewLoopError | null;
}

/**
 * Error categories — Design doc §17
 */
export const ErrorCategory = {
  CONFIG_ERROR: 'CONFIG_ERROR',
  PREFLIGHT_ERROR: 'PREFLIGHT_ERROR',
  AGENT_ERROR: 'AGENT_ERROR',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  ARTIFACT_ERROR: 'ARTIFACT_ERROR',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  AUDIT_FAILED: 'AUDIT_FAILED',
  AUDIT_BLOCKED: 'AUDIT_BLOCKED',
  STATE_CONFLICT: 'STATE_CONFLICT',
  LOCK_CONFLICT: 'LOCK_CONFLICT',
  GIT_COMMIT_ERROR: 'GIT_COMMIT_ERROR',
  USER_CANCELLED: 'USER_CANCELLED',
  INFRASTRUCTURE_ERROR: 'INFRASTRUCTURE_ERROR',
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/**
 * Default result for each error category — Design doc §17
 */
export const ERROR_CATEGORY_DEFAULT_RESULT: ReadonlyMap<ErrorCategory, Phase> = new Map([
  [ErrorCategory.CONFIG_ERROR, Phase.BLOCKED],
  [ErrorCategory.PREFLIGHT_ERROR, Phase.BLOCKED],
  [ErrorCategory.AGENT_ERROR, Phase.BLOCKED],
  [ErrorCategory.AGENT_TIMEOUT, Phase.BLOCKED],
  [ErrorCategory.ARTIFACT_ERROR, Phase.FAILED],
  [ErrorCategory.SCOPE_VIOLATION, Phase.FAILED],
  [ErrorCategory.VERIFICATION_FAILED, Phase.FAILED],
  [ErrorCategory.AUDIT_FAILED, Phase.FAILED],
  [ErrorCategory.AUDIT_BLOCKED, Phase.BLOCKED],
  [ErrorCategory.STATE_CONFLICT, Phase.BLOCKED],
  [ErrorCategory.LOCK_CONFLICT, Phase.BLOCKED],
  [ErrorCategory.GIT_COMMIT_ERROR, Phase.BLOCKED],
  [ErrorCategory.USER_CANCELLED, Phase.CANCELLED],
  [ErrorCategory.INFRASTRUCTURE_ERROR, Phase.BLOCKED],
]);

/**
 * Structured error record — Phase 4 §12
 * Extended with phase, iteration, evidence_paths, and suggested_next_action.
 */
export interface ReviewLoopError {
  code: ErrorCategory;
  message: string;
  exit_code?: number;
  log_path?: string;
  /** Phase where the error occurred. */
  phase?: Phase;
  /** Iteration when the error occurred. */
  iteration?: number;
  /** Whether the error is retryable (e.g. transient infra failure). */
  retryable?: boolean;
  resumable: boolean;
  /** Paths to evidence files related to this error. */
  evidence_paths?: string[];
  /** Suggested next action for the user. */
  suggested_next_action?: string;
  /** @deprecated Use suggested_next_action instead. */
  suggested_action: string;
}

/**
 * Audit decision — Design doc §8.4
 * Used in audit-report.md: PASS | FAIL | BLOCKED
 */
export const AuditDecision = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
} as const;

export type AuditDecision = (typeof AuditDecision)[keyof typeof AuditDecision];

/**
 * Final audit decision — Design doc §8.5
 * Used in final-audit.md: PASS | FAILED | BLOCKED
 * Note: final-audit uses FAILED (not FAIL) per requirements.
 */
export const FinalAuditDecision = {
  PASS: 'PASS',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
} as const;

export type FinalAuditDecision = (typeof FinalAuditDecision)[keyof typeof FinalAuditDecision];

/**
 * Developer handoff status — Design doc §8.3
 */
export const HandoffStatus = {
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
} as const;

export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus];

/**
 * GOAL verification command — external protocol format.
 * Phase 3 §6.1: GOAL.md uses `command` field; normalized to `argv` internally.
 */
export interface GoalVerificationCommand {
  id: string;
  command: string[];
  cwd: string;
  required: boolean;
  timeout_seconds: number;
}

/**
 * Internal verification command — used by Verification Runner.
 * Phase 3 §6.1: normalized from GoalVerificationCommand via normalizeGoalCommands().
 */
export interface VerificationCommand {
  id: string;
  argv: string[];
  cwd: string;
  required: boolean;
  timeout_seconds: number;
}

/**
 * GOAL front matter — Design doc §8.2
 * Phase 3: verification_commands uses GoalVerificationCommand (with `command` field).
 */
export interface GoalFrontMatter {
  schema_version: number;
  run_id: string;
  goal_id: string;
  title: string;
  allowed_changes: string[];
  disallowed_changes: string[];
  verification_commands: GoalVerificationCommand[];
}

/**
 * plan.md front matter — Design doc §8.1
 */
export interface PlanFrontMatter {
  schema_version: number;
  run_id: string;
  author_role: 'planner';
}

/**
 * developer-handoff.md front matter — Design doc §8.3
 */
export interface HandoffFrontMatter {
  schema_version: number;
  run_id: string;
  iteration: number;
  author_role: 'developer';
  status: HandoffStatus;
}

/**
 * audit-report.md front matter — Design doc §8.4
 */
export interface AuditReportFrontMatter {
  schema_version: number;
  run_id: string;
  iteration: number;
  author_role: 'auditor';
  decision: AuditDecision;
  audited_goal_digest: string;
  audited_diff_digest: string;
}

/**
 * final-audit.md front matter — Design doc §8.5
 * decision uses FinalAuditDecision: PASS | FAILED | BLOCKED
 */
export interface FinalAuditFrontMatter {
  schema_version: number;
  run_id: string;
  author_role: 'auditor';
  decision: FinalAuditDecision;
  final_iteration: number;
  goal_digest: string;
  diff_digest: string;
}

/**
 * Iteration log entry — Design doc §8.6
 * Machine-parseable structured record for iteration-log.md
 */
export interface IterationLogEntry {
  timestamp: string;       // ISO 8601
  run_id: string;
  iteration: number;
  phase: Phase;
  event: string;           // e.g. "preflight", "planner completed", "unit-tests"
  result: 'PASS' | 'FAIL' | 'BLOCKED' | 'TIMEOUT' | 'CANCELLED';
  detail?: string;         // Optional additional info
}

/**
 * Lock file content — Design doc §16.3
 */
export interface LockInfo {
  run_id: string;
  pid: number;
  hostname: string;
  created_at: string;
}

/**
 * Configuration — Design doc §5
 */
export interface ReviewLoopConfig {
  version: number;
  agents: {
    planner: AgentConfig;
    developer: AgentConfig;
    auditor: AgentConfig;
  };
  loop: {
    max_iterations: number;
    /** Whether to archive per-iteration history. Default: true. */
    archive_history: boolean;
    /** Whether to stop on infrastructure errors instead of retrying. Default: true. */
    stop_on_infrastructure_error: boolean;
  };
  git: GitConfig;
  runtime: RuntimeConfig;
}

export interface AgentConfig {
  command: string[];
  timeout_seconds: number;
}

export interface GitConfig {
  require_repository: boolean;
  require_head: boolean;
  require_clean_worktree: boolean;
  branch_template: string;
  commit_on_pass: boolean;
  commit_template: string;
  create_tag: boolean;
  tag_template: string;
  push: boolean;
}

export interface RuntimeConfig {
  kill_grace_seconds: number;
  max_log_bytes: number;
  lock_stale_seconds: number;
  /** Grace period in seconds for cancel to take effect before force-killing. Default: 10. */
  cancel_grace_seconds: number;
}

/**
 * Scope guard result — Design doc §12.2
 */
export interface ScopeReport {
  passed: boolean;
  allowed: string[];
  denied: ScopeDenial[];
}

export interface ScopeDenial {
  path: string;
  reason: 'system_protected' | 'disallowed_change' | 'outside_allowed_changes';
}

/**
 * Verification manifest — Design doc §13.2
 */
export interface VerificationManifest {
  schema_version: number;
  run_id: string;
  iteration: number;
  passed: boolean;
  started_at: string;
  finished_at: string;
  commands: VerificationResult[];
}

export interface VerificationResult {
  id: string;
  argv: string[];
  cwd: string;
  required: boolean;
  status: 'success' | 'failed' | 'timeout';
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_path: string;
  stderr_path: string;
  log_io_error?: string;
}

/**
 * Phase 2: Process Runner types — Design doc §7.1
 */

export const ProcessStatus = {
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
} as const;

export type ProcessStatus = (typeof ProcessStatus)[keyof typeof ProcessStatus];

export interface ProcessRunnerInput {
  argv: string[];
  cwd: string;
  timeout_ms: number;
  stdout_path: string;
  stderr_path: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  kill_grace_seconds?: number;
  max_log_bytes?: number;
}

export interface ProcessRunnerResult {
  status: ProcessStatus;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  duration_ms: number;
  stdout_path: string;
  stderr_path: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  kill_result?: {
    success: boolean;
    method: string;
    timedOut?: boolean;
  };
  log_io_error?: string;
}

/**
 * Phase 2: Git Manager types — Design doc §7.2, §7.3
 */

export const PreflightStatus = {
  OK: 'ok',
  ERROR: 'error',
} as const;

export type PreflightStatus = (typeof PreflightStatus)[keyof typeof PreflightStatus];

export interface PreflightResult {
  status: PreflightStatus;
  git_root: string | null;
  head_sha: string | null;
  branch: string | null;
  is_clean: boolean | null;
  tracked_agent_files: string[];
  error?: PreflightError;
}

export interface PreflightError {
  code: 'PREFLIGHT_ERROR';
  message: string;
  check: string;
}

export interface TaskBranchResult {
  status: 'created' | 'error';
  branch_name: string;
  base_commit: string;
  original_branch: string;
  error?: {
    code: 'STATE_CONFLICT' | 'PREFLIGHT_ERROR';
    message: string;
  };
}

/**
 * Phase 2: Diff Collector types — Design doc §7.4
 */

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  status: FileStatus;
  old_path?: string;
  tracked: boolean;
  additions: number | null;
  deletions: number | null;
}

export interface ChangedFilesSchema {
  schema_version: 1;
  base_commit: string;
  files: ChangedFile[];
}

export interface UntrackedFileEvidence {
  path: string;
  size_bytes: number;
  sha256: string;
  is_text: boolean;
  has_content: boolean;
  content: string | null;
  omitted_reason?: 'binary' | 'too_large' | 'symlink_escape';
}

export interface UntrackedFilesSchema {
  schema_version: 1;
  files: UntrackedFileEvidence[];
}

export interface DiffMetadata {
  schema_version: 1;
  base_commit: string;
  generated_at: string;
  tracked_diff_summary: {
    files_changed: number;
    insertions: number;
    deletions: number;
  };
  changed_files_summary: {
    total: number;
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    untracked: number;
  };
  untracked_files_summary: {
    total: number;
    text_files: number;
    binary_files: number;
  };
  diff_digest: string;
}

/**
 * Phase 2: Scope Guard types — Design doc §7.5
 */

export const ScopeDenialReason = {
  SYSTEM_PROTECTED: 'system_protected',
  DISALLOWED_CHANGE: 'disallowed_change',
  OUTSIDE_ALLOWED_CHANGES: 'outside_allowed_changes',
  UNAUTHORIZED_TEST_DELETION: 'unauthorized_test_deletion',
} as const;

export type ScopeDenialReason = (typeof ScopeDenialReason)[keyof typeof ScopeDenialReason];

export interface ScopeWarning {
  code: string;
  message: string;
  path?: string;
}

export interface ScopeReportV2 {
  schema_version: 2;
  passed: boolean;
  allowed: string[];
  excluded_orchestrator_owned: string[];
  excluded_dependency_cache: string[];
  denied: Array<{
    path: string;
    reason: ScopeDenialReason;
  }>;
  warnings: ScopeWarning[];
}

/**
 * F-307R2: Orchestrator File Registry — explicit ownership tracking.
 * The orchestrator registers every file it writes (path + digest).
 * Pattern-based inference of orchestrator ownership is replaced by this
 * explicit registry to prevent Developer from forging evidence files.
 */
export interface OrchestratorFileRegistryEntry {
  /** Absolute path of the file. */
  path: string;
  /** SHA-256 digest of the file content at registration time. */
  digest: string;
  /** ISO timestamp when the file was registered. */
  registered_at: string;
}

/**
 * Result of verifying the orchestrator file registry after Developer call.
 */
export interface OrchestratorRegistryVerificationResult {
  /** Whether all registered files are intact. */
  valid: boolean;
  /** Violations found during verification. */
  violations: OrchestratorRegistryViolation[];
}

export interface OrchestratorRegistryViolation {
  /** Path of the violated file. */
  path: string;
  /** Type of violation. */
  violation: 'digest_mismatch' | 'deleted' | 'mode_changed' | 'symlink_created' | 'unregistered_new';
  /** Human-readable description. */
  message: string;
}

/**
 * Phase 2: Mechanical Finding — Design doc §7.6.3
 */
export interface MechanicalFinding {
  id: string;
  command_id: string;
  status: ProcessStatus;
  exit_code: number | null;
  stdout_path: string;
  stderr_path: string;
  log_io_error?: string;
}

/**
 * Phase 4: Rework Instructions front matter — §7.1
 * Written by Orchestrator, read-only for Developer.
 */
export interface ReworkInstructionsFrontMatter {
  schema_version: number;
  run_id: string;
  iteration: number;
  author_role: 'orchestrator';
  source: 'scope' | 'verification' | 'audit' | 'artifact';
  status: 'REWORK_REQUIRED';
}

/**
 * Phase 4: Rework Finding — §7.2
 * Each finding describes a specific issue that must be fixed.
 */
export interface ReworkFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  source: 'scope' | 'verification' | 'audit' | 'artifact';
  path: string;
  evidence: string;
  required_fix: string;
  /** Verification-specific fields. */
  command_id?: string;
  argv?: string[];
  exit_code?: number | null;
  stdout_path?: string;
  stderr_path?: string;
  timed_out?: boolean;
  /** Scope-specific fields. */
  denial_reason?: string;
  scope_report_path?: string;
}

/**
 * Phase 4: Cancel Request — §11.2
 * Written by `review-loop cancel`, checked by Orchestrator.
 */
export interface CancelRequest {
  schema_version: number;
  run_id: string;
  requested_at: string;
  requested_by: string;
}

/**
 * Phase 4: Status Output — §10
 * Structured output for `review-loop status --json`.
 */
export interface StatusOutput {
  run_id: string;
  phase: Phase;
  iteration: number;
  max_iterations: number;
  branch: string;
  base_commit: string;
  goal_digest: string | null;
  audited_diff_digest: string | null;
  last_error: ReviewLoopError | null;
  lock_status: 'held' | 'stale' | 'none';
  lock_info: LockInfo | null;
  started_at: string;
  updated_at: string;
  next_step: string;
}
