/**
 * Commit Manager — handles git staging, commit, tag, and template rendering.
 * Phase 5 §8: Commit boundary rules, staging, commit message, and tag.
 *
 * Only the Orchestrator may call these functions. Developer, Planner, Auditor,
 * and Final Auditor must never execute git add/commit/tag/push.
 */

import { runGit } from './git-manager.js';

// ─── Template Rendering ────────────────────────────────────────

/** Supported placeholders in commit message and tag templates. */
const KNOWN_COMMIT_PLACEHOLDERS = new Set([
  '{task_slug}',
  '{run_id}',
  '{iteration}',
  '{short_goal_digest}',
]);

const KNOWN_TAG_PLACEHOLDERS = new Set([
  '{run_id}',
  '{task_slug}',
]);

/**
 * Render a commit message template by replacing all placeholders.
 * Throws if an unknown placeholder is found.
 */
export function renderCommitMessage(
  template: string,
  values: {
    task_slug: string;
    run_id: string;
    iteration: number;
    short_goal_digest: string;
  },
): string {
  return renderTemplate(template, { ...values, iteration: String(values.iteration) } as unknown as Record<string, string>, KNOWN_COMMIT_PLACEHOLDERS, 'commit message');
}

/**
 * Render a tag name template by replacing all placeholders.
 * Throws if an unknown placeholder is found.
 */
export function renderTagName(
  template: string,
  values: {
    run_id: string;
    task_slug: string;
  },
): string {
  return renderTemplate(template, values as Record<string, string>, KNOWN_TAG_PLACEHOLDERS, 'tag name');
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
  knownPlaceholders: Set<string>,
  context: string,
): string {
  // Find all {placeholder} tokens
  const placeholderPattern = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  const unknown: string[] = [];

  while ((match = placeholderPattern.exec(template)) !== null) {
    const token = `{${match[1]}}`;
    if (!knownPlaceholders.has(token)) {
      unknown.push(token);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown ${context} placeholder(s): ${unknown.join(', ')}. ` +
      `Known placeholders: ${[...knownPlaceholders].join(', ')}`,
    );
  }

  let result = template;
  for (const [key, value] of Object.entries(values)) {
    const placeholder = `{${key}}`;
    result = result.split(placeholder).join(value);
  }
  return result;
}

// ─── Staging ───────────────────────────────────────────────────

/**
 * Files that are local-only and must NOT enter the commit.
 * Phase 5 §8.2
 */
export const LOCAL_ONLY_PATTERNS = [
  '.agent/state.json',
  '.agent/run.lock',
  '.agent/cancel-request.json',
  '.agent/iteration-log.md',
  '.agent/progress.json',
  '.agent/progress.md',
  '.agent/verification/',
  '.agent/evidence/',
  '.agent/history/',
  '.agent/debug/',
  '.agent/transcripts/',
  'node_modules/',
  'dist/',
];

/**
 * Versioned artifacts that SHOULD enter the commit.
 * Phase 5 §8.1
 */
export const VERSIONED_ARTIFACT_PATHS = [
  '.agent/plan.md',
  '.agent/GOAL.md',
  '.agent/developer-handoff.md',
  '.agent/audit-report.md',
  '.agent/final-audit.md',
];

const VERSIONED_ARTIFACT_SET = new Set<string>(VERSIONED_ARTIFACT_PATHS);

/**
 * Phase 8E R3: versioned `.agent` artifacts that the integration finalizer may
 * force-add into the final project commit. `.agent/**` is ignored by
 * `.gitignore`, so these artifacts only enter the commit through `git add -f`.
 * `.agent/task-runs/**` is intentionally NOT listed.
 */
export const INTEGRATION_VERSIONED_ARTIFACT_PATHS = [
  '.agent/GOAL.md',
  '.agent/plan.md',
  '.agent/task-graph.json',
  '.agent/task-results.json',
  '.agent/final-audit.md',
  '.agent/integration/integration-plan.json',
  '.agent/integration/cherry-pick-log.jsonl',
  '.agent/integration/integrated-diff-metadata.json',
  '.agent/integration/changed-files.json',
  '.agent/integration/untracked-files.json',
  '.agent/integration/diff-metadata.json',
  '.agent/integration/scope-report.json',
  '.agent/integration/verification-manifest.json',
  '.agent/integration/final-audit-context.json',
] as const;

/**
 * Phase 8E R3: optional versioned `.agent` artifacts that may be force-added
 * when present (e.g. only written when integration had conflicts or excluded
 * tasks). Filtered by existence before staging.
 */
export const OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS = [
  '.agent/integration/conflict-report.md',
  '.agent/integration/excluded-tasks.md',
] as const;

const INTEGRATION_ALLOWLIST = new Set<string>([
  ...INTEGRATION_VERSIONED_ARTIFACT_PATHS,
  ...OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS,
]);

/**
 * Whether a path is an allowlisted Phase 8E R3 versioned `.agent` artifact.
 */
export function isIntegrationVersionedArtifact(filePath: string): boolean {
  return INTEGRATION_ALLOWLIST.has(filePath);
}

/**
 * Check if a path is a local-only artifact.
 */
export function isLocalOnlyPath(filePath: string): boolean {
  return LOCAL_ONLY_PATTERNS.some((pattern) => {
    if (pattern.endsWith('/')) {
      return filePath.startsWith(pattern) || filePath.startsWith(pattern.slice(0, -1));
    }
    return filePath === pattern;
  });
}

/**
 * Stage specific files for commit using precise pathspecs.
 * Phase 5 §8.3: No unprotected `git add -A`.
 */
export async function stageFiles(
  projectRoot: string,
  paths: string[],
): Promise<{ success: boolean; error?: string }> {
  if (paths.length === 0) {
    return { success: true };
  }

  // Stage each file individually for precise control
  for (const filePath of paths) {
    if (isLocalOnlyPath(filePath)) {
      return {
        success: false,
        error: `Refusing to stage local-only runtime artifact: ${filePath}`,
      };
    }

    if (filePath.startsWith('.agent/') && !VERSIONED_ARTIFACT_SET.has(filePath)) {
      return {
        success: false,
        error: `Refusing to stage non-versioned .agent path: ${filePath}`,
      };
    }

    const args = VERSIONED_ARTIFACT_SET.has(filePath)
      ? ['add', '-f', '--', filePath]
      : ['add', '--', filePath];
    const result = await runGit(args, projectRoot);
    if (result.exit_code !== 0) {
      return {
        success: false,
        error: `git add failed for ${filePath}: ${result.stderr}`,
      };
    }
  }

  return { success: true };
}

/**
 * A single staged path with its force mode. Phase 8E R3 finalization uses this
 * to stage business files with plain `git add` and allowlisted ignored `.agent`
 * artifacts with `git add -f`.
 */
export interface StageEntry {
  path: string;
  /**
   * When true, the path is staged with `git add -f`. Force mode is permitted
   * ONLY for allowlisted Phase 8E R3 versioned `.agent` artifacts; requesting
   * force for any other path is rejected before git is invoked.
   */
  force: boolean;
}

/**
 * Stage files with precise pathspecs and controlled force-add.
 *
 * Rules (Phase 8E R3 §8.3):
 * - `git add -A` / `git add .` are NEVER used; each path is staged individually.
 * - Business files (non-`.agent`) stage with `git add -- <path>`.
 * - Allowlisted ignored `.agent` artifacts stage with `git add -f -- <path>`.
 * - Non-allowlisted `.agent` paths (including `.agent/task-runs/**` and
 *   `.agent/state.json`) are rejected before git is invoked.
 * - Local-only runtime artifacts (e.g. `node_modules/**`, `dist/**`) are rejected.
 * - `force: true` is rejected for any path that is not an allowlisted `.agent`
 *   artifact.
 *
 * Callers MUST verify the final staged set with `findStagedSetViolations()`.
 */
export async function stageFilesControlled(
  projectRoot: string,
  entries: StageEntry[],
): Promise<{ success: boolean; error?: string }> {
  if (entries.length === 0) {
    return { success: true };
  }

  for (const entry of entries) {
    const validationError = validateControlledStageEntry(entry);
    if (validationError) {
      return { success: false, error: validationError };
    }
  }

  for (const entry of entries) {
    const filePath = entry.path;
    const isAllowlistedArtifact = isIntegrationVersionedArtifact(filePath);
    // Allowlisted `.agent` artifacts are gitignored, so they always require -f.
    const useForce = entry.force || isAllowlistedArtifact;
    const args = useForce
      ? ['add', '-f', '--', filePath]
      : ['add', '--', filePath];

    const result = await runGit(args, projectRoot);
    if (result.exit_code !== 0) {
      return {
        success: false,
        error: `git add failed for ${filePath}: ${result.stderr}`,
      };
    }
  }

  return { success: true };
}

function validateControlledStageEntry(entry: StageEntry): string | null {
  const filePath = entry.path;

  if (isLocalOnlyPath(filePath)) {
    return `Refusing to stage local-only runtime artifact: ${filePath}`;
  }

  const isAgentPath = filePath.startsWith('.agent/');
  const isAllowlistedArtifact = isIntegrationVersionedArtifact(filePath);

  if (isAgentPath && !isAllowlistedArtifact) {
    return `Refusing to stage non-allowlisted .agent path: ${filePath}`;
  }

  if (entry.force && !isAllowlistedArtifact) {
    return `Force-add is only permitted for allowlisted .agent artifacts: ${filePath}`;
  }

  return null;
}

/**
 * Get the list of currently staged files.
 */
export async function getStagedFiles(projectRoot: string): Promise<string[]> {
  const result = await runGit(['diff', '--cached', '--name-only', '-z'], projectRoot);
  if (result.exit_code !== 0) {
    return [];
  }
  return result.stdout.split('\0').filter(Boolean);
}

/**
 * Verify that the staged set contains only allowed files.
 * Returns the list of violations (files that should not be staged).
 */
export function findStagedSetViolations(
  stagedFiles: string[],
  allowedFiles: Set<string>,
): string[] {
  return stagedFiles.filter((f) => !allowedFiles.has(f));
}

// ─── Commit ────────────────────────────────────────────────────

/**
 * Create a git commit with the given message.
 */
export async function createCommit(
  projectRoot: string,
  message: string,
): Promise<{ success: boolean; commitSha?: string; error?: string }> {
  const result = await runGit(
    ['commit', '-m', message, '--no-verify'],
    projectRoot,
  );

  if (result.exit_code !== 0) {
    return {
      success: false,
      error: `git commit failed: ${result.stderr}`,
    };
  }

  // Get the SHA of the commit we just created
  const shaResult = await runGit(['rev-parse', 'HEAD'], projectRoot);
  if (shaResult.exit_code !== 0) {
    return {
      success: false,
      error: `commit created but failed to get SHA: ${shaResult.stderr}`,
    };
  }

  return {
    success: true,
    commitSha: shaResult.stdout.trim(),
  };
}

// ─── Tag ────────────────────────────────────────────────────────

/**
 * Create a local tag pointing to a specific commit.
 */
export async function createTag(
  projectRoot: string,
  tagName: string,
  commitSha?: string,
): Promise<{ success: boolean; error?: string }> {
  const args = commitSha
    ? ['tag', tagName, commitSha]
    : ['tag', tagName];

  const result = await runGit(args, projectRoot);

  if (result.exit_code !== 0) {
    return {
      success: false,
      error: `git tag failed: ${result.stderr}`,
    };
  }

  return { success: true };
}

/**
 * Check if a tag exists and what commit it points to.
 */
export async function getTagTarget(
  projectRoot: string,
  tagName: string,
): Promise<string | null> {
  const result = await runGit(
    ['rev-list', '-n', '1', tagName],
    projectRoot,
  );
  if (result.exit_code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Verify a commit exists in the repository.
 */
export async function commitExists(
  projectRoot: string,
  sha: string,
): Promise<boolean> {
  const result = await runGit(
    ['cat-file', '-t', sha],
    projectRoot,
  );
  return result.exit_code === 0 && result.stdout.trim() === 'commit';
}

/**
 * Verify that a commit's tree contains the required versioned artifacts.
 * Returns the list of missing paths (empty = all present).
 */
export async function verifyCommitTree(
  projectRoot: string,
  sha: string,
  requiredPaths: string[],
): Promise<{ valid: boolean; missing: string[] }> {
  const result = await runGit(
    ['ls-tree', '-r', '--name-only', '-z', sha],
    projectRoot,
  );
  if (result.exit_code !== 0) {
    return { valid: false, missing: [...requiredPaths] };
  }
  const treePaths = new Set(result.stdout.split('\0').filter(Boolean));
  const missing = requiredPaths.filter(p => !treePaths.has(p));
  return { valid: missing.length === 0, missing };
}

/**
 * Get the current HEAD SHA.
 */
export async function getHeadSha(projectRoot: string): Promise<string | null> {
  const result = await runGit(['rev-parse', 'HEAD'], projectRoot);
  if (result.exit_code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Check if local-only artifacts are tracked by git.
 * Phase 5 §8.2: If these are tracked, commit must be BLOCKED.
 */
export async function findTrackedLocalOnlyArtifacts(
  projectRoot: string,
): Promise<string[]> {
  const lsResult = await runGit(['ls-files', '-z'], projectRoot);
  if (lsResult.exit_code !== 0) {
    return [];
  }
  const trackedFiles = lsResult.stdout.split('\0').filter(Boolean);
  return trackedFiles.filter(isLocalOnlyPath);
}

/**
 * Build the set of files allowed in the final commit.
 * Includes versioned artifacts + business files from GOAL allowed_changes.
 */
export function buildAllowedCommitSet(
  versionedArtifacts: string[],
  businessFiles: string[],
): Set<string> {
  const allowed = new Set<string>();
  for (const artifact of versionedArtifacts) {
    allowed.add(artifact);
  }
  for (const bizFile of businessFiles) {
    allowed.add(bizFile);
  }
  return allowed;
}
