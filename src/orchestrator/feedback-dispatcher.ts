/**
 * Phase 10: Feedback block dispatcher.
 *
 * Mounted at each primary-artifact validation point. Reads the artifact,
 * parses ReviewLoopRequest blocks, routes them per the §5.1 routing table,
 * writes byproduct files (.agent/clarifications.md, followups.md,
 * feedback-notes.md, parse-warnings.md), and registers them in the orchestrator
 * registry so the scope guard treats them as orchestrator-owned.
 *
 * Failure-safe: ALL IO errors are swallowed (best-effort, mirroring
 * emitProgress's try/catch). The dispatcher never throws back into the
 * main flow. Parse errors never block the main flow — they only land in
 * parse-warnings.md.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { computeDigest } from '../runtime/digest.js';
import {
  parseFeedbackBlocks,
  reparseSingleBlock,
} from '../artifacts/feedback-block-parser.js';
import type {
  FeedbackBlock,
  FeedbackProtocolConfig,
  FeedbackRole,
  ParsedFeedbackBlocks,
} from '../types.js';

/** Minimal registry interface the dispatcher needs. */
export interface DispatcherRegistry {
  register(filePath: string, digest: string): void;
}

/** Outcome of a single dispatch call (for logging/testing). */
export interface FeedbackDispatchResult {
  role: FeedbackRole;
  artifact_path: string;
  blocks_accepted: number;
  blocks_rejected: number;
  clarifications_written: number;
  followups_written: number;
  notes_written: number;
  warnings_written: number;
  /** Non-fatal IO/parse errors encountered (never thrown). */
  notes: string[];
}

/** Parameters for dispatchFeedbackBlocks. */
export interface DispatchParams {
  projectRoot: string;
  runId: string;
  role: FeedbackRole;
  /** Absolute path to the primary artifact (plan.md / handoff / audit-report / final-audit). */
  artifactPath: string;
  config: FeedbackProtocolConfig;
  registry?: DispatcherRegistry;
}

const CLARIFICATIONS_PATH = '.agent/clarifications.md';
const FOLLOWUPS_PATH = '.agent/followups.md';
const FEEDBACK_NOTES_PATH = '.agent/feedback-notes.md';
const PARSE_WARNINGS_PATH = '.agent/parse-warnings.md';

function ts(): string {
  return new Date().toISOString();
}

function excerpt(s: string, n = 200): string {
  return s.slice(0, n);
}

/**
 * Append a section to a byproduct file, creating it if needed.
 * Registers the file in the orchestrator registry (best-effort).
 */
async function appendByproduct(
  projectRoot: string,
  relPath: string,
  content: string,
  registry?: DispatcherRegistry,
): Promise<void> {
  const abs = join(projectRoot, relPath);
  const dir = join(abs, '..');
  await mkdir(dir, { recursive: true });
  await appendFile(abs, content, 'utf8');
  if (registry) {
    try {
      const after = await readFile(abs, 'utf8');
      registry.register(abs, computeDigest(after));
    } catch {
      /* best-effort */
    }
  }
}


/**
 * Route a single accepted block per the §5.1 routing table.
 * Returns counts of byproducts written.
 */
async function routeBlock(
  projectRoot: string,
  runId: string,
  block: FeedbackBlock,
  registry: DispatcherRegistry | undefined,
): Promise<{ clarifications: number; followups: number; notes: number }> {
  let clarifications = 0;
  let followups = 0;
  let notes = 0;

  switch (block.type) {
    case 'clarify': {
      const blocking = block.fields.blocking === true;
      const header = `## ${ts()} | run ${runId} | clarify${blocking ? ' (blocking)' : ''} | line ${block.source_line}`;
      const body = `Q: ${String(block.fields.question ?? block.message)}`;
      await appendByproduct(projectRoot, CLARIFICATIONS_PATH, `${header}\n${body}\n\n`, registry);
      clarifications = 1;
      break;
    }
    case 'followup_task':
    case 'verification_suggestion': {
      const header = `### ${ts()} | run ${runId} | ${block.type} | line ${block.source_line}`;
      const title = block.fields.title ? `**${String(block.fields.title)}**` : `**${block.type}**`;
      const desc = String(block.fields.description ?? block.fields.reason ?? block.message);
      const parts = [header, `- [ ] ${title}`, `  - ${desc}`];
      if (Array.isArray(block.fields.suggested_files)) {
        parts.push(`  - files: ${(block.fields.suggested_files as string[]).join(', ')}`);
      }
      if (Array.isArray(block.fields.command)) {
        parts.push(`  - verify: \`${(block.fields.command as string[]).join(' ')}\``);
      }
      await appendByproduct(projectRoot, FOLLOWUPS_PATH, parts.join('\n') + '\n\n', registry);
      followups = 1;
      break;
    }
    case 'risk_note':
    case 'scope_concern': {
      const header = `### ${ts()} | run ${runId} | ${block.type} | origin ${block.origin_agent} | line ${block.source_line}`;
      const desc = String(block.fields.description ?? block.fields.reason ?? block.message);
      const parts = [header, `- message: ${block.message}`, `- description: ${desc}`];
      if (block.fields.category) parts.push(`- category: ${String(block.fields.category)}`);
      if (block.fields.mitigation_hint) parts.push(`- mitigation: ${String(block.fields.mitigation_hint)}`);
      if (Array.isArray(block.fields.requested_paths)) {
        parts.push(`- paths: ${(block.fields.requested_paths as string[]).join(', ')}`);
      }
      await appendByproduct(projectRoot, FEEDBACK_NOTES_PATH, parts.join('\n') + '\n\n', registry);
      notes = 1;
      break;
    }
    default:
      break;
  }
  return { clarifications, followups, notes };
}

/**
 * Write parse errors to .agent/parse-warnings.md (append).
 */
async function writeParseWarnings(
  projectRoot: string,
  runId: string,
  role: FeedbackRole,
  artifactRelPath: string,
  errors: { source_line: number; reason: string; raw_excerpt: string }[],
  registry: DispatcherRegistry | undefined,
): Promise<number> {
  if (errors.length === 0) return 0;
  const header = `## ${ts()} | run ${runId} | ${role} | ${artifactRelPath}`;
  const body = errors
    .map(
      (e) =>
        `- line ${e.source_line}: ${e.reason}\n  \`\`\`\n  ${excerpt(e.raw_excerpt, 160).replace(/\n/g, '\n  ')}\n  \`\`\``,
    )
    .join('\n');
  await appendByproduct(projectRoot, PARSE_WARNINGS_PATH, `${header}\n${body}\n\n`, registry);
  return errors.length;
}

/**
 * Phase 10 entry point. Read artifact → parse → route → write byproducts.
 * Never throws. Returns a summary for logging.
 */
export async function dispatchFeedbackBlocks(
  params: DispatchParams,
): Promise<FeedbackDispatchResult> {
  const { projectRoot, runId, role, artifactPath, config, registry } = params;
  const result: FeedbackDispatchResult = {
    role,
    artifact_path: artifactPath,
    blocks_accepted: 0,
    blocks_rejected: 0,
    clarifications_written: 0,
    followups_written: 0,
    notes_written: 0,
    warnings_written: 0,
    notes: [],
  };

  // Master switch: when disabled, do nothing (byte-identical to pre-Phase-10).
  if (!config.enabled) {
    return result;
  }

  try {
    if (!existsSync(artifactPath)) {
      result.notes.push(`artifact not found: ${artifactPath}`);
      return result;
    }
    const md = await readFile(artifactPath, 'utf8');
    const parsed: ParsedFeedbackBlocks = parseFeedbackBlocks(
      md,
      role,
      config.max_blocks_per_document,
      config.allowed_types_per_role,
    );

    result.blocks_accepted = parsed.blocks.length;
    result.blocks_rejected = parsed.errors.length;

    for (const block of parsed.blocks) {
      try {
        const counts = await routeBlock(projectRoot, runId, block, registry);
        result.clarifications_written += counts.clarifications;
        result.followups_written += counts.followups;
        result.notes_written += counts.notes;
      } catch (err) {
        result.notes.push(
          `route error for block @ line ${block.source_line}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const rel = artifactPath.startsWith(projectRoot)
      ? artifactPath.slice(projectRoot.length + 1)
      : artifactPath;
    try {
      result.warnings_written = await writeParseWarnings(
        projectRoot,
        runId,
        role,
        rel,
        parsed.errors,
        registry,
      );
    } catch (err) {
      result.notes.push(
        `parse-warnings write error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch (err) {
    // Never throw back into the main flow.
    result.notes.push(`dispatch error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Phase 10 §8: self-correction single-block rewrite hook.
 *
 * Given a failed block's raw body + source line, ask the caller to produce a
 * rewritten body (the orchestrator invokes the agent with a narrow prompt),
 * then re-parse just that body. Returns the re-parsed result; never throws.
 * The orchestrator is responsible for enforcing the 1-retry, no-recursion cap.
 */
export function validateRewrittenBlock(
  rewrittenBody: string,
  role: FeedbackRole,
  sourceLine: number,
  config: FeedbackProtocolConfig,
): ParsedFeedbackBlocks {
  return reparseSingleBlock(
    rewrittenBody,
    role,
    sourceLine,
    config.allowed_types_per_role,
  );
}

/**
 * Read .agent/clarifications.md content for injection into the next Planner
 * prompt. Returns empty string if absent. Best-effort, never throws.
 */
export async function readClarificationsForPlanner(projectRoot: string): Promise<string> {
  try {
    const abs = join(projectRoot, CLARIFICATIONS_PATH);
    if (!existsSync(abs)) return '';
    return await readFile(abs, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Read .agent/feedback-notes.md content for injection into Auditor / Final Auditor
 * prompts. Returns empty string if absent. Best-effort, never throws.
 */
export async function readFeedbackNotesForAudit(projectRoot: string): Promise<string> {
  try {
    const abs = join(projectRoot, FEEDBACK_NOTES_PATH);
    if (!existsSync(abs)) return '';
    return await readFile(abs, 'utf8');
  } catch {
    return '';
  }
}
