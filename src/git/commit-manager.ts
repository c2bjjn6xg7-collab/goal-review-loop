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
    const result = await runGit(['add', '--', filePath], projectRoot);
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
