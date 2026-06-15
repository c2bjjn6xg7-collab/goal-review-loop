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
  GoalVerificationCommand,
  VerificationCommand,
  HandoffFrontMatter,
  AuditReportFrontMatter,
  FinalAuditFrontMatter,
  IterationLogEntry,
  ReworkInstructionsFrontMatter,
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
  required: ['schema_version', 'run_id', 'author_role', 'decision', 'final_iteration', 'goal_digest', 'diff_digest', 'audit_report_digest', 'verification_manifest_digest', 'created_at'],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    author_role: { type: 'string', const: 'auditor' },
    decision: { type: 'string', enum: ['PASS', 'FAILED', 'BLOCKED'] },
    final_iteration: POSITIVE_INTEGER,
    goal_digest: { type: 'string', pattern: DIGEST_PATTERN },
    diff_digest: { type: 'string', pattern: DIGEST_PATTERN },
    audit_report_digest: { type: 'string', pattern: DIGEST_PATTERN },
    verification_manifest_digest: { type: 'string', pattern: DIGEST_PATTERN },
    created_at: { type: 'string', minLength: 1 },
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
    ['schema_version', 'run_id', 'author_role', 'decision', 'final_iteration', 'goal_digest', 'diff_digest', 'audit_report_digest', 'verification_manifest_digest', 'created_at'],
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

/** All allowed field names in an iteration log entry */
const ALLOWED_ENTRY_FIELDS = new Set(['timestamp', 'run_id', 'iteration', 'phase', 'event', 'result', 'detail']);

/**
 * Strict ISO 8601 timestamp validation.
 * Accepts: 2026-06-10T22:30:12Z or 2026-06-10T22:30:12.000Z
 * Rejects: definitely-not-iso, 2026-99-99T99:99:99Z, also-nope
 */
function isValidISOTimestamp(value: string): boolean {
  // Basic format check: YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DDTHH:MM:SS.mmmZ
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) {
    return false;
  }
  // Parse and validate date is real (not 2026-99-99)
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  // Verify round-trip: parsed date matches input (catches impossible dates like Feb 30)
  // toISOString() always returns with .000Z, so compare normalized forms
  const iso = date.toISOString();
  const normalizedInput = value.endsWith('.000Z') ? value : `${value.slice(0, -1)}.000Z`;
  return iso === normalizedInput;
}

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
 * Validate a single iteration log entry.
 * Checks all required fields, valid values, and rejects extra fields.
 * This is the single source of truth for entry validation.
 */
export function validateIterationLogEntry(entry: unknown): entry is IterationLogEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;

  // Reject extra fields (strict schema, no additionalProperties)
  for (const key of Object.keys(e)) {
    if (!ALLOWED_ENTRY_FIELDS.has(key)) return false;
  }

  // Required fields with strict type checks
  if (typeof e.timestamp !== 'string' || !isValidISOTimestamp(e.timestamp)) return false;
  if (typeof e.run_id !== 'string' || !e.run_id) return false;
  if (typeof e.iteration !== 'number' || !Number.isInteger(e.iteration) || e.iteration < 0) return false;
  if (typeof e.event !== 'string' || !e.event) return false;

  // Validate phase enum
  if (typeof e.phase !== 'string') return false;
  if (!VALID_PHASES.includes(e.phase as typeof VALID_PHASES[number])) return false;

  // Validate result enum
  if (typeof e.result !== 'string') return false;
  if (!VALID_RESULTS.includes(e.result as typeof VALID_RESULTS[number])) return false;

  // Optional detail
  if (e.detail !== undefined && typeof e.detail !== 'string') return false;

  return true;
}

/**
 * Parse an iteration-log.md file and extract structured entries.
 * Design doc §8.6:
 * - Header: "## <ISO 8601 timestamp> | Run <run_id>"
 * - Table: Time | Iteration | Phase | Event | Result
 * - Row time is HH:mm:ssZ; entry timestamp is combined ISO 8601
 * - Result supports "RESULT (detail)" format
 *
 * Rules:
 * - Empty/whitespace-only content returns empty array
 * - Non-empty content MUST contain a valid run header with valid ISO timestamp
 * - Non-empty content MUST contain at least one valid data row
 * - Table rows MUST have exactly 5 or 6 columns
 * - All fields are strictly validated via shared validators
 * - Malformed content throws, never returns silently empty
 */
export function parseIterationLog(content: string, filePath?: string): IterationLogEntry[] {
  // Empty/whitespace-only content is allowed
  if (!content.trim()) {
    return [];
  }

  const lines = content.split('\n');
  const entries: IterationLogEntry[] = [];
  let runId = '';
  let headerTimestamp = '';
  let hasHeader = false;
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Extract run_id and timestamp from header line: "## <timestamp> | Run <run_id>"
    const headerMatch = line.match(/^##\s+(\S+)\s*\|\s*Run\s+(.+)$/);
    if (headerMatch) {
      const ts = headerMatch[1].trim();
      runId = headerMatch[2].trim();

      // Validate header timestamp is strict ISO 8601
      if (!isValidISOTimestamp(ts)) {
        errors.push(`Line ${lineNum}: invalid header timestamp "${ts}", expected ISO 8601 (YYYY-MM-DDTHH:MM:SSZ)`);
      } else {
        headerTimestamp = ts;
      }

      if (!runId) {
        errors.push(`Line ${lineNum}: empty run_id in header`);
      }
      hasHeader = true;
      continue;
    }

    // Skip blank lines
    if (!line.trim()) continue;

    // Non-table lines in non-empty content are an error
    if (!line.startsWith('|')) {
      errors.push(`Line ${lineNum}: unexpected non-table content`);
      continue;
    }

    // Parse columns first, then classify
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);

    // Skip separator lines (|---|---:|---|---|---|)
    // Must be exactly 5 columns matching markdown separator pattern (at least 3 dashes)
    if (cells.length === 5 && cells.every(c => /^:?-{3,}:?$/.test(c))) continue;

    // Skip standard table header row: exactly "Time | Iteration | Phase | Event | Result"
    // Use exact column match, NOT substring search (event could contain "Time" or "Phase")
    if (cells.length === 5 &&
        cells[0] === 'Time' &&
        cells[1] === 'Iteration' &&
        cells[2] === 'Phase' &&
        cells[3] === 'Event' &&
        cells[4] === 'Result') {
      continue;
    }

    // Table data row — must have exactly 5 or 6 columns
    if (cells.length < 5 || cells.length > 6) {
      errors.push(`Line ${lineNum}: expected 5-6 columns, got ${cells.length}`);
      continue;
    }

    // Skip if we don't have a valid header yet
    if (!hasHeader || !headerTimestamp) {
      errors.push(`Line ${lineNum}: data row before valid header`);
      continue;
    }

    const [timeStr, iterationStr, phase, event, rawResult, rawDetail] = cells;

    // Validate row time format: HH:mm:ssZ
    if (!/^\d{2}:\d{2}:\d{2}Z$/.test(timeStr)) {
      errors.push(`Line ${lineNum}: invalid time format "${timeStr}", expected HH:mm:ssZ`);
      continue;
    }

    // Combine header date with row time to form full ISO timestamp
    // Header: "2026-06-10T22:30:12Z" → date part: "2026-06-10"
    const datePart = headerTimestamp.slice(0, 10);
    const fullTimestamp = `${datePart}T${timeStr}`;

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
      timestamp: fullTimestamp,
      run_id: runId,
      iteration,
      phase: phase as IterationLogEntry['phase'],
      event,
      result: mainResult as IterationLogEntry['result'],
      ...(detail ? { detail } : {}),
    };

    // Final validation via shared validator
    if (!validateIterationLogEntry(entry)) {
      errors.push(`Line ${lineNum}: entry validation failed`);
      continue;
    }

    entries.push(entry);
  }

  // Non-empty content must have a valid header
  if (!hasHeader) {
    throw new Error(`Invalid iteration-log: missing run header (## <timestamp> | Run <id>)${filePath ? ` in ${filePath}` : ''}`);
  }

  // If we had parsing errors, throw
  if (errors.length > 0) {
    throw new Error(`Invalid iteration-log${filePath ? ` in ${filePath}` : ''}: ${errors.join('; ')}`);
  }

  // Non-empty content with valid header but no data rows is an error
  if (entries.length === 0) {
    throw new Error(`Invalid iteration-log: header present but no valid data rows${filePath ? ` in ${filePath}` : ''}`);
  }

  return entries;
}

// ─── Rework Instructions Schema ───────────────────────────────
// Phase 4 §7: Orchestrator-authored rework instructions for Developer.

const REWORK_INSTRUCTIONS_SCHEMA = {
  type: 'object',
  required: ['schema_version', 'run_id', 'iteration', 'author_role', 'source', 'status'],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    iteration: { type: 'number', minimum: 2, multipleOf: 1 },
    author_role: { type: 'string', const: 'orchestrator' },
    source: { type: 'string', enum: ['scope', 'verification', 'audit', 'artifact'] },
    status: { type: 'string', const: 'REWORK_REQUIRED' },
  },
  additionalProperties: true,
} as const;

const validateReworkInstructionsFM = ajv.compile(REWORK_INSTRUCTIONS_SCHEMA);

export function parseReworkInstructions(content: string, filePath?: string): FrontMatterResult<ReworkInstructionsFrontMatter> {
  const { frontMatter, body } = parseFrontMatter<Record<string, unknown>>(content, filePath);

  if (!validateReworkInstructionsFM(frontMatter)) {
    const errors = validateReworkInstructionsFM.errors
      ?.map((e: { instancePath: string; message?: string }) => `${e.instancePath}: ${e.message}`)
      .join('; ');
    throw new Error(`Invalid rework-instructions.md front matter: ${errors}`);
  }

  validateRequiredFields(
    frontMatter,
    ['schema_version', 'run_id', 'iteration', 'author_role', 'source', 'status'],
    filePath,
  );
  validateEnumField(frontMatter, 'author_role', ['orchestrator'], filePath);
  validateEnumField(frontMatter, 'source', ['scope', 'verification', 'audit', 'artifact'], filePath);
  validateEnumField(frontMatter, 'status', ['REWORK_REQUIRED'], filePath);

  const iteration = (frontMatter as Record<string, unknown>).iteration;
  if (typeof iteration === 'number' && iteration < 2) {
    throw new Error(`rework-instructions.md iteration must be >= 2${filePath ? ` in ${filePath}` : ''}`);
  }

  return { frontMatter: frontMatter as unknown as ReworkInstructionsFrontMatter, body };
}

// ─── GOAL Command Normalization ──────────────────────────────
// Phase 3 §6.1: Convert external GoalVerificationCommand (with `command`)
// to internal VerificationCommand (with `argv`).

/** Destructive argv patterns that must be rejected. */
const DESTRUCTIVE_ARGV_PATTERNS: ReadonlyArray<readonly string[]> = [
  ['git', 'push'],
  ['git', 'reset', '--hard'],
  ['git', 'clean'],
  ['rm', '-rf', '/'],
  ['sudo'],
  ['shutdown'],
  ['reboot'],
];

/**
 * Check if an argv array matches a destructive pattern.
 * Compares element-by-element from the start.
 */
function isDestructiveArgv(argv: string[]): boolean {
  for (const pattern of DESTRUCTIVE_ARGV_PATTERNS) {
    if (argv.length < pattern.length) continue;
    let match = true;
    for (let i = 0; i < pattern.length; i++) {
      if (argv[i] !== pattern[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Normalize GOAL verification commands from external protocol to internal format.
 * Phase 3 §6.1:
 * - External GOAL uses `command` field (string array)
 * - Internal VerificationCommand uses `argv` field (string array)
 * - This function performs the 1:1 mapping with validation
 *
 * Validates:
 * - Each command has a non-empty id
 * - Each command has at least one element in `command` array
 * - command[0] (program name) is non-empty
 * - No duplicate IDs
 * - No destructive argv patterns
 * - cwd does not contain `..` or absolute paths
 */
export function normalizeGoalCommands(
  goalCommands: GoalVerificationCommand[],
): VerificationCommand[] {
  const seenIds = new Set<string>();
  const result: VerificationCommand[] = [];

  for (const cmd of goalCommands) {
    // Validate ID
    if (!cmd.id || typeof cmd.id !== 'string') {
      throw new Error(`GOAL verification command has invalid or missing id`);
    }
    if (seenIds.has(cmd.id)) {
      throw new Error(`GOAL verification command has duplicate id: "${cmd.id}"`);
    }
    seenIds.add(cmd.id);

    // Validate command array
    if (!Array.isArray(cmd.command) || cmd.command.length === 0) {
      throw new Error(`GOAL verification command "${cmd.id}" has empty or missing command array`);
    }
    if (!cmd.command[0] || typeof cmd.command[0] !== 'string') {
      throw new Error(`GOAL verification command "${cmd.id}" has empty program name (command[0])`);
    }

    // Check for destructive patterns
    if (isDestructiveArgv(cmd.command)) {
      throw new Error(`GOAL verification command "${cmd.id}" contains destructive command: ${cmd.command.join(' ')}`);
    }

    // Validate cwd — must not contain .. or be absolute
    if (cmd.cwd.includes('..')) {
      throw new Error(`GOAL verification command "${cmd.id}" has cwd containing "..": "${cmd.cwd}"`);
    }
    if (cmd.cwd.startsWith('/')) {
      throw new Error(`GOAL verification command "${cmd.id}" has absolute cwd: "${cmd.cwd}"`);
    }

    // Normalize: command → argv (1:1 mapping, no shell interpretation)
    result.push({
      id: cmd.id,
      argv: [...cmd.command], // defensive copy
      cwd: cmd.cwd,
      required: cmd.required,
      timeout_seconds: cmd.timeout_seconds,
    });
  }

  return result;
}
