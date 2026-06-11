/**
 * Artifact Schemas — runtime JSON Schema definitions for all .agent/ artifacts.
 * Design doc §8: strict schema validation for every artifact type.
 *
 * Each artifact has:
 * 1. A JSON Schema for its YAML front matter
 * 2. A required_fields list for quick validation
 * 3. A strict parser function
 */
import { Ajv } from 'ajv';
import {
  parseFrontMatter,
  validateRequiredFields,
  validateEnumField,
  type FrontMatterResult,
} from './front-matter.js';
import type {
  PlanFrontMatter,
  GoalFrontMatter,
  HandoffFrontMatter,
  AuditReportFrontMatter,
  FinalAuditFrontMatter,
  IterationLogEntry,
} from '../types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

/** Digest format: sha256 followed by colon and 64 hex chars */
const DIGEST_PATTERN = '^sha256:[0-9a-f]{64}$';

/** Integer type: number that is also an integer (AJV doesn't have integer type natively) */
const POSITIVE_INTEGER = { type: 'number', minimum: 1, multipleOf: 1 } as const;

// ─── Plan Schema ──────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'run_id', 'author_role'],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    author_role: { type: 'string', const: 'planner' },
  },
  additionalProperties: true,
} as const;

const validatePlanFM = ajv.compile(PLAN_SCHEMA);

export function parsePlan(content: string, filePath?: string): FrontMatterResult<PlanFrontMatter> {
  const { frontMatter, body } = parseFrontMatter<Record<string, unknown>>(content, filePath);

  if (!validatePlanFM(frontMatter)) {
    const errors = validatePlanFM.errors
      ?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid plan.md front matter: ${errors}`);
  }

  validateRequiredFields(frontMatter, ['schema_version', 'run_id', 'author_role'], filePath);
  validateEnumField(frontMatter, 'author_role', ['planner'], filePath);

  return { frontMatter: frontMatter as unknown as PlanFrontMatter, body };
}

// ─── GOAL Schema ──────────────────────────────────────────────

const VERIFICATION_COMMAND_SCHEMA = {
  type: 'object',
  required: ['id', 'command', 'cwd', 'required', 'timeout_seconds'],
  properties: {
    id: { type: 'string', minLength: 1 },
    command: { type: 'array', items: { type: 'string' }, minItems: 1 },
    cwd: { type: 'string' },
    required: { type: 'boolean' },
    timeout_seconds: { type: 'number', minimum: 1 },
  },
  additionalProperties: false,
} as const;

const GOAL_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'run_id', 'goal_id', 'title', 'allowed_changes', 'disallowed_changes', 'verification_commands'],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    goal_id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    allowed_changes: { type: 'array', items: { type: 'string' }, minItems: 1 },
    disallowed_changes: { type: 'array', items: { type: 'string' } },
    verification_commands: {
      type: 'array',
      items: VERIFICATION_COMMAND_SCHEMA,
      minItems: 1,
    },
  },
  additionalProperties: true,
} as const;

const validateGoalFM = ajv.compile(GOAL_SCHEMA);

export function parseGoal(content: string, filePath?: string): FrontMatterResult<GoalFrontMatter> {
  const { frontMatter, body } = parseFrontMatter<Record<string, unknown>>(content, filePath);

  if (!validateGoalFM(frontMatter)) {
    const errors = validateGoalFM.errors
      ?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid GOAL.md front matter: ${errors}`);
  }

  validateRequiredFields(
    frontMatter,
    ['schema_version', 'run_id', 'goal_id', 'title', 'allowed_changes', 'disallowed_changes', 'verification_commands'],
    filePath,
  );

  return { frontMatter: frontMatter as unknown as GoalFrontMatter, body };
}

// ─── Developer Handoff Schema ────────────────────────────────

const HANDOFF_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'run_id', 'iteration', 'author_role', 'status'],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    iteration: POSITIVE_INTEGER,
    author_role: { type: 'string', const: 'developer' },
    status: { type: 'string', enum: ['COMPLETED', 'BLOCKED'] },
  },
  additionalProperties: true,
} as const;

const validateHandoffFM = ajv.compile(HANDOFF_SCHEMA);

export function parseHandoff(content: string, filePath?: string): FrontMatterResult<HandoffFrontMatter> {
  const { frontMatter, body } = parseFrontMatter<Record<string, unknown>>(content, filePath);

  if (!validateHandoffFM(frontMatter)) {
    const errors = validateHandoffFM.errors
      ?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid developer-handoff.md front matter: ${errors}`);
  }

  validateRequiredFields(frontMatter, ['schema_version', 'run_id', 'iteration', 'author_role', 'status'], filePath);
  validateEnumField(frontMatter, 'author_role', ['developer'], filePath);
  validateEnumField(frontMatter, 'status', ['COMPLETED', 'BLOCKED'], filePath);

  return { frontMatter: frontMatter as unknown as HandoffFrontMatter, body };
}

// ─── Audit Report Schema ─────────────────────────────────────
// Decision: PASS | FAIL | BLOCKED (NOT FAILED)

const AUDIT_REPORT_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'run_id', 'iteration', 'author_role', 'decision', 'audited_goal_digest', 'audited_diff_digest'],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    iteration: POSITIVE_INTEGER,
    author_role: { type: 'string', const: 'auditor' },
    decision: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED'] },
    audited_goal_digest: { type: 'string', pattern: DIGEST_PATTERN },
    audited_diff_digest: { type: 'string', pattern: DIGEST_PATTERN },
  },
  additionalProperties: true,
} as const;

const validateAuditReportFM = ajv.compile(AUDIT_REPORT_SCHEMA);

export function parseAuditReport(content: string, filePath?: string): FrontMatterResult<AuditReportFrontMatter> {
  const { frontMatter, body } = parseFrontMatter<Record<string, unknown>>(content, filePath);

  if (!validateAuditReportFM(frontMatter)) {
    const errors = validateAuditReportFM.errors
      ?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid audit-report.md front matter: ${errors}`);
  }

  validateRequiredFields(
    frontMatter,
    ['schema_version', 'run_id', 'iteration', 'author_role', 'decision', 'audited_goal_digest', 'audited_diff_digest'],
    filePath,
  );
  validateEnumField(frontMatter, 'author_role', ['auditor'], filePath);
  validateEnumField(frontMatter, 'decision', ['PASS', 'FAIL', 'BLOCKED'], filePath);

  return { frontMatter: frontMatter as unknown as AuditReportFrontMatter, body };
}

// ─── Final Audit Schema ──────────────────────────────────────
// Decision: PASS | FAILED | BLOCKED (NOT FAIL)
// Per requirements doc §7.5: "结论固定为 PASS、FAILED 或 BLOCKED"

const FINAL_AUDIT_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'run_id', 'author_role', 'decision', 'final_iteration', 'goal_digest', 'diff_digest'],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    author_role: { type: 'string', const: 'auditor' },
    decision: { type: 'string', enum: ['PASS', 'FAILED', 'BLOCKED'] },
    final_iteration: POSITIVE_INTEGER,
    goal_digest: { type: 'string', pattern: DIGEST_PATTERN },
    diff_digest: { type: 'string', pattern: DIGEST_PATTERN },
  },
  additionalProperties: true,
} as const;

const validateFinalAuditFM = ajv.compile(FINAL_AUDIT_SCHEMA);

export function parseFinalAudit(content: string, filePath?: string): FrontMatterResult<FinalAuditFrontMatter> {
  const { frontMatter, body } = parseFrontMatter<Record<string, unknown>>(content, filePath);

  if (!validateFinalAuditFM(frontMatter)) {
    const errors = validateFinalAuditFM.errors
      ?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid final-audit.md front matter: ${errors}`);
  }

  validateRequiredFields(
    frontMatter,
    ['schema_version', 'run_id', 'author_role', 'decision', 'final_iteration', 'goal_digest', 'diff_digest'],
    filePath,
  );
  validateEnumField(frontMatter, 'author_role', ['auditor'], filePath);
  validateEnumField(frontMatter, 'decision', ['PASS', 'FAILED', 'BLOCKED'], filePath);

  return { frontMatter: frontMatter as unknown as FinalAuditFrontMatter, body };
}

// ─── Iteration Log Parser ────────────────────────────────────
// Design doc §8.6: structured tabular records, append-only

/** Valid result values for iteration log entries */
const VALID_RESULTS = ['PASS', 'FAIL', 'BLOCKED', 'TIMEOUT', 'CANCELLED'] as const;

/** Valid phase values for iteration log entries */
const VALID_PHASES = ['INITIALIZING', 'PLANNING', 'DEVELOPING', 'VERIFYING', 'AUDITING', 'REWORKING', 'FINALIZING', 'PASSED', 'FAILED', 'BLOCKED', 'CANCELLED'] as const;

/** Time format: HH:mm:ssZ */
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}Z$/;

/**
 * Parse result field, supporting "RESULT (detail)" format.
 * Design doc §8.6 example: "FAIL (exit 1)"
 * Returns [mainResult, detail] or [result, undefined]
 */
function parseResultField(raw: string): [string, string | undefined] {
  const match = raw.match(/^(\w+)\s*\((.+)\)$/);
  if (match) {
    return [match[1], match[2]];
  }
  return [raw, undefined];
}

/**
 * Parse an iteration-log.md file and extract structured entries.
 * Design doc §8.6:
 * - Header: "## <ISO timestamp> | Run <run_id>"
 * - Table: Time | Iteration | Phase | Event | Result
 * - Time format: HH:mm:ssZ
 * - Result supports "RESULT (detail)" format
 *
 * Rules:
 * - Empty content returns empty array
 * - Non-empty content MUST contain a valid run header
 * - Table rows MUST have exactly 5 or 6 columns
 * - All fields are strictly validated
 * - Malformed content throws, never returns silently empty
 */
export function parseIterationLog(content: string, filePath?: string): IterationLogEntry[] {
  // Empty content is allowed
  if (!content.trim()) {
    return [];
  }

  const lines = content.split('\n');
  const entries: IterationLogEntry[] = [];
  let runId = '';
  let hasHeader = false;
  let hasDataRows = false;
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Extract run_id from header line: "## <timestamp> | Run <run_id>"
    const headerMatch = line.match(/^##\s+\S+\s*\|\s*Run\s+(.+)$/);
    if (headerMatch) {
      runId = headerMatch[1].trim();
      if (!runId) {
        errors.push(`Line ${lineNum}: empty run_id in header`);
      }
      hasHeader = true;
      continue;
    }

    // Skip blank lines
    if (!line.trim()) continue;

    // Skip separator lines (|---|---:|---|---|---|)
    // A separator line starts with |, contains only |, -, :, and spaces, and has at least one ---
    if (line.startsWith('|') && /^[|\s\-:]+$/.test(line) && line.includes('---')) continue;

    // Skip table header row (contains "Time" and "Phase")
    if (line.includes('Time') && line.includes('Phase')) continue;

    // Non-table lines in non-empty content are an error
    if (!line.startsWith('|')) {
      errors.push(`Line ${lineNum}: unexpected non-table content`);
      continue;
    }

    // Table data row — must have exactly 5 or 6 columns
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 5 || cells.length > 6) {
      errors.push(`Line ${lineNum}: expected 5-6 columns, got ${cells.length}`);
      continue;
    }

    hasDataRows = true;

    const [timestamp, iterationStr, phase, event, rawResult, rawDetail] = cells;

    // Validate timestamp format: HH:mm:ssZ
    if (!TIME_PATTERN.test(timestamp)) {
      errors.push(`Line ${lineNum}: invalid time format "${timestamp}", expected HH:mm:ssZ`);
      continue;
    }

    // Validate run_id is set
    if (!runId) {
      errors.push(`Line ${lineNum}: data row before header (no run_id)`);
      continue;
    }

    // Parse iteration number
    const iteration = Number(iterationStr);
    if (!Number.isInteger(iteration) || iteration < 0) {
      errors.push(`Line ${lineNum}: invalid iteration "${iterationStr}"`);
      continue;
    }

    // Validate phase
    if (!VALID_PHASES.includes(phase as typeof VALID_PHASES[number])) {
      errors.push(`Line ${lineNum}: invalid phase "${phase}"`);
      continue;
    }

    // Parse result (supports "RESULT (detail)" format)
    const [mainResult, parsedDetail] = parseResultField(rawResult);
    if (!VALID_RESULTS.includes(mainResult as typeof VALID_RESULTS[number])) {
      errors.push(`Line ${lineNum}: invalid result "${mainResult}"`);
      continue;
    }

    // Combine explicit detail column with parsed detail
    const detail = rawDetail || parsedDetail;

    const entry: IterationLogEntry = {
      timestamp,
      run_id: runId,
      iteration,
      phase: phase as IterationLogEntry['phase'],
      event,
      result: mainResult as IterationLogEntry['result'],
      ...(detail ? { detail } : {}),
    };

    entries.push(entry);
  }

  // Non-empty content must have a valid header
  if (!hasHeader) {
    throw new Error(`Invalid iteration-log: missing run header (## <timestamp> | Run <id>)${filePath ? ` in ${filePath}` : ''}`);
  }

  // Non-empty content with header but no valid data rows is an error
  if (hasHeader && !hasDataRows && errors.length > 0) {
    throw new Error(`Invalid iteration-log: header present but no valid data rows${filePath ? ` in ${filePath}` : ''}: ${errors.join('; ')}`);
  }

  // If we had parsing errors but also valid entries, still throw (partial corruption)
  if (errors.length > 0) {
    throw new Error(`Invalid iteration-log entries${filePath ? ` in ${filePath}` : ''}: ${errors.join('; ')}`);
  }

  return entries;
}

/**
 * Validate a single iteration log entry.
 * Checks all required fields and valid values.
 */
export function validateIterationLogEntry(entry: unknown): entry is IterationLogEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;

  // Required fields
  if (typeof e.timestamp !== 'string' || !e.timestamp) return false;
  if (typeof e.run_id !== 'string' || !e.run_id) return false;
  if (typeof e.iteration !== 'number' || !Number.isInteger(e.iteration) || e.iteration < 0) return false;
  if (typeof e.event !== 'string' || !e.event) return false;

  // Validate phase
  if (typeof e.phase !== 'string') return false;
  if (!VALID_PHASES.includes(e.phase as typeof VALID_PHASES[number])) return false;

  // Validate result
  if (typeof e.result !== 'string') return false;
  if (!VALID_RESULTS.includes(e.result as typeof VALID_RESULTS[number])) return false;

  // Optional detail
  if (e.detail !== undefined && typeof e.detail !== 'string') return false;

  return true;
}
