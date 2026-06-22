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
  [Phase.FINALIZING, new Set([Phase.PASSED, Phase.BLOCKED, Phase.CANCELLED])],
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
  /**
   * Phase 8D P6: consecutive tracked failure count for the run-level circuit
   * breaker. Starts at 0 and is wired into failure paths in later P6 rounds.
   */
  consecutive_failure_count: number;
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
  /** SHA of the final commit, if created. */
  final_commit_sha: string | null;
  /** The commit message used. */
  final_commit_message: string | null;
  /** ISO timestamp when finalization completed. */
  finalized_at: string | null;
  /** Whether commit was skipped (--no-commit or other reason). */
  commit_skipped: boolean;
  /** Reason commit was skipped, if applicable. */
  skip_reason: string | null;
  /** Tag name, if created. */
  tag_name: string | null;
  /** Whether the tag was successfully created. */
  tag_created: boolean;
  stages: Record<string, StageInfo>;
  /** Phase 8B: task graph execution state, or null when no task graph. */
  task_graph_state: TaskGraphState | null;
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
  role: 'planner' | 'developer' | 'auditor' | 'final-auditor';
  project_root: string;
  run_id: string;
  iteration: number;
  /**
   * 1-indexed retry attempt within the same iteration.
   * When present and >= 2, appended to debug log filenames as `-attempt${N}`
   * to avoid orchestrator-registered file digest mismatches across retries.
   * Default behavior (undefined or 1) keeps original `iter${iteration}.stdout.log` naming.
   */
  attempt?: number;
  prompt: string;
  prompt_file?: string;
  expected_artifacts: string[];
  timeout_seconds: number;
  command_template: string[];
  signal?: AbortSignal;
  /** Phase 8F: Per-provider network/proxy configuration for this agent run. */
  network?: ProviderNetworkConfig;
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
  FINAL_AUDIT_FAILED: 'FINAL_AUDIT_FAILED',
  FINAL_AUDIT_SCHEMA_ERROR: 'FINAL_AUDIT_SCHEMA_ERROR',
  PRE_COMMIT_DIGEST_MISMATCH: 'PRE_COMMIT_DIGEST_MISMATCH',
  PRE_COMMIT_SCOPE_VIOLATION: 'PRE_COMMIT_SCOPE_VIOLATION',
  PRE_COMMIT_STAGED_SET_VIOLATION: 'PRE_COMMIT_STAGED_SET_VIOLATION',
  GIT_TAG_ERROR: 'GIT_TAG_ERROR',
  UNSUPPORTED_PUSH: 'UNSUPPORTED_PUSH',
  USER_CANCELLED: 'USER_CANCELLED',
  INFRASTRUCTURE_ERROR: 'INFRASTRUCTURE_ERROR',
  CONSECUTIVE_FAILURE_LIMIT: 'CONSECUTIVE_FAILURE_LIMIT',
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
  [ErrorCategory.FINAL_AUDIT_FAILED, Phase.BLOCKED],
  [ErrorCategory.FINAL_AUDIT_SCHEMA_ERROR, Phase.BLOCKED],
  [ErrorCategory.PRE_COMMIT_DIGEST_MISMATCH, Phase.BLOCKED],
  [ErrorCategory.PRE_COMMIT_SCOPE_VIOLATION, Phase.BLOCKED],
  [ErrorCategory.PRE_COMMIT_STAGED_SET_VIOLATION, Phase.BLOCKED],
  [ErrorCategory.GIT_TAG_ERROR, Phase.BLOCKED],
  [ErrorCategory.UNSUPPORTED_PUSH, Phase.BLOCKED],
  [ErrorCategory.USER_CANCELLED, Phase.CANCELLED],
  [ErrorCategory.INFRASTRUCTURE_ERROR, Phase.BLOCKED],
  [ErrorCategory.CONSECUTIVE_FAILURE_LIMIT, Phase.FAILED],
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
  audit_report_digest: string;
  verification_manifest_digest: string;
  created_at: string;
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
    final_auditor: AgentConfig;
  };
  providers?: Record<string, ProviderConfig>;
  loop: {
    max_iterations: number;
    /** Whether to archive per-iteration history. Default: true. */
    archive_history: boolean;
    /** Whether to stop on infrastructure errors instead of retrying. Default: true. */
    stop_on_infrastructure_error: boolean;
    /** Phase 8D P6: run-level circuit breaker threshold. Default: 3. */
    max_consecutive_failures: number;
    /** Phase 8D P6: same-provider retry budget. Default: 3. */
    max_agent_retries: number;
  };
  git: GitConfig;
  runtime: RuntimeConfig;
  /** Phase 10: Agent feedback block protocol (ReviewLoopRequest). */
  feedback_protocol: FeedbackProtocolConfig;
  /**
   * Phase 8D P5 Round 1: optional parallel-execution config. Round 1 only
   * stores the configuration; downstream rounds opt the orchestrator into
   * wave scheduling. When absent, defaults are
   * `{ enabled: false, max_parallel_workers: 1 }`.
   */
  parallel?: ParallelConfig;
}

export interface AgentConfig {
  command: string[];
  timeout_seconds: number;
  provider?: string;
  model?: string;
}

/**
 * Phase 8D P5 Round 1: parallel-execution configuration. The orchestrator
 * only acts on `enabled`; `max_parallel_workers` is configuration data that
 * later rounds use to size wave-scheduled execution. `max_parallel_workers`
 * is constrained to the range [1, 16].
 */
export interface ParallelConfig {
  enabled: boolean;
  max_parallel_workers: number;
}

/**
 * Phase 8F: Per-provider proxy mode.
 * - inherit: preserve current behavior (full shell env inheritance).
 * - none: unset all proxy-related env vars for the child process.
 * - auto: TCP-probe candidate_ports on 127.0.0.1; set proxy if open.
 * - custom: set proxy vars to the configured proxy_url.
 */
export type ProxyMode = 'inherit' | 'none' | 'auto' | 'custom';

/**
 * Phase 8F: Per-provider network/proxy configuration.
 */
export interface ProviderNetworkConfig {
  proxy_mode: ProxyMode;
  /** Ports to probe in auto mode. Defaults to DEFAULT_CANDIDATE_PORTS if omitted. */
  candidate_ports?: number[];
  /** Required when proxy_mode === 'custom'. */
  proxy_url?: string;
}

export interface ProviderConfig {
  enabled: boolean;
  command_template?: string[];
  prompt_transport?: 'stdin' | 'prompt_file' | 'argv';
  health_check?: string[];
  permission_mode?: string;
  allowed_tools?: string;
  transcript_mode?: 'stdout_stderr' | 'jsonl' | 'none';
  /** Non-secret environment overrides only. Do not store API keys here. */
  env?: Record<string, string>;
  /** Phase 8F: Per-provider network/proxy configuration. */
  network?: ProviderNetworkConfig;
}

export interface ProviderProfile {
  provider_id: string;
  display_name: string;
  command_template: string[];
  prompt_transport: 'stdin' | 'prompt_file' | 'argv';
  health_check?: string[];
  permission_modes: string[];
  transcript_mode: 'stdout_stderr' | 'jsonl' | 'none';
  enabled: boolean;
  capability_tier?: 'strong' | 'balanced' | 'cheap';
  cost_tier?: 'high' | 'medium' | 'low';
  recommended_task_types?: string[];
  max_parallel_runs?: number;
  sensitive_task_allowed?: boolean;
  worker_roles?: string[];
  escalation_target?: string;
  env?: Record<string, string>;
  /** Phase 8F: Per-provider network/proxy configuration. */
  network?: ProviderNetworkConfig;
}

/**
 * Phase 8B: Task graph progress info attached to progress.json.
 */
export interface TaskProgressInfo {
  current_task_id: string | null;
  current_task_title: string | null;
  /** Human-readable label, e.g. "Task 2 of 5". */
  task_index: string;
  /** running | passed | failed | rework. */
  task_status: string;
  /** Overall graph progress label, e.g. "1/5 complete". */
  overall_progress: string;
}

export interface ProgressData {
  schema_version: 1;
  run_id: string;
  phase: Phase;
  iteration: number;
  max_iterations: number;
  branch: string;
  task_slug: string;
  started_at: string;
  updated_at: string;
  last_event: string;
  last_event_at: string;
  stages: Record<string, StageInfo>;
  commit_sha: string | null;
  final_audit_decision: string | null;
  /** Phase 8B: task graph progress, when a task graph is active. */
  task_graph?: TaskProgressInfo | null;
}

export interface TranscriptEntry {
  role: 'planner' | 'developer' | 'auditor' | 'final-auditor';
  iteration: number;
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  exit_code: number | null;
  stdout_summary: string;
  stderr_summary: string;
  artifacts: string[];
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
  /**
   * Phase 8D P6.5: idle timeout in seconds for a Developer attempt. If the
   * Developer produces no stdout, stderr, or handoff-file activity within this
   * window, the attempt is considered stalled and aborted via the per-attempt
   * AbortController. Default: 480. Explicit small overrides (e.g. 1 or 2) are
   * accepted so tests can exercise the watchdog quickly.
   */
  agent_idle_timeout_seconds: number;
}

// ─── Phase 10: ReviewLoopRequest Feedback Block Protocol ──────

/** Roles that may emit feedback blocks. */
export type FeedbackRole = 'planner' | 'developer' | 'auditor' | 'final_auditor';

/** Feedback block types (Design doc §4.2). */
export type FeedbackType =
  | 'clarify'
  | 'followup_task'
  | 'risk_note'
  | 'scope_concern'
  | 'verification_suggestion';

/** Per-role allowed feedback types. */
export type AllowedTypesPerRole = Record<FeedbackRole, FeedbackType[]>;

/** Phase 10 configuration — Design doc §9. */
export interface FeedbackProtocolConfig {
  /** Master switch. When false, parser is not invoked and prompts carry no hint. */
  enabled: boolean;
  /** Enable single-block self-correction rewrite on parse failure (off by default). */
  self_correction: boolean;
  /** Hard cap on blocks parsed per document; excess tail ignored + warned. */
  max_blocks_per_document: number;
  /** Per-role allowlist of permitted feedback types. */
  allowed_types_per_role: AllowedTypesPerRole;
}

/** A parsed ReviewLoopRequest feedback block. */
export interface FeedbackBlock {
  type: FeedbackType;
  priority: 'low' | 'medium' | 'high';
  origin_agent: FeedbackRole;
  message: string;
  fields: Record<string, unknown>;
  source_line: number;
}

/** A feedback block parse/validation error. */
export interface FeedbackParseError {
  source_line: number;
  reason: string;
  raw_excerpt: string;
}

/** Result of parsing feedback blocks from a document. */
export interface ParsedFeedbackBlocks {
  blocks: FeedbackBlock[];
  errors: FeedbackParseError[];
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
  /** Phase 8F: Keys to delete from the child process environment after copying process.env. */
  delete_env?: string[];
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
 * Phase 10: Status-side summary of accumulated feedback byproducts.
 *
 * Structurally compatible with the `FeedbackSummary` shape produced by
 * `src/cli/status-feedback-summary.ts`. Defined here so `StatusOutput`
 * stays self-contained in the public types surface.
 */
export interface StatusFeedbackSummary {
  /** Total accepted feedback blocks across the three block files. */
  blocks_total: number;
  /** Number of parse-warning entries (separate from blocks_total). */
  parse_warnings: number;
  /** Number of blocks whose origin role could not be determined. */
  unknown_role_blocks: number;
  /** Per-type counts for the canonical feedback types. */
  by_type: Record<FeedbackType, number>;
  /** Per-role counts (only includes blocks with a known role). */
  by_role: Record<FeedbackRole, number>;
  /** Project-relative paths of byproduct files that exist on disk, sorted. */
  present_files: string[];
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
  final_audit_decision: string | null;
  final_audit_path: string | null;
  commit_on_pass: boolean;
  commit_skipped: boolean;
  final_commit_sha: string | null;
  tag_requested: boolean;
  tag_name: string | null;
  tag_created: boolean;
  push_enabled: boolean;
  finalization_next_step: string | null;
  /** Phase 10: byproduct feedback summary; always present, may be empty. */
  feedback_summary: StatusFeedbackSummary;
}


// ─── Phase 8B: Task Graph Types ──────────────────────────────

/**
 * Phase 8B: Task difficulty — hints at required effort/context.
 * Not used for worker assignment in this phase (Phase 9).
 */
export const TaskDifficulty = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

export type TaskDifficulty = (typeof TaskDifficulty)[keyof typeof TaskDifficulty];

/**
 * Phase 8B: Task risk — hints at blast radius of changes.
 */
export const TaskRisk = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export type TaskRisk = (typeof TaskRisk)[keyof typeof TaskRisk];

/**
 * Phase 8B: Task status within the task graph.
 */
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  /**
   * Phase 8D P5 Round 1: a wave-scheduled task may be marked BLOCKED when a
   * parallel run cannot proceed (e.g. an upstream dependency failed). The
   * serial task-graph loop does not currently write this value; it exists for
   * schema/persistence compatibility ahead of wave-scheduling work.
   */
  BLOCKED: 'blocked',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * Phase 8B: Per-task verification command (external protocol format).
 * Mirrors GoalVerificationCommand but scoped to a single task.
 */
export interface TaskVerificationCommand {
  id: string;
  command: string[];
  cwd: string;
  required: boolean;
  timeout_seconds: number;
}

/**
 * Phase 8B: Task node — a single decomposed unit of work.
 * Each task maps to one scoped Developer run.
 */
export interface TaskNode {
  id: string;
  title: string;
  description: string;
  difficulty: TaskDifficulty;
  risk: TaskRisk;
  parallelizable: boolean;
  depends_on: string[];
  allowed_changes: string[];
  disallowed_changes: string[];
  verification_commands: TaskVerificationCommand[];
  status: TaskStatus;
}

/**
 * Phase 8B: Task graph — DAG of TaskNodes produced by the Planner.
 * Sequential execution only (no parallelism).
 */
export interface TaskGraph {
  schema_version: 1;
  run_id: string;
  goal_digest: string;
  tasks: TaskNode[];
  created_at: string;
}

/**
 * Phase 8B: Per-task execution result, accumulated in .agent/task-results.json.
 */
export interface TaskResult {
  task_id: string;
  status: TaskStatus;
  attempts: number;
  started_at: string;
  finished_at: string;
  verification_passed: boolean;
  error: string | null;
}

/**
 * Phase 8B: Accumulated task results file schema.
 */
export interface TaskResultsFile {
  schema_version: 1;
  run_id: string;
  results: TaskResult[];
}

/**
 * Phase 8B: Task graph execution state, persisted in state.json.
 */
export interface TaskGraphState {
  /** Index of the current task in topological order (0-based). */
  current_task_index: number;
  /** Per-task status map keyed by task id. */
  task_statuses: Record<string, TaskStatus>;
  /** Per-task attempt counts keyed by task id. */
  task_attempts: Record<string, number>;
}
