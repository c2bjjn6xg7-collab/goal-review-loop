/**
 * Prompt Builder — constructs role-specific prompts from templates.
 * Phase 3 §9.3: Prompt construction principles.
 *
 * - Only discloses information needed for the current role
 * - Uses clear input/output file specifications
 * - Reiterates prohibitions (commit, tag, push, destructive git)
 * - Records template version/digest for reproducibility
 * - Data boundaries around user request to prevent injection
 */

import { readFile, unlink } from 'node:fs/promises';
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDigest, type Digest } from '../runtime/digest.js';

/** Prompt template version — increment when template content changes. */
export const PROMPT_TEMPLATE_VERSION = 1;

/**
 * Resolve the directory containing bundled prompt templates.
 * When running from an installed package, templates live next to the
 * compiled JS; when running from source they live in the repo root.
 */
export function getBundledTemplatesDir(): string {
  // __dirname equivalent for ESM
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  // Compiled: dist/agents/prompt-builder.js → dist/../prompts/ = <pkg>/prompts/
  // Source (ts-node): src/agents/prompt-builder.ts → src/../prompts/ = <repo>/prompts/
  return join(thisDir, '..', '..', 'prompts');
}

/** Prompt build result. */
export interface PromptBuildResult {
  /** The rendered prompt text. */
  prompt: string;
  /** SHA-256 digest of the prompt text. */
  prompt_digest: Digest;
  /** Template version used. */
  template_version: number;
  /** Template digest (of the raw template file). */
  template_digest: Digest;
  /** Whether prompt_file mode was used. */
  used_prompt_file: boolean;
  /** Path to the prompt file (if used_prompt_file). */
  prompt_file_path: string | null;
}

/**
 * Load a prompt template.
 * Search order:
 * 1. <projectRoot>/prompts/<templateName>  (project-local override)
 * 2. <bundled-templates-dir>/<templateName> (installed package fallback)
 * This ensures `review-loop start` works after `npm install` even when
 * the target project has no prompts/ directory.
 */
export async function loadPromptTemplate(
  projectRoot: string,
  templateName: string,
): Promise<{ content: string; digest: Digest }> {
  // 1. Project-local override
  const projectTemplatePath = join(projectRoot, 'prompts', templateName);
  if (existsSync(projectTemplatePath)) {
    const content = await readFile(projectTemplatePath, 'utf8');
    const digest = computeDigest(content);
    return { content, digest };
  }

  // 2. Bundled fallback (from installed package)
  const bundledPath = join(getBundledTemplatesDir(), templateName);
  if (existsSync(bundledPath)) {
    const content = await readFile(bundledPath, 'utf8');
    const digest = computeDigest(content);
    return { content, digest };
  }

  throw new PromptBuilderError(
    `Prompt template not found: tried ${projectTemplatePath} and ${bundledPath}`,
  );
}

/**
 * Replace ALL occurrences of a token in the template with the given value.
 * SF-4 fix: String.replace(token, value) only replaces the first match,
 * and value containing $&, $1, $$ would be misinterpreted as replacement patterns.
 * split().join() is safe: it performs literal string replacement without
 * interpreting special replacement patterns, and replaces all occurrences.
 */
function replaceAllTokens(template: string, token: string, value: string): string {
  return template.split(token).join(value);
}

/**
 * Build a prompt for the Planner role.
 * Phase 3 §10.1: Planner input includes user request, project context, and constraints.
 */
export function buildPlannerPrompt(
  template: string,
  context: PlannerPromptContext,
): string {
  let result = template;
  result = replaceAllTokens(result, '{{USER_REQUEST}}', context.user_request);
  result = replaceAllTokens(result, '{{RUN_ID}}', context.run_id);
  result = replaceAllTokens(result, '{{PROJECT_ROOT}}', context.project_root);
  result = replaceAllTokens(result, '{{BASE_COMMIT}}', context.base_commit);
  result = replaceAllTokens(result, '{{PROJECT_FILES_SUMMARY}}', context.project_files_summary || '(not available)');
  result = replaceAllTokens(result, '{{AGENTS_MD_PATH}}', context.agents_md_path || '(not available)');
  result = replaceAllTokens(result, '{{AGENTS_MD_CONTENT}}', context.agents_md_content || '(not available)');
  result = replaceAllTokens(result, '{{CLAUDE_MD_PATH}}', context.claude_md_path || '(not available)');
  result = replaceAllTokens(result, '{{CLAUDE_MD_CONTENT}}', context.claude_md_content || '(not available)');
  result = replaceAllTokens(result, '{{PACKAGE_JSON_SUMMARY}}', context.package_json_summary || '(not available)');
  result = replaceAllTokens(result, '{{CLARIFICATIONS}}', context.clarifications || '(none)');
  result = replaceAllTokens(result, '{{TEMPLATE_VERSION}}', String(PROMPT_TEMPLATE_VERSION));
  return result;
}

/**
 * Build a prompt for the Developer role.
 * Phase 3 §10.2: Developer must read plan/GOAL and follow constraints.
 */
export function buildDeveloperPrompt(
  template: string,
  context: DeveloperPromptContext,
): string {
  let result = template;
  result = replaceAllTokens(result, '{{RUN_ID}}', context.run_id);
  result = replaceAllTokens(result, '{{ITERATION}}', String(context.iteration));
  result = replaceAllTokens(result, '{{PROJECT_ROOT}}', context.project_root);
  result = replaceAllTokens(result, '{{PLAN_PATH}}', context.plan_path);
  result = replaceAllTokens(result, '{{GOAL_PATH}}', context.goal_path);
  result = replaceAllTokens(result, '{{HANDOFF_PATH}}', context.handoff_path);
  result = replaceAllTokens(result, '{{TEMPLATE_VERSION}}', String(PROMPT_TEMPLATE_VERSION));
  return result;
}

/**
 * Build a prompt for the Rework (Developer) role.
 * Phase 4 §7: Developer in rework mode reads GOAL + rework-instructions.
 */
export function buildReworkPrompt(
  template: string,
  context: ReworkPromptContext,
): string {
  let result = template;
  result = replaceAllTokens(result, '{{RUN_ID}}', context.run_id);
  result = replaceAllTokens(result, '{{ITERATION}}', String(context.iteration));
  result = replaceAllTokens(result, '{{PROJECT_ROOT}}', context.project_root);
  result = replaceAllTokens(result, '{{GOAL_PATH}}', context.goal_path);
  result = replaceAllTokens(result, '{{REWORK_INSTRUCTIONS_PATH}}', context.rework_instructions_path);
  result = replaceAllTokens(result, '{{HANDOFF_PATH}}', context.handoff_path);
  result = replaceAllTokens(result, '{{TEMPLATE_VERSION}}', String(PROMPT_TEMPLATE_VERSION));
  return result;
}

/**
 * Build a prompt for the Auditor role.
 * Phase 3 §10.3: Auditor reads evidence only, must not trust Developer self-assessment.
 */
export function buildAuditorPrompt(
  template: string,
  context: AuditorPromptContext,
): string {
  let result = template;
  result = replaceAllTokens(result, '{{RUN_ID}}', context.run_id);
  result = replaceAllTokens(result, '{{ITERATION}}', String(context.iteration));
  result = replaceAllTokens(result, '{{PROJECT_ROOT}}', context.project_root);
  result = replaceAllTokens(result, '{{PLAN_PATH}}', context.plan_path);
  result = replaceAllTokens(result, '{{GOAL_PATH}}', context.goal_path);
  result = replaceAllTokens(result, '{{HANDOFF_PATH}}', context.handoff_path);
  result = replaceAllTokens(result, '{{VERIFICATION_MANIFEST_PATH}}', context.verification_manifest_path);
  result = replaceAllTokens(result, '{{CHANGED_FILES_PATH}}', context.changed_files_path);
  result = replaceAllTokens(result, '{{UNTRACKED_FILES_PATH}}', context.untracked_files_path);
  result = replaceAllTokens(result, '{{SCOPE_REPORT_PATH}}', context.scope_report_path);
  result = replaceAllTokens(result, '{{TRACKED_DIFF_PATH}}', context.tracked_diff_path);
  result = replaceAllTokens(result, '{{DIFF_METADATA_PATH}}', context.diff_metadata_path);
  result = replaceAllTokens(result, '{{AUDIT_REPORT_PATH}}', context.audit_report_path);
  result = replaceAllTokens(result, '{{GOAL_DIGEST}}', context.goal_digest);
  result = replaceAllTokens(result, '{{DIFF_DIGEST}}', context.diff_digest);
  result = replaceAllTokens(result, '{{FEEDBACK_NOTES_PATH}}', context.feedback_notes_path || '.agent/feedback-notes.md');
  result = replaceAllTokens(result, '{{FEEDBACK_NOTES}}', context.feedback_notes || '(none)');
  result = replaceAllTokens(result, '{{TEMPLATE_VERSION}}', String(PROMPT_TEMPLATE_VERSION));
  return result;
}

/**
 * Build a prompt for the Final Auditor role.
 * Phase 5 §7: Pre-commit final confirmation.
 */
export function buildFinalAuditorPrompt(
  template: string,
  context: FinalAuditorPromptContext,
): string {
  let result = template;
  result = replaceAllTokens(result, '{{RUN_ID}}', context.run_id);
  result = replaceAllTokens(result, '{{ITERATION}}', String(context.iteration));
  result = replaceAllTokens(result, '{{PROJECT_ROOT}}', context.project_root);
  result = replaceAllTokens(result, '{{PLAN_PATH}}', context.plan_path);
  result = replaceAllTokens(result, '{{GOAL_PATH}}', context.goal_path);
  result = replaceAllTokens(result, '{{HANDOFF_PATH}}', context.handoff_path);
  result = replaceAllTokens(result, '{{AUDIT_REPORT_PATH}}', context.audit_report_path);
  result = replaceAllTokens(result, '{{VERIFICATION_MANIFEST_PATH}}', context.verification_manifest_path);
  result = replaceAllTokens(result, '{{CHANGED_FILES_PATH}}', context.changed_files_path);
  result = replaceAllTokens(result, '{{UNTRACKED_FILES_PATH}}', context.untracked_files_path);
  result = replaceAllTokens(result, '{{SCOPE_REPORT_PATH}}', context.scope_report_path);
  result = replaceAllTokens(result, '{{DIFF_METADATA_PATH}}', context.diff_metadata_path);
  result = replaceAllTokens(result, '{{FINAL_AUDIT_PATH}}', context.final_audit_path);
  result = replaceAllTokens(result, '{{GOAL_DIGEST}}', context.goal_digest);
  result = replaceAllTokens(result, '{{DIFF_DIGEST}}', context.diff_digest);
  result = replaceAllTokens(result, '{{AUDIT_REPORT_DIGEST}}', context.audit_report_digest);
  result = replaceAllTokens(result, '{{VERIFICATION_MANIFEST_DIGEST}}', context.verification_manifest_digest);
  result = replaceAllTokens(result, '{{FEEDBACK_NOTES_PATH}}', context.feedback_notes_path || '.agent/feedback-notes.md');
  result = replaceAllTokens(result, '{{FEEDBACK_NOTES}}', context.feedback_notes || '(none)');
  result = replaceAllTokens(result, '{{TEMPLATE_VERSION}}', String(PROMPT_TEMPLATE_VERSION));
  return result;
}

/** Context for Planner prompt. */
export interface PlannerPromptContext {
  user_request: string;
  run_id: string;
  project_root: string;
  base_commit: string;
  /** Phase 10: accumulated clarifications to address in this plan. */
  clarifications?: string;
  project_files_summary?: string;
  agents_md_path?: string;
  agents_md_content?: string;
  claude_md_path?: string;
  claude_md_content?: string;
  package_json_summary?: string;
}

/** Context for Developer prompt. */
export interface DeveloperPromptContext {
  run_id: string;
  iteration: number;
  project_root: string;
  plan_path: string;
  goal_path: string;
  handoff_path: string;
}

/** Context for Rework prompt. Phase 4 §7. */
export interface ReworkPromptContext {
  run_id: string;
  iteration: number;
  project_root: string;
  goal_path: string;
  rework_instructions_path: string;
  handoff_path: string;
}

/** Context for Auditor prompt. */
export interface AuditorPromptContext {
  run_id: string;
  iteration: number;
  project_root: string;
  plan_path: string;
  goal_path: string;
  handoff_path: string;
  verification_manifest_path: string;
  changed_files_path: string;
  untracked_files_path: string;
  scope_report_path: string;
  tracked_diff_path: string;
  diff_metadata_path: string;
  audit_report_path: string;
  goal_digest: string;
  diff_digest: string;
  /** Phase 10: content of .agent/feedback-notes.md for audit visibility. */
  feedback_notes?: string;
  /** Phase 10: path to the feedback notes file. */
  feedback_notes_path?: string;
}

/** Context for Final Auditor prompt. Phase 5 §7. */
export interface FinalAuditorPromptContext {
  run_id: string;
  iteration: number;
  project_root: string;
  plan_path: string;
  goal_path: string;
  handoff_path: string;
  audit_report_path: string;
  verification_manifest_path: string;
  changed_files_path: string;
  untracked_files_path: string;
  scope_report_path: string;
  diff_metadata_path: string;
  final_audit_path: string;
  goal_digest: string;
  diff_digest: string;
  audit_report_digest: string;
  verification_manifest_digest: string;
  /** Phase 10: content of .agent/feedback-notes.md for audit visibility. */
  feedback_notes?: string;
  /** Phase 10: path to the feedback notes file. */
  feedback_notes_path?: string;
}

/**
 * Write prompt to a temporary file for {prompt_file} mode.
 * Phase 3 §9.2:
 * - File located in .agent/debug/ or controlled temp directory
 * - Permissions: current user read/write ONLY (0600)
 * - Default: delete body after agent completes, keep SHA-256 and log path
 */
export async function writePromptFile(
  agentDir: string,
  prompt: string,
  runId: string,
  role: string,
): Promise<string> {
  const debugDir = join(agentDir, 'debug');
  if (!existsSync(debugDir)) {
    await mkdir(debugDir, { recursive: true });
  }
  const fileName = `${runId}-${role}-prompt.md`;
  const filePath = join(debugDir, fileName);
  await writeFile(filePath, prompt, 'utf8');
  // F-306 fix: Set restrictive permissions (owner read/write only)
  await chmod(filePath, 0o600);
  return filePath;
}

/**
 * Delete a prompt file after agent completes (success, failure, timeout, or cancel).
 * F-306R2 fix: Returns a structured result instead of silently swallowing errors.
 * Caller MUST check the result and act on failures.
 */
export interface PromptCleanupResult {
  /** Whether the file was successfully deleted (or already absent). */
  success: boolean;
  /** Path that was attempted to be deleted. */
  path: string;
  /** Error message if deletion failed. Null on success. */
  error: string | null;
}

export async function deletePromptFile(filePath: string): Promise<PromptCleanupResult> {
  try {
    if (!existsSync(filePath)) {
      return { success: true, path: filePath, error: null };
    }
    await unlink(filePath);
    // Verify deletion succeeded
    if (existsSync(filePath)) {
      return {
        success: false,
        path: filePath,
        error: `Prompt file still exists after unlink: ${filePath}`,
      };
    }
    return { success: true, path: filePath, error: null };
  } catch (err) {
    return {
      success: false,
      path: filePath,
      error: `Failed to delete prompt file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Compute prompt digest for audit trail.
 */
export function computePromptDigest(prompt: string): Digest {
  return computeDigest(prompt);
}

/**
 * Full prompt build pipeline: load template → build → compute digest → optionally write file.
 */
export async function buildPrompt(
  projectRoot: string,
  templateName: string,
  buildFn: (template: string) => string,
  options: {
    use_prompt_file?: boolean;
    agent_dir?: string;
    run_id?: string;
    role?: string;
  } = {},
): Promise<PromptBuildResult> {
  const { content: template, digest: template_digest } = await loadPromptTemplate(projectRoot, templateName);
  const prompt = buildFn(template);
  const prompt_digest = computePromptDigest(prompt);

  let used_prompt_file = false;
  let prompt_file_path: string | null = null;

  if (options.use_prompt_file && options.agent_dir && options.run_id && options.role) {
    prompt_file_path = await writePromptFile(
      options.agent_dir,
      prompt,
      options.run_id,
      options.role,
    );
    used_prompt_file = true;
  }

  return {
    prompt,
    prompt_digest,
    template_version: PROMPT_TEMPLATE_VERSION,
    template_digest,
    used_prompt_file,
    prompt_file_path,
  };
}

export class PromptBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptBuilderError';
  }
}

// ─── Phase 8B: Per-task Developer prompt ─────────────────────

/**
 * Context for a per-task Developer prompt (Phase 8B).
 * Each task is a narrow, independently-verifiable unit of work.
 */
export interface TaskDeveloperPromptContext {
  run_id: string;
  project_root: string;
  /** 1-based index of this task within the topological order. */
  task_index: number;
  task_total: number;
  task_id: string;
  task_title: string;
  task_description: string;
  allowed_changes: string[];
  disallowed_changes: string[];
  /** Verification commands serialized as human-readable strings. */
  verification_commands: Array<{ id: string; command: string[]; cwd: string; required: boolean; timeout_seconds: number }>;
  /** GOAL success criteria lines, for context. */
  goal_success_criteria: string[];
  goal_path: string;
  handoff_path: string;
}

/**
 * Build a Developer prompt scoped to a single task node.
 *
 * This prompt intentionally excludes the full plan and other tasks to keep
 * the Developer's context short enough for the domestic API to handle.
 */
export function buildTaskDeveloperPrompt(context: TaskDeveloperPromptContext): string {
  const allowedList = context.allowed_changes.map((p) => `- \`${p}\``).join('\n');
  const disallowedList = context.disallowed_changes.length > 0
    ? context.disallowed_changes.map((p) => `- \`${p}\``).join('\n')
    : '(none)';
  const verificationList = context.verification_commands.map((vc) => {
    const cmd = vc.command.join(' ');
    return `- id: \`${vc.id}\` — \`${cmd}\` (cwd: \`${vc.cwd}\`, required: ${vc.required}, timeout: ${vc.timeout_seconds}s)`;
  }).join('\n');
  const criteriaList = context.goal_success_criteria.length > 0
    ? context.goal_success_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(see GOAL.md)';

  return `# Developer Task — Run ${context.run_id}

You are the **Developer** executing task **${context.task_index} of ${context.task_total}** for run \`${context.run_id}\`.

## Task

- **ID**: \`${context.task_id}\`
- **Title**: ${context.task_title}
- **Description**:
${context.task_description}

## Scope — ONLY modify these paths

You MUST NOT modify any file outside the paths listed below. The Scope Guard will reject changes outside this list.

${allowedList}

### Disallowed changes

${disallowedList}

## Verification — these commands MUST pass before you finish

After making your changes, ensure every required verification command below passes. Do not claim success without running them.

${verificationList}

## GOAL Context (for reference only)

The overall GOAL success criteria (do NOT implement other tasks — only this one):

${criteriaList}

Full GOAL: \`${context.goal_path}\`

## Rules

1. ONLY modify files within the allowed_changes listed above.
2. Do NOT execute git commit, tag, push, or any destructive Git command.
3. Do NOT delete, skip, or weaken tests.
4. Do NOT modify \`.agent/state.json\`, \`.agent/GOAL.md\`, \`.agent/plan.md\`, \`.agent/task-graph.json\`, or any orchestrator-owned file.
5. When done, write your handoff to \`${context.handoff_path}\` with front matter:

\`\`\`yaml
---
schema_version: 1
run_id: "${context.run_id}"
iteration: ${context.task_index}
author_role: "developer"
status: "COMPLETED"
---
\`\`\`

Set \`status: "BLOCKED"\` only if you genuinely cannot proceed.
6. Keep your work focused and minimal — this is one narrow task, not the whole goal.
`;
}
