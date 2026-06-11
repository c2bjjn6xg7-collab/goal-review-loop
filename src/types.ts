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
  [Phase.REWORKING, new Set([Phase.VERIFYING, Phase.BLOCKED, Phase.FAILED, Phase.CANCELLED])],
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
  stages: Record<string, StageInfo>;
}

/**
 * Agent result — Design doc §9.1
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
  STATE_CONFLICT: 'STATE_CONFLICT',
  GIT_COMMIT_ERROR: 'GIT_COMMIT_ERROR',
  USER_CANCELLED: 'USER_CANCELLED',
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
  [ErrorCategory.STATE_CONFLICT, Phase.BLOCKED],
  [ErrorCategory.GIT_COMMIT_ERROR, Phase.BLOCKED],
  [ErrorCategory.USER_CANCELLED, Phase.CANCELLED],
]);

/**
 * Structured error record
 */
export interface ReviewLoopError {
  code: ErrorCategory;
  message: string;
  exit_code?: number;
  log_path?: string;
  resumable: boolean;
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
 * Verification command definition — Design doc §8.2
 */
export interface VerificationCommand {
  id: string;
  command: string[];
  cwd: string;
  required: boolean;
  timeout_seconds: number;
}

/**
 * GOAL front matter — Design doc §8.2
 */
export interface GoalFrontMatter {
  schema_version: number;
  run_id: string;
  goal_id: string;
  title: string;
  allowed_changes: string[];
  disallowed_changes: string[];
  verification_commands: VerificationCommand[];
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
}
