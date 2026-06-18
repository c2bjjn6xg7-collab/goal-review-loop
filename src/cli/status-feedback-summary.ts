/**
 * Phase 10 status-side feedback summary reader.
 *
 * Best-effort, non-throwing. Inspects the four Phase 10 byproduct files
 * written by `src/orchestrator/feedback-dispatcher.ts` and produces counts
 * by canonical feedback type and (when available) origin role.
 *
 * Header formats consumed (mirrors feedback-dispatcher emission):
 *   clarifications.md:  `## <ts> | run <id> | clarify[ (blocking)] | line <n>`
 *   feedback-notes.md:  `### <ts> | run <id> | (risk_note|scope_concern) | origin <role> | line <n>`
 *   followups.md:       `### <ts> | run <id> | (followup_task|verification_suggestion) | line <n>`
 *   parse-warnings.md:  `## <ts> | run <id> | <role> | <artifact rel path>`
 *
 * Origin-role inference (only when default per-role allowlist is unique):
 *   clarify                 → planner
 *   verification_suggestion → developer
 *   followup_task           → unknown (any role may emit)
 *   risk_note / scope_concern → from explicit `origin <role>` in header
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FeedbackRole, FeedbackType } from '../types.js';

/** Project-relative paths of the Phase 10 byproduct files. */
export const FEEDBACK_BYPRODUCT_PATHS = {
  clarifications: '.agent/clarifications.md',
  feedback_notes: '.agent/feedback-notes.md',
  followups: '.agent/followups.md',
  parse_warnings: '.agent/parse-warnings.md',
} as const;

const FEEDBACK_TYPES: readonly FeedbackType[] = [
  'clarify',
  'followup_task',
  'risk_note',
  'scope_concern',
  'verification_suggestion',
] as const;

const FEEDBACK_ROLES: readonly FeedbackRole[] = [
  'planner',
  'developer',
  'auditor',
  'final_auditor',
] as const;

export interface FeedbackSummary {
  /** Total accepted feedback blocks counted across the three block files. */
  blocks_total: number;
  /** Number of parse-warning entries (does not contribute to blocks_total). */
  parse_warnings: number;
  /** Number of blocks whose origin role could not be determined. */
  unknown_role_blocks: number;
  /** Per-type counts. */
  by_type: Record<FeedbackType, number>;
  /** Per-role counts (only includes blocks with a known role). */
  by_role: Record<FeedbackRole, number>;
  /** Project-relative paths of byproduct files that exist on disk, sorted. */
  present_files: string[];
}

function emptyByType(): Record<FeedbackType, number> {
  const out = {} as Record<FeedbackType, number>;
  for (const t of FEEDBACK_TYPES) out[t] = 0;
  return out;
}

function emptyByRole(): Record<FeedbackRole, number> {
  const out = {} as Record<FeedbackRole, number>;
  for (const r of FEEDBACK_ROLES) out[r] = 0;
  return out;
}

/** Stable empty summary — used as the starting point and on missing inputs. */
export function emptyFeedbackSummary(): FeedbackSummary {
  return {
    blocks_total: 0,
    parse_warnings: 0,
    unknown_role_blocks: 0,
    by_type: emptyByType(),
    by_role: emptyByRole(),
    present_files: [],
  };
}

/** True when the summary has any block, parse warning, or present byproduct file. */
export function feedbackSummaryHasContent(s: FeedbackSummary): boolean {
  return s.blocks_total > 0 || s.parse_warnings > 0 || s.present_files.length > 0;
}

function isFeedbackRole(role: string): role is FeedbackRole {
  return (FEEDBACK_ROLES as readonly string[]).includes(role);
}

function safeReadLines(absPath: string): string[] | null {
  try {
    if (!existsSync(absPath)) return null;
    const content = readFileSync(absPath, 'utf8');
    return content.split('\n');
  } catch {
    return null;
  }
}

// `## ... | clarify[ (blocking)] | ...`
const CLARIFY_HEADER_RE = /^##\s+\S.*?\|\s*clarify(?:\s*\(blocking\))?\s*\|/;
// `### ... | (risk_note|scope_concern) | origin <role> | ...`
const FEEDBACK_NOTE_HEADER_RE =
  /^###\s+\S.*?\|\s*(risk_note|scope_concern)\s*\|\s*origin\s+([A-Za-z_]+)\s*\|/;
// `### ... | (followup_task|verification_suggestion) | ...`
const FOLLOWUP_HEADER_RE =
  /^###\s+\S.*?\|\s*(followup_task|verification_suggestion)\s*\|/;
// Parse-warnings entry: dispatcher emits one `- line N: reason` per error,
// and a single header can cover multiple errors from the same artifact
// (feedback-dispatcher.ts writeParseWarnings). Count entries, not headers,
// so multi-error sections are not undercounted.
const PARSE_WARNING_ENTRY_RE = /^-\s+line\s+\d+/;

/**
 * Read and summarize Phase 10 feedback byproduct files under `<projectRoot>/.agent`.
 *
 * Best-effort: missing, empty, or malformed files never cause this function to throw.
 * Returns a stable empty summary when no byproducts exist.
 */
export function readFeedbackSummary(projectRoot: string): FeedbackSummary {
  const summary = emptyFeedbackSummary();
  let root: string;
  try {
    root = resolve(projectRoot);
  } catch {
    return summary;
  }

  const presentFiles: string[] = [];
  const trackPresent = (rel: string, abs: string): void => {
    try {
      if (existsSync(abs)) presentFiles.push(rel);
    } catch {
      /* ignore */
    }
  };

  // 1) clarifications.md  →  clarify is planner-only under default allowlist.
  {
    const rel = FEEDBACK_BYPRODUCT_PATHS.clarifications;
    const abs = join(root, rel);
    trackPresent(rel, abs);
    const lines = safeReadLines(abs);
    if (lines) {
      for (const line of lines) {
        if (CLARIFY_HEADER_RE.test(line)) {
          summary.by_type.clarify += 1;
          summary.by_role.planner += 1;
          summary.blocks_total += 1;
        }
      }
    }
  }

  // 2) feedback-notes.md  →  risk_note / scope_concern with explicit origin role.
  {
    const rel = FEEDBACK_BYPRODUCT_PATHS.feedback_notes;
    const abs = join(root, rel);
    trackPresent(rel, abs);
    const lines = safeReadLines(abs);
    if (lines) {
      for (const line of lines) {
        const m = line.match(FEEDBACK_NOTE_HEADER_RE);
        if (!m) continue;
        const type = m[1] as FeedbackType;
        const role = m[2];
        summary.by_type[type] += 1;
        summary.blocks_total += 1;
        if (isFeedbackRole(role)) {
          summary.by_role[role] += 1;
        } else {
          summary.unknown_role_blocks += 1;
        }
      }
    }
  }

  // 3) followups.md  →  followup_task (origin unknown), verification_suggestion (developer-only).
  {
    const rel = FEEDBACK_BYPRODUCT_PATHS.followups;
    const abs = join(root, rel);
    trackPresent(rel, abs);
    const lines = safeReadLines(abs);
    if (lines) {
      for (const line of lines) {
        const m = line.match(FOLLOWUP_HEADER_RE);
        if (!m) continue;
        const type = m[1] as FeedbackType;
        summary.by_type[type] += 1;
        summary.blocks_total += 1;
        if (type === 'verification_suggestion') {
          summary.by_role.developer += 1;
        } else {
          summary.unknown_role_blocks += 1;
        }
      }
    }
  }

  // 4) parse-warnings.md  →  separate counter; do not add to by_role/by_type.
  {
    const rel = FEEDBACK_BYPRODUCT_PATHS.parse_warnings;
    const abs = join(root, rel);
    trackPresent(rel, abs);
    const lines = safeReadLines(abs);
    if (lines) {
      for (const line of lines) {
        if (PARSE_WARNING_ENTRY_RE.test(line)) {
          summary.parse_warnings += 1;
        }
      }
    }
  }

  summary.present_files = [...new Set(presentFiles)].sort();
  return summary;
}
