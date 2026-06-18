/**
 * Phase 10: ReviewLoopRequest feedback block parser.
 *
 * Pure function: scans markdown text for fenced code blocks tagged
 * `ReviewLoopRequest`, parses the YAML body with js-yaml, and validates
 * each block's type/origin_agent/per-type fields with ajv.
 *
 * Design (implementation brief §3):
 *  - No markdown AST libraries (structure is trivial).
 *  - Language tag must match `ReviewLoopRequest` exactly (case-sensitive).
 *  - Fence must start at column 0 (rejects indented/nested fences).
 *  - Fence ends at the next column-0 fence.
 *  - Body must be valid YAML (yaml.load, not JSON).
 *  - Parse failures never throw; they are collected into `errors`.
 */
import { load as yamlLoad } from 'js-yaml';
import { Ajv, type ValidateFunction } from 'ajv';
import type {
  FeedbackBlock,
  FeedbackParseError,
  FeedbackRole,
  FeedbackType,
  ParsedFeedbackBlocks,
} from '../types.js';

const LANGUAGE_TAG = 'ReviewLoopRequest';

/** A single raw fence candidate located during line scanning. */
interface FenceCandidate {
  startLine: number; // 0-based index of the opening fence line
  endLine: number; // 0-based index of the closing fence line (exclusive body end)
  body: string;
}

const FEEDBACK_TYPES: FeedbackType[] = [
  'clarify', 'followup_task', 'risk_note', 'scope_concern', 'verification_suggestion',
];
const FEEDBACK_ROLES: FeedbackRole[] = ['planner', 'developer', 'auditor', 'final_auditor'];
const PRIORITIES = ['low', 'medium', 'high'] as const;

/** Per-type ajv validators, compiled once. */
function buildTypeValidators(): Record<FeedbackType, ValidateFunction> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const stringArray = { type: 'array', items: { type: 'string' } };
  return {
    clarify: ajv.compile({
      type: 'object',
      required: ['type', 'origin_agent', 'message', 'target', 'question'],
      properties: {
        type: { type: 'string', const: 'clarify' },
        origin_agent: { type: 'string', enum: FEEDBACK_ROLES },
        priority: { type: 'string', enum: PRIORITIES },
        message: { type: 'string', minLength: 1 },
        target: { type: 'string', const: 'planner' },
        question: { type: 'string', minLength: 1 },
        blocking: { type: 'boolean' },
      },
      additionalProperties: false,
    }),
    followup_task: ajv.compile({
      type: 'object',
      required: ['type', 'origin_agent', 'message', 'title', 'description'],
      properties: {
        type: { type: 'string', const: 'followup_task' },
        origin_agent: { type: 'string', enum: FEEDBACK_ROLES },
        priority: { type: 'string', enum: PRIORITIES },
        message: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
        estimated_difficulty: { type: 'string', enum: ['low', 'medium', 'high'] },
        suggested_files: stringArray,
      },
      additionalProperties: false,
    }),
    risk_note: ajv.compile({
      type: 'object',
      required: ['type', 'origin_agent', 'message', 'category', 'description'],
      properties: {
        type: { type: 'string', const: 'risk_note' },
        origin_agent: { type: 'string', enum: FEEDBACK_ROLES },
        priority: { type: 'string', enum: PRIORITIES },
        message: { type: 'string', minLength: 1 },
        category: {
          type: 'string',
          enum: ['race_condition', 'data_loss', 'security', 'performance', 'other'],
        },
        description: { type: 'string', minLength: 1 },
        mitigation_hint: { type: 'string' },
      },
      additionalProperties: false,
    }),
    scope_concern: ajv.compile({
      type: 'object',
      required: ['type', 'origin_agent', 'message', 'requested_paths', 'reason'],
      properties: {
        type: { type: 'string', const: 'scope_concern' },
        origin_agent: { type: 'string', enum: FEEDBACK_ROLES },
        priority: { type: 'string', enum: PRIORITIES },
        message: { type: 'string', minLength: 1 },
        requested_paths: stringArray,
        reason: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    }),
    verification_suggestion: ajv.compile({
      type: 'object',
      required: ['type', 'origin_agent', 'message', 'command', 'reason'],
      properties: {
        type: { type: 'string', const: 'verification_suggestion' },
        origin_agent: { type: 'string', enum: FEEDBACK_ROLES },
        priority: { type: 'string', enum: PRIORITIES },
        message: { type: 'string', minLength: 1 },
        command: stringArray,
        reason: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    }),
  };
}

const TYPE_VALIDATORS = buildTypeValidators();

/**
 * Scan markdown line array for column-0 fenced blocks tagged ReviewLoopRequest.
 * Returns the raw body strings plus 0-based line indices.
 */
function locateFences(lines: string[]): FenceCandidate[] {
  const candidates: FenceCandidate[] = [];
  // Match an opening fence: line starts (column 0) with ``` optionally followed
  // by a language tag. We only collect those whose tag is exactly ReviewLoopRequest.
  const openRe = /^```(\S*)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(openRe);
    if (!open) continue;
    const tag = open[1];
    if (tag !== LANGUAGE_TAG) continue;
    // Find closing fence: next column-0 ``` line.
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^```\s*$/.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      // Unterminated fence: record a candidate with empty body and an end marker
      // at EOF so the caller can emit a parse error.
      candidates.push({ startLine: i, endLine: lines.length, body: lines.slice(i + 1).join('\n') });
    } else {
      candidates.push({ startLine: i, endLine: end, body: lines.slice(i + 1, end).join('\n') });
    }
    i = end === -1 ? lines.length : end;
  }
  return candidates;
}

function excerpt(body: string): string {
  return body.slice(0, 200);
}

/**
 * Parse all ReviewLoopRequest feedback blocks from a markdown document.
 *
 * Pure function — no IO. Failures are collected, never thrown.
 *
 * @param md            Full markdown text of the primary artifact.
 * @param expectedRole  The role that produced this artifact (used to validate origin_agent).
 * @param maxBlocks     Hard cap on accepted blocks; excess tail is ignored + warned.
 * @param allowedTypes  Per-role allowlist; defaults to the protocol defaults.
 */
export function parseFeedbackBlocks(
  md: string,
  expectedRole: FeedbackRole,
  maxBlocks: number,
  allowedTypes?: Record<FeedbackRole, FeedbackType[]>,
): ParsedFeedbackBlocks {
  const blocks: FeedbackBlock[] = [];
  const errors: FeedbackParseError[] = [];
  const allow = allowedTypes ?? defaultAllowedTypes();
  const lines = md.split('\n');
  const candidates = locateFences(lines);

  for (const cand of candidates) {
    const sourceLine = cand.startLine + 1; // 1-based for human-facing logs

    // Unterminated fence (end reached without a closing fence)
    if (cand.endLine >= lines.length && !/^\s*```/.test(lines[lines.length - 1] ?? '')) {
      // Distinguish "no closing fence found at all"
      const hasClose = lines.slice(cand.startLine + 1).some((l) => /^```\s*$/.test(l));
      if (!hasClose) {
        errors.push({
          source_line: sourceLine,
          reason: 'unterminated fence: no closing ``` found',
          raw_excerpt: excerpt(cand.body),
        });
        continue;
      }
    }

    // Parse YAML body
    let parsed: unknown;
    try {
      parsed = yamlLoad(cand.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        source_line: sourceLine,
        reason: `YAML: ${msg}`,
        raw_excerpt: excerpt(cand.body),
      });
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push({
        source_line: sourceLine,
        reason: 'YAML body is not a mapping',
        raw_excerpt: excerpt(cand.body),
      });
      continue;
    }

    const obj = parsed as Record<string, unknown>;
    const type = obj.type;
    const origin = obj.origin_agent;

    // type must be a legal FeedbackType
    if (typeof type !== 'string' || !FEEDBACK_TYPES.includes(type as FeedbackType)) {
      errors.push({
        source_line: sourceLine,
        reason: `invalid or missing "type": ${JSON.stringify(type)}`,
        raw_excerpt: excerpt(cand.body),
      });
      continue;
    }

    // origin_agent must equal expectedRole (anti Auditor-uses-clarify)
    if (typeof origin !== 'string' || origin !== expectedRole) {
      errors.push({
        source_line: sourceLine,
        reason: `origin_agent "${String(origin)}" does not match expected role "${expectedRole}"`,
        raw_excerpt: excerpt(cand.body),
      });
      continue;
    }

    // type must be in the role allowlist
    if (!allow[expectedRole].includes(type as FeedbackType)) {
      errors.push({
        source_line: sourceLine,
        reason: `type "${type}" not allowed for role "${expectedRole}"`,
        raw_excerpt: excerpt(cand.body),
      });
      continue;
    }

    // Per-type field validation via ajv
    const validator = TYPE_VALIDATORS[type as FeedbackType];
    if (!validator(obj)) {
      const msg = (validator.errors ?? [])
        .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`)
        .join('; ');
      errors.push({
        source_line: sourceLine,
        reason: `schema validation failed: ${msg}`,
        raw_excerpt: excerpt(cand.body),
      });
      continue;
    }

    // Enforce hard cap: excess tail blocks are recorded as warnings, not blocks.
    if (blocks.length >= maxBlocks) {
      errors.push({
        source_line: sourceLine,
        reason: `max_blocks_per_document (${maxBlocks}) exceeded; block ignored`,
        raw_excerpt: excerpt(cand.body),
      });
      continue;
    }

    const validated = obj as Record<string, unknown>;
    const priority = (typeof validated.priority === 'string' ? validated.priority : 'medium') as
      | 'low' | 'medium' | 'high';

    // Extract type-specific fields (everything except the common envelope).
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(validated)) {
      if (k !== 'type' && k !== 'origin_agent' && k !== 'priority' && k !== 'message') {
        fields[k] = v;
      }
    }

    blocks.push({
      type: type as FeedbackType,
      origin_agent: expectedRole,
      priority,
      message: String(validated.message),
      fields,
      source_line: sourceLine,
    });
  }

  return { blocks, errors };
}

/** Default per-role allowlist (mirrors config defaults). */
export function defaultAllowedTypes(): Record<FeedbackRole, FeedbackType[]> {
  return {
    planner: ['clarify', 'risk_note', 'followup_task'],
    developer: ['scope_concern', 'verification_suggestion', 'risk_note', 'followup_task'],
    auditor: ['risk_note', 'followup_task'],
    final_auditor: ['risk_note', 'followup_task'],
  };
}

/**
 * Phase 10 §8: single-block self-correction rewrite.
 *
 * Given a failed block's raw body + its source line and the expected role,
 * re-parse just that body. Used by the dispatcher when self_correction is on:
 * the orchestrator asks the agent to rewrite the one failing block, then calls
 * this to validate the rewrite. Returns at most one block; no recursion.
 */
export function reparseSingleBlock(
  rewrittenBody: string,
  expectedRole: FeedbackRole,
  sourceLine: number,
  allowedTypes?: Record<FeedbackRole, FeedbackType[]>,
): ParsedFeedbackBlocks {
  const allow = allowedTypes ?? defaultAllowedTypes();
  let parsed: unknown;
  try {
    parsed = yamlLoad(rewrittenBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      blocks: [],
      errors: [{ source_line: sourceLine, reason: `YAML: ${msg}`, raw_excerpt: excerpt(rewrittenBody) }],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      blocks: [],
      errors: [{ source_line: sourceLine, reason: 'YAML body is not a mapping', raw_excerpt: excerpt(rewrittenBody) }],
    };
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string' || !FEEDBACK_TYPES.includes(type as FeedbackType)) {
    return {
      blocks: [],
      errors: [{ source_line: sourceLine, reason: `invalid or missing "type": ${JSON.stringify(type)}`, raw_excerpt: excerpt(rewrittenBody) }],
    };
  }
  if (obj.origin_agent !== expectedRole) {
    return {
      blocks: [],
      errors: [{ source_line: sourceLine, reason: `origin_agent "${String(obj.origin_agent)}" does not match expected role "${expectedRole}"`, raw_excerpt: excerpt(rewrittenBody) }],
    };
  }
  if (!allow[expectedRole].includes(type as FeedbackType)) {
    return {
      blocks: [],
      errors: [{ source_line: sourceLine, reason: `type "${type}" not allowed for role "${expectedRole}"`, raw_excerpt: excerpt(rewrittenBody) }],
    };
  }
  const validator = TYPE_VALIDATORS[type as FeedbackType];
  if (!validator(obj)) {
    const msg = (validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`)
      .join('; ');
    return {
      blocks: [],
      errors: [{ source_line: sourceLine, reason: `schema validation failed: ${msg}`, raw_excerpt: excerpt(rewrittenBody) }],
    };
  }
  const validated = obj as Record<string, unknown>;
  const priority = (typeof validated.priority === 'string' ? validated.priority : 'medium') as
    | 'low' | 'medium' | 'high';
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(validated)) {
    if (k !== 'type' && k !== 'origin_agent' && k !== 'priority' && k !== 'message') {
      fields[k] = v;
    }
  }
  return {
    blocks: [{
      type: type as FeedbackType,
      origin_agent: expectedRole,
      priority,
      message: String(validated.message),
      fields,
      source_line: sourceLine,
    }],
    errors: [],
  };
}
