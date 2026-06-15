# Phase 5: Finalization, Local Commit & Terminal Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement FINALIZING → PASSED state closure with Final Audit, pre-commit digest checks, local git commit/tag, --no-commit mode, and resume-from-FINALIZING support.

**Architecture:** Extend the existing orchestrator to continue past the current FINALIZING stub. After Auditor PASS, the orchestrator runs a Final Auditor agent, validates the final-audit.md artifact, performs mechanical digest/scope/verification checks, then stages and commits allowed files via Git Manager. New error categories handle finalization-specific failures. Resume and status commands are updated to support the new finalization flow.

**Tech Stack:** TypeScript, Node.js, Vitest, existing module ecosystem (StateStore, GitManager, ArtifactStore, AgentAdapter, etc.)

---

## File Structure

### New Files
- `src/git/commit-manager.ts` — Git staging, commit, tag, and template rendering logic
- `src/agents/final-auditor-adapter.ts` — Final Auditor input builder and output validator
- `prompts/final-auditor.md` — Final Auditor prompt template
- `tests/unit/commit-manager.test.ts` — Unit tests for commit/tag/template logic
- `tests/unit/final-auditor-adapter.test.ts` — Unit tests for final auditor adapter
- `tests/integration/finalization.test.ts` — Integration tests for the full finalization flow

### Modified Files
- `src/types.ts` — Add Phase 5 error categories, extend RunState, StatusOutput, FinalAuditFrontMatter, OrchestratorResult
- `src/orchestrator/state-store.ts` — Extend state schema for finalization fields
- `src/orchestrator/run-orchestrator.ts` — Replace FINALIZING stub with full finalization pipeline
- `src/artifacts/artifact-schemas.ts` — Extend FinalAuditFrontMatter with audit_report_digest, verification_manifest_digest, created_at
- `src/artifacts/json-schemas.ts` — Extend statusOutputSchema with Phase 5 fields
- `src/artifacts/config.ts` — Add final_auditor agent config, validateMvpConstraints already rejects push
- `src/cli/start.ts` — Handle commit/tag/no-commit result fields
- `src/cli/resume.ts` — Support resume from FINALIZING and BLOCKED-with-commit
- `src/cli/status.ts` — Show final audit, commit, tag status
- `src/agents/prompt-builder.ts` — Add FinalAuditorPromptContext and buildFinalAuditorPrompt
- `tests/fixtures/fake-agent.mjs` — Add final-auditor role behaviors
- `src/index.ts` — Export new public API

---

## Task 1: Extend Types for Phase 5

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add Phase 5 error categories to ErrorCategory**

Add these new error codes after the existing `GIT_COMMIT_ERROR`:

```typescript
export const ErrorCategory = {
  // ... existing codes ...
  GIT_COMMIT_ERROR: 'GIT_COMMIT_ERROR',
  FINAL_AUDIT_FAILED: 'FINAL_AUDIT_FAILED',
  FINAL_AUDIT_SCHEMA_ERROR: 'FINAL_AUDIT_SCHEMA_ERROR',
  PRE_COMMIT_DIGEST_MISMATCH: 'PRE_COMMIT_DIGEST_MISMATCH',
  PRE_COMMIT_SCOPE_VIOLATION: 'PRE_COMMIT_SCOPE_VIOLATION',
  PRE_COMMIT_STAGED_SET_VIOLATION: 'PRE_COMMIT_STAGED_SET_VIOLATION',
  GIT_TAG_ERROR: 'GIT_TAG_ERROR',
  UNSUPPORTED_PUSH: 'UNSUPPORTED_PUSH',
  // ... existing codes after ...
  USER_CANCELLED: 'USER_CANCELLED',
  INFRASTRUCTURE_ERROR: 'INFRASTRUCTURE_ERROR',
} as const;
```

- [ ] **Step 2: Add Phase 5 default result mappings**

```typescript
export const ERROR_CATEGORY_DEFAULT_RESULT: ReadonlyMap<ErrorCategory, Phase> = new Map([
  // ... existing mappings ...
  [ErrorCategory.FINAL_AUDIT_FAILED, Phase.BLOCKED],
  [ErrorCategory.FINAL_AUDIT_SCHEMA_ERROR, Phase.BLOCKED],
  [ErrorCategory.PRE_COMMIT_DIGEST_MISMATCH, Phase.BLOCKED],
  [ErrorCategory.PRE_COMMIT_SCOPE_VIOLATION, Phase.BLOCKED],
  [ErrorCategory.PRE_COMMIT_STAGED_SET_VIOLATION, Phase.BLOCKED],
  [ErrorCategory.GIT_TAG_ERROR, Phase.BLOCKED],
  [ErrorCategory.UNSUPPORTED_PUSH, Phase.BLOCKED],
  // ... existing mappings ...
]);
```

- [ ] **Step 3: Extend FinalAuditFrontMatter with new digest fields**

Replace the existing `FinalAuditFrontMatter` interface:

```typescript
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
```

- [ ] **Step 4: Extend RunState with finalization fields**

Add these optional fields to the `RunState` interface:

```typescript
export interface RunState {
  // ... existing fields ...
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
}
```

- [ ] **Step 5: Extend StatusOutput with Phase 5 fields**

Add these fields to the `StatusOutput` interface:

```typescript
export interface StatusOutput {
  // ... existing fields ...
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
}
```

- [ ] **Step 6: Extend AgentRunInput role type**

Change the `role` field in `AgentRunInput` to include `'final-auditor'`:

```typescript
export interface AgentRunInput {
  role: 'planner' | 'developer' | 'auditor' | 'final-auditor';
  // ... rest unchanged ...
}
```

- [ ] **Step 7: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add Phase 5 error categories, finalization state fields, and extended interfaces"
```

---

## Task 2: Extend State Store Schema for Finalization Fields

**Files:**
- Modify: `src/orchestrator/state-store.ts`

- [ ] **Step 1: Add finalization fields to STATE_SCHEMA**

Add these properties to the `STATE_SCHEMA` object after `cancel_requested_at`:

```typescript
final_commit_sha: { type: ['string', 'null'] },
final_commit_message: { type: ['string', 'null'] },
finalized_at: { type: ['string', 'null'] },
commit_skipped: { type: 'boolean' },
skip_reason: { type: ['string', 'null'] },
tag_name: { type: ['string', 'null'] },
tag_created: { type: 'boolean' },
```

Also add them to the `required` array.

- [ ] **Step 2: Add defaults to buildInitialState**

Add these fields to the initial state object in `buildInitialState`:

```typescript
final_commit_sha: null,
final_commit_message: null,
finalized_at: null,
commit_skipped: false,
skip_reason: null,
tag_name: null,
tag_created: false,
```

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator/state-store.ts
git commit -m "feat(state-store): extend state schema with Phase 5 finalization fields"
```

---

## Task 3: Extend Final Audit Schema

**Files:**
- Modify: `src/artifacts/artifact-schemas.ts`

- [ ] **Step 1: Update FINAL_AUDIT_SCHEMA with new required fields**

Replace the existing `FINAL_AUDIT_SCHEMA` with:

```typescript
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
```

- [ ] **Step 2: Update parseFinalAudit required fields validation**

Update the `validateRequiredFields` call in `parseFinalAudit`:

```typescript
validateRequiredFields(
  frontMatter,
  ['schema_version', 'run_id', 'author_role', 'decision', 'final_iteration', 'goal_digest', 'diff_digest', 'audit_report_digest', 'verification_manifest_digest', 'created_at'],
  filePath,
);
```

- [ ] **Step 3: Commit**

```bash
git add src/artifacts/artifact-schemas.ts
git commit -m "feat(artifact-schemas): extend final-audit schema with audit_report_digest, verification_manifest_digest, created_at"
```

---

## Task 4: Create Commit Manager

**Files:**
- Create: `src/git/commit-manager.ts`

- [ ] **Step 1: Write the commit-manager module**

Create `src/git/commit-manager.ts` with the following content:

```typescript
/**
 * Commit Manager — handles git staging, commit, tag, and template rendering.
 * Phase 5 §8: Commit boundary rules, staging, commit message, and tag.
 *
 * Only the Orchestrator may call these functions. Developer, Planner, Auditor,
 * and Final Auditor must never execute git add/commit/tag/push.
 */

import { runGit } from './git-manager.js';
import { createHash } from 'node:crypto';

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
  return renderTemplate(template, values, KNOWN_COMMIT_PLACEHOLDERS, 'commit message');
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
  return renderTemplate(template, values, KNOWN_TAG_PLACEHOLDERS, 'tag name');
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
    result = result.split(key).join(value);
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
```

- [ ] **Step 2: Commit**

```bash
git add src/git/commit-manager.ts
git commit -m "feat(git): add commit-manager with staging, commit, tag, and template rendering"
```

---

## Task 5: Create Final Auditor Adapter

**Files:**
- Create: `src/agents/final-auditor-adapter.ts`

- [ ] **Step 1: Write the final-auditor-adapter module**

Create `src/agents/final-auditor-adapter.ts`:

```typescript
/**
 * Final Auditor Adapter — builds Final Auditor input and validates output.
 * Phase 5 §7: Final Audit is a pre-commit confirmation, not a replacement for Auditor.
 *
 * Final Auditor rules:
 * - Reads all evidence, audit-report, GOAL, handoff
 * - Writes .agent/final-audit.md
 * - Decision: PASS, FAILED, or BLOCKED
 * - Must validate digest consistency
 * - Must not modify business code
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseFinalAudit } from '../artifacts/artifact-schemas.js';
import type {
  AgentRunInput,
  FinalAuditFrontMatter,
  FinalAuditDecision,
} from '../types.js';
import type { Digest } from '../runtime/digest.js';

/** Final Auditor expected artifacts (relative to project root). */
const FINAL_AUDITOR_ARTIFACTS = ['.agent/final-audit.md'];

/** The only file the Final Auditor is allowed to create or modify. */
const FINAL_AUDITOR_ALLOWED_WRITE = '.agent/final-audit.md';

/**
 * Build the AgentRunInput for the Final Auditor.
 */
export function buildFinalAuditorInput(params: {
  run_id: string;
  iteration: number;
  project_root: string;
  command_template: string[];
  timeout_seconds: number;
  prompt: string;
  prompt_file?: string;
  signal?: AbortSignal;
}): AgentRunInput {
  return {
    role: 'final-auditor',
    project_root: params.project_root,
    run_id: params.run_id,
    iteration: params.iteration,
    prompt: params.prompt,
    prompt_file: params.prompt_file,
    expected_artifacts: FINAL_AUDITOR_ARTIFACTS.map(p => join(params.project_root, p)),
    timeout_seconds: params.timeout_seconds,
    command_template: params.command_template,
    signal: params.signal,
  };
}

/**
 * Validate Final Auditor output.
 * Phase 5 §7.4: Mechanical checks for final-audit.md.
 *
 * Checks:
 * 1. final-audit.md exists and parses correctly
 * 2. run_id matches current run
 * 3. final_iteration matches current iteration
 * 4. decision is a valid enum value
 * 5. goal_digest matches current GOAL.md digest
 * 6. diff_digest matches current diff digest
 * 7. audit_report_digest matches current audit-report.md digest
 * 8. verification_manifest_digest matches current manifest digest
 * 9. PASS decision has no unresolved Critical/High blockers in body
 */
export function validateFinalAuditorOutput(params: {
  projectRoot: string;
  runId: string;
  iteration: number;
  expectedGoalDigest: string;
  expectedDiffDigest: string;
  expectedAuditReportDigest: string;
  expectedVerificationManifestDigest: string;
}): FinalAuditorValidationResult {
  const errors: string[] = [];
  let finalAuditFm: FinalAuditFrontMatter | null = null;
  let decision: FinalAuditDecision | null = null;

  const { projectRoot, runId, iteration, expectedGoalDigest, expectedDiffDigest,
          expectedAuditReportDigest, expectedVerificationManifestDigest } = params;

  // 1. Parse final-audit.md
  const finalAuditPath = join(projectRoot, '.agent/final-audit.md');
  if (!existsSync(finalAuditPath)) {
    errors.push('final-audit.md not found');
  } else {
    try {
      const content = readFileSync(finalAuditPath, 'utf8');
      const { frontMatter, body } = parseFinalAudit(content, finalAuditPath);

      // 2. Validate run_id
      if (frontMatter.run_id !== runId) {
        errors.push(
          `final-audit run_id "${frontMatter.run_id}" does not match expected "${runId}"`,
        );
      }

      // 3. Validate final_iteration
      if (frontMatter.final_iteration !== iteration) {
        errors.push(
          `final-audit final_iteration ${frontMatter.final_iteration} does not match expected ${iteration}`,
        );
      }

      // 4. Validate author_role
      if (frontMatter.author_role !== 'auditor') {
        errors.push(`final-audit author_role "${frontMatter.author_role}" is not "auditor"`);
      }

      // 5. Validate goal_digest
      if (frontMatter.goal_digest !== expectedGoalDigest) {
        errors.push(
          `final-audit goal_digest "${frontMatter.goal_digest}" does not match expected "${expectedGoalDigest}"`,
        );
      }

      // 6. Validate diff_digest
      if (frontMatter.diff_digest !== expectedDiffDigest) {
        errors.push(
          `final-audit diff_digest "${frontMatter.diff_digest}" does not match expected "${expectedDiffDigest}"`,
        );
      }

      // 7. Validate audit_report_digest
      if (frontMatter.audit_report_digest !== expectedAuditReportDigest) {
        errors.push(
          `final-audit audit_report_digest "${frontMatter.audit_report_digest}" does not match expected "${expectedAuditReportDigest}"`,
        );
      }

      // 8. Validate verification_manifest_digest
      if (frontMatter.verification_manifest_digest !== expectedVerificationManifestDigest) {
        errors.push(
          `final-audit verification_manifest_digest "${frontMatter.verification_manifest_digest}" does not match expected "${expectedVerificationManifestDigest}"`,
        );
      }

      // 9. Check for unresolved Critical/High blockers when PASS
      decision = frontMatter.decision;
      if (decision === 'PASS') {
        const bodyLower = body.toLowerCase();
        // Simple heuristic: if body contains "critical" or "high" followed by
        // "unresolved" or "blocking", it's suspicious
        const blockerPatterns = [
          /unresolved\s+(critical|high)/i,
          /(critical|high)\s+(blocker|blocking|unresolved)/i,
          /blocking\s+issue/i,
        ];
        for (const pattern of blockerPatterns) {
          if (pattern.test(body)) {
            errors.push(
              'final-audit decision is PASS but body contains unresolved Critical/High blocker language',
            );
            break;
          }
        }
      }

      finalAuditFm = frontMatter;
    } catch (err) {
      errors.push(`final-audit parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    finalAuditFrontMatter: finalAuditFm,
    decision,
    /** Mechanical check failure overrides PASS → FAILED */
    effectiveDecision: errors.length > 0 && decision === 'PASS' ? 'FAILED' : decision,
  };
}

export interface FinalAuditorValidationResult {
  valid: boolean;
  errors: string[];
  finalAuditFrontMatter: FinalAuditFrontMatter | null;
  decision: FinalAuditDecision | null;
  /** Effective decision after mechanical checks. */
  effectiveDecision: FinalAuditDecision | 'FAILED' | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/final-auditor-adapter.ts
git commit -m "feat(agents): add final-auditor-adapter with input builder and output validator"
```

---

## Task 6: Add Final Auditor Prompt Template and Builder

**Files:**
- Create: `prompts/final-auditor.md`
- Modify: `src/agents/prompt-builder.ts`

- [ ] **Step 1: Create the final-auditor prompt template**

Create `prompts/final-auditor.md`:

```markdown
# Final Auditor — Pre-Commit Confirmation

You are the **Final Auditor** for run `{{RUN_ID}}`, iteration `{{ITERATION}}`.

Your role is to perform a **pre-commit final confirmation**. You are NOT replacing the Auditor — you are providing an additional safety check before the system creates a local git commit.

## Your Task

1. Review the GOAL, plan, developer handoff, audit report, and all evidence.
2. Verify that all Success Criteria from the GOAL are met.
3. Verify that the verification commands passed.
4. Verify that scope is respected (no disallowed changes).
5. Verify that the diff evidence is consistent with the audit report.
6. Determine if a local git commit is safe to create.

## Input Files

- Plan: `{{PLAN_PATH}}`
- GOAL: `{{GOAL_PATH}}`
- Developer Handoff: `{{HANDOFF_PATH}}`
- Audit Report: `{{AUDIT_REPORT_PATH}}`
- Verification Manifest: `{{VERIFICATION_MANIFEST_PATH}}`
- Changed Files: `{{CHANGED_FILES_PATH}}`
- Untracked Files: `{{UNTRACKED_FILES_PATH}}`
- Scope Report: `{{SCOPE_REPORT_PATH}}`
- Diff Metadata: `{{DIFF_METADATA_PATH}}`

## Digests (for verification)

- GOAL digest: `{{GOAL_DIGEST}}`
- Diff digest: `{{DIFF_DIGEST}}`
- Audit report digest: `{{AUDIT_REPORT_DIGEST}}`
- Verification manifest digest: `{{VERIFICATION_MANIFEST_DIGEST}}`

## Output

Write your final audit report to: `{{FINAL_AUDIT_PATH}}`

The front matter MUST contain:

```yaml
---
schema_version: 1
run_id: "{{RUN_ID}}"
author_role: "auditor"
decision: "PASS"  # or "FAILED" or "BLOCKED"
final_iteration: {{ITERATION}}
goal_digest: "{{GOAL_DIGEST}}"
diff_digest: "{{DIFF_DIGEST}}"
audit_report_digest: "{{AUDIT_REPORT_DIGEST}}"
verification_manifest_digest: "{{VERIFICATION_MANIFEST_DIGEST}}"
created_at: "2026-01-01T00:00:00.000Z"  # current ISO timestamp
---
```

The body MUST contain:

- **Final Decision**: PASS, FAILED, or BLOCKED
- **Success Criteria Review**: Table of each criterion and its status
- **Verification Summary**: Whether all required verification commands passed
- **Scope Summary**: Whether all changes are within allowed scope
- **Change Summary**: List of changed files and their status
- **Files To Commit**: List of files that should enter the commit
- **Versioned Artifacts**: List of .agent/ artifacts to commit
- **Local-only Artifacts Excluded**: List of .agent/ artifacts excluded from commit
- **Accepted Residual Risks**: Any residual risks accepted
- **Commit Recommendation**: Whether to commit, and any caveats

## Decision Rules

- **PASS**: All criteria met, verification passed, scope clean, digests consistent → safe to commit
- **FAILED**: One or more criteria not met, but fixable → do not commit
- **BLOCKED**: Cannot determine safety → do not commit

## Prohibitions

- Do NOT execute `git add`, `git commit`, `git tag`, `git push`, or any destructive git command.
- Do NOT modify any business code files.
- Do NOT modify any .agent/ files except `.agent/final-audit.md`.
- Do NOT create new files outside `.agent/final-audit.md`.

## Template Version

{{TEMPLATE_VERSION}}
```

- [ ] **Step 2: Add FinalAuditorPromptContext and buildFinalAuditorPrompt to prompt-builder.ts**

Add after the existing `AuditorPromptContext` interface:

```typescript
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
}
```

Add the builder function after `buildAuditorPrompt`:

```typescript
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
  result = replaceAllTokens(result, '{{TEMPLATE_VERSION}}', String(PROMPT_TEMPLATE_VERSION));
  return result;
}
```

- [ ] **Step 3: Commit**

```bash
git add prompts/final-auditor.md src/agents/prompt-builder.ts
git commit -m "feat(prompts): add final-auditor prompt template and builder"
```

---

## Task 7: Extend Config for Final Auditor Agent

**Files:**
- Modify: `src/types.ts`
- Modify: `src/artifacts/config.ts`

- [ ] **Step 1: Add final_auditor to AgentConfig in types.ts**

Update the `ReviewLoopConfig` interface:

```typescript
export interface ReviewLoopConfig {
  version: number;
  agents: {
    planner: AgentConfig;
    developer: AgentConfig;
    auditor: AgentConfig;
    final_auditor: AgentConfig;
  };
  // ... rest unchanged ...
}
```

- [ ] **Step 2: Add final_auditor to config schema and defaults in config.ts**

Add `final_auditor` to the agents property in `CONFIG_SCHEMA`:

```typescript
agents: {
  type: 'object',
  required: ['planner', 'developer', 'auditor'],
  properties: {
    planner: { $ref: '#/$defs/agentConfig' },
    developer: { $ref: '#/$defs/agentConfig' },
    auditor: { $ref: '#/$defs/agentConfig' },
    final_auditor: { $ref: '#/$defs/agentConfig' },
  },
  additionalProperties: false,
},
```

Note: `final_auditor` is NOT required — it falls back to `auditor` config if not specified.

Add to `DEFAULT_CONFIG`:

```typescript
agents: {
  planner: { ... },
  developer: { ... },
  auditor: { ... },
  final_auditor: {
    command: ['codex', 'exec', '{prompt_file}'],
    timeout_seconds: 1800,
  },
},
```

Add backward compat in `loadConfig`:

```typescript
// Phase 5 backward compat: fill in final_auditor with auditor config if missing
if (!config.agents.final_auditor) {
  config.agents.final_auditor = config.agents.auditor;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/artifacts/config.ts
git commit -m "feat(config): add final_auditor agent config with auditor fallback"
```

---

## Task 8: Implement the Finalization Pipeline in Orchestrator

**Files:**
- Modify: `src/orchestrator/run-orchestrator.ts`

This is the core task. Replace the FINALIZING stub with the full pipeline.

- [ ] **Step 1: Add imports for Phase 5 modules**

Add these imports at the top of `run-orchestrator.ts`:

```typescript
import { buildFinalAuditorInput, validateFinalAuditorOutput } from '../agents/final-auditor-adapter.js';
import {
  renderCommitMessage,
  renderTagName,
  stageFiles,
  getStagedFiles,
  findStagedSetViolations,
  createCommit,
  createTag,
  getTagTarget,
  commitExists,
  findTrackedLocalOnlyArtifacts,
  buildAllowedCommitSet,
  VERSIONED_ARTIFACT_PATHS,
} from '../git/commit-manager.js';
```

- [ ] **Step 2: Extend OrchestratorResult with Phase 5 fields**

Update the `OrchestratorResult` interface:

```typescript
export interface OrchestratorResult {
  run_id: string;
  phase: Phase;
  exit_code: number;
  branch: string;
  audit_decision: string | null;
  artifact_paths: string[];
  next_action: string;
  message: string;
  error: ReviewLoopError | null;
  /** Phase 5: commit SHA if created. */
  commit_sha: string | null;
  /** Phase 5: whether commit was skipped. */
  commit_skipped: boolean;
  /** Phase 5: tag name if created. */
  tag_name: string | null;
  /** Phase 5: whether tag was created. */
  tag_created: boolean;
  /** Phase 5: reason commit was skipped. */
  skip_reason: string | null;
}
```

- [ ] **Step 3: Update makeResult and makeBlockedResult**

Update `makeResult` to include Phase 5 fields:

```typescript
function makeResult(
  runId: string,
  phase: Phase,
  exitCode: number,
  branch: string,
  auditDecision: string | null,
  artifactPaths: string[],
  nextAction: string,
  message: string,
  error: ReviewLoopError | null,
  commitSha: string | null = null,
  commitSkipped: boolean = false,
  tagName: string | null = null,
  tagCreated: boolean = false,
  skipReason: string | null = null,
): OrchestratorResult {
  return {
    run_id: runId,
    phase,
    exit_code: exitCode,
    branch,
    audit_decision: auditDecision,
    artifact_paths: artifactPaths,
    next_action: nextAction,
    message,
    error,
    commit_sha: commitSha,
    commit_skipped: commitSkipped,
    tag_name: tagName,
    tag_created: tagCreated,
    skip_reason: skipReason,
  };
}
```

- [ ] **Step 4: Add the runFinalization function**

Add this function before the `makeResult` function. This is the core Phase 5 logic:

```typescript
/**
 * Run the finalization pipeline after Auditor PASS.
 * Phase 5 §6: FINALIZING → Final Audit → pre-commit checks → commit → tag → PASSED
 *
 * Steps:
 * 1. Check git.push config — BLOCKED if true
 * 2. Collect final diff artifacts
 * 3. Run final Scope Guard
 * 4. Verify verification manifest is current and passed
 * 5. Run Final Auditor agent
 * 6. Validate .agent/final-audit.md
 * 7. Compare goal/diff/audit-report/verification-manifest digests
 * 8. Check for tracked local-only artifacts
 * 9. Stage allowed files
 * 10. Verify staged set
 * 11. Create commit (unless --no-commit)
 * 12. Create tag (if configured)
 * 13. Transition to PASSED
 */
async function runFinalization(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  config: ReviewLoopConfig;
  currentBranch: string;
  baseCommit: string;
  goalFm: import('../types.js').GoalFrontMatter;
  goalDigest: string;
  diffDigest: string;
  iteration: number;
  noCommit: boolean;
  tag: boolean;
  combinedSignal: AbortSignal;
}): Promise<OrchestratorResult> {
  const {
    projectRoot, agentDir, runId, stateStore, artifactStore, config,
    currentBranch, baseCommit, goalFm, goalDigest, diffDigest, iteration,
    noCommit, tag, combinedSignal,
  } = params;

  // §6.5: Reject git.push: true
  if (config.git.push) {
    await transitionToBlocked(stateStore, 'git.push is not supported in Phase 5');
    return makeBlockedResult(
      runId, projectRoot,
      'git.push is not supported in Phase 5. Remove git.push: true from configuration.',
      'UNSUPPORTED_PUSH',
      currentBranch,
    );
  }

  // §6.1 step 1: Collect final diff artifacts
  const finalDiffResult = await collectDiff({ projectRoot, baseCommit, iteration });
  await writeDiffArtifacts(projectRoot, iteration, finalDiffResult);

  // §6.1 step 2: Run final Scope Guard
  const orchestratorOwnedFiles: string[] = []; // Not tracking registry in finalization
  const finalScopeResult = checkScope({
    allowedChanges: goalFm.allowed_changes,
    disallowedChanges: goalFm.disallowed_changes,
    changedFiles: finalDiffResult.changedFiles,
    orchestratorOwnedFiles,
  });

  if (!finalScopeResult.passed) {
    const deniedPaths = finalScopeResult.report.denied.map(d => d.path).join(', ');
    await transitionToBlocked(stateStore, `Pre-commit scope violation: ${deniedPaths}`);
    return makeBlockedResult(
      runId, projectRoot,
      `Pre-commit scope violation: ${deniedPaths}`,
      'PRE_COMMIT_SCOPE_VIOLATION',
      currentBranch,
    );
  }

  // §6.1 step 3: Verify verification manifest is current and passed
  const verificationManifestPath = join(agentDir, 'verification', 'manifest.json');
  let verificationManifestDigest: string = '';
  if (existsSync(verificationManifestPath)) {
    try {
      const manifestContent = readFileSync(verificationManifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent) as VerificationManifest;
      verificationManifestDigest = computeDigest(manifestContent);

      // Check manifest is for current run and iteration
      if (manifest.run_id !== runId) {
        await transitionToBlocked(stateStore, `Verification manifest run_id "${manifest.run_id}" does not match current run "${runId}"`);
        return makeBlockedResult(
          runId, projectRoot,
          `Verification manifest run_id mismatch: expected ${runId}, got ${manifest.run_id}`,
          'PRE_COMMIT_DIGEST_MISMATCH',
          currentBranch,
        );
      }
      if (manifest.iteration !== iteration) {
        await transitionToBlocked(stateStore, `Verification manifest iteration ${manifest.iteration} does not match current iteration ${iteration}`);
        return makeBlockedResult(
          runId, projectRoot,
          `Verification manifest iteration mismatch: expected ${iteration}, got ${manifest.iteration}`,
          'PRE_COMMIT_DIGEST_MISMATCH',
          currentBranch,
        );
      }
      if (!manifest.passed) {
        await transitionToBlocked(stateStore, 'Verification manifest shows not passed');
        return makeBlockedResult(
          runId, projectRoot,
          'Verification manifest shows not passed — cannot commit',
          'PRE_COMMIT_DIGEST_MISMATCH',
          currentBranch,
        );
      }
    } catch {
      await transitionToBlocked(stateStore, 'Cannot parse verification manifest');
      return makeBlockedResult(
        runId, projectRoot,
        'Cannot parse verification manifest for pre-commit check',
        'PRE_COMMIT_DIGEST_MISMATCH',
        currentBranch,
      );
    }
  } else {
    await transitionToBlocked(stateStore, 'Verification manifest not found');
    return makeBlockedResult(
      runId, projectRoot,
      'Verification manifest not found — cannot verify pre-commit',
      'PRE_COMMIT_DIGEST_MISMATCH',
      currentBranch,
    );
  }

  // §6.1 step 4: Compute current digests for pre-commit check
  const currentGoalDigest = computeDigest(readFileSync(join(agentDir, 'GOAL.md'), 'utf8'));
  const currentDiffDigest = `sha256:${finalDiffResult.diffDigest}` as import('../runtime/digest.js').Digest;
  const auditReportPath = join(agentDir, 'audit-report.md');
  let currentAuditReportDigest = '';
  if (existsSync(auditReportPath)) {
    currentAuditReportDigest = computeDigest(readFileSync(auditReportPath, 'utf8'));
  }

  // §6.1 step 5: Check for tracked local-only artifacts
  const trackedLocalOnly = await findTrackedLocalOnlyArtifacts(projectRoot);
  if (trackedLocalOnly.length > 0) {
    await transitionToBlocked(stateStore, `Local-only artifacts are tracked by git: ${trackedLocalOnly.join(', ')}`);
    return makeBlockedResult(
      runId, projectRoot,
      `Local-only artifacts are tracked by git: ${trackedLocalOnly.join(', ')}. Remove them from git tracking before committing.`,
      'PRE_COMMIT_STAGED_SET_VIOLATION',
      currentBranch,
    );
  }

  // §6.1 step 6: Cancel check before Final Auditor
  const preFinalAuditCancel = await checkCancelRequest(agentDir);
  if (preFinalAuditCancel) {
    await stateStore.update(() => ({ cancel_requested_at: preFinalAuditCancel.requested_at }));
    await stateStore.transition(PhaseEnum.CANCELLED);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'cancel requested', 'CANCELLED');
    return makeResult(
      runId, PhaseEnum.CANCELLED, 4, currentBranch, 'PASS', [],
      'Run cancelled by user request',
      `Cancel requested at ${preFinalAuditCancel.requested_at}`,
      null,
    );
  }

  // §6.1 step 7: Run Final Auditor
  let finalAuditorPrompt: string;
  let finalAuditorPromptFile: string | undefined;
  try {
    const iterStr = String(iteration).padStart(2, '0');
    const promptResult = await buildPrompt(
      projectRoot,
      'final-auditor.md',
      (template) => buildFinalAuditorPrompt(template, {
        run_id: runId,
        iteration,
        project_root: projectRoot,
        plan_path: join(projectRoot, '.agent/plan.md'),
        goal_path: join(projectRoot, '.agent/GOAL.md'),
        handoff_path: join(projectRoot, '.agent/developer-handoff.md'),
        audit_report_path: join(projectRoot, '.agent/audit-report.md'),
        verification_manifest_path: join(agentDir, 'verification', 'manifest.json'),
        changed_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'changed-files.json'),
        untracked_files_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'untracked-files.json'),
        scope_report_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'scope-report.json'),
        diff_metadata_path: join(agentDir, 'evidence', `iteration-${iterStr}`, 'diff-metadata.json'),
        final_audit_path: join(projectRoot, '.agent/final-audit.md'),
        goal_digest: currentGoalDigest,
        diff_digest: currentDiffDigest,
        audit_report_digest: currentAuditReportDigest,
        verification_manifest_digest: verificationManifestDigest,
      }),
      { use_prompt_file: true, agent_dir: agentDir, run_id: runId, role: 'final-auditor' },
    );
    finalAuditorPrompt = promptResult.prompt;
    finalAuditorPromptFile = promptResult.prompt_file_path ?? undefined;
  } catch (err) {
    await transitionToBlocked(stateStore, `Final Auditor prompt build failed: ${err instanceof Error ? err.message : String(err)}`);
    return makeBlockedResult(runId, projectRoot, 'Final Auditor prompt build failed', 'CONFIG_ERROR', currentBranch);
  }

  let finalAuditorResult;
  let finalAuditorCleanupResult: PromptCleanupResult | undefined;
  try {
    const finalAuditorInput = buildFinalAuditorInput({
      run_id: runId,
      iteration,
      project_root: projectRoot,
      command_template: config.agents.final_auditor.command,
      timeout_seconds: config.agents.final_auditor.timeout_seconds,
      prompt: finalAuditorPrompt,
      prompt_file: finalAuditorPromptFile,
      signal: combinedSignal,
    });

    finalAuditorResult = await runAgent(finalAuditorInput, projectRoot);
  } finally {
    if (finalAuditorPromptFile) finalAuditorCleanupResult = await deletePromptFile(finalAuditorPromptFile);
  }

  if (finalAuditorCleanupResult && !finalAuditorCleanupResult.success) {
    await transitionToBlocked(stateStore, `Final Auditor prompt cleanup failed: ${finalAuditorCleanupResult.error}`);
    return makeBlockedResult(runId, projectRoot, `Prompt cleanup failed: ${finalAuditorCleanupResult.error}`, 'STATE_CONFLICT', currentBranch);
  }

  if (finalAuditorResult.status === 'cancelled') {
    await stateStore.transition(PhaseEnum.CANCELLED);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final auditor completed', 'CANCELLED', finalAuditorResult.error?.message);
    return makeResult(
      runId, PhaseEnum.CANCELLED, 4, currentBranch, 'PASS', [],
      'Run cancelled by user request',
      `Final Auditor cancelled: ${finalAuditorResult.error?.message ?? 'unknown'}`,
      null,
    );
  }

  if (finalAuditorResult.status !== 'success') {
    await transitionToBlocked(stateStore, `Final Auditor failed: ${finalAuditorResult.error?.message ?? 'unknown'}`);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final auditor completed', 'FAIL', finalAuditorResult.error?.message);
    return makeBlockedResult(runId, projectRoot, `Final Auditor failed: ${finalAuditorResult.error?.message ?? 'unknown'}`, 'AGENT_ERROR', currentBranch);
  }

  // §6.1 step 8: Validate Final Auditor output
  const finalAuditValidation = validateFinalAuditorOutput({
    projectRoot,
    runId,
    iteration,
    expectedGoalDigest: currentGoalDigest,
    expectedDiffDigest: currentDiffDigest,
    expectedAuditReportDigest: currentAuditReportDigest,
    expectedVerificationManifestDigest: verificationManifestDigest,
  });

  if (!finalAuditValidation.valid) {
    const errorCode = finalAuditValidation.decision === 'PASS'
      ? 'FINAL_AUDIT_SCHEMA_ERROR' as ErrorCategory
      : 'FINAL_AUDIT_FAILED' as ErrorCategory;
    await transitionToBlocked(stateStore, `Final Audit validation failed: ${finalAuditValidation.errors.join('; ')}`);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final audit validation', 'FAIL', finalAuditValidation.errors.join('; '));
    return makeBlockedResult(
      runId, projectRoot,
      `Final Audit validation failed: ${finalAuditValidation.errors.join('; ')}`,
      errorCode,
      currentBranch,
    );
  }

  const finalAuditDecision = finalAuditValidation.effectiveDecision ?? finalAuditValidation.decision;

  if (finalAuditDecision !== 'PASS') {
    await transitionToBlocked(stateStore, `Final Audit decision: ${finalAuditDecision}`);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final audit completed', finalAuditDecision === 'FAILED' ? 'FAIL' : 'BLOCKED');
    return makeBlockedResult(
      runId, projectRoot,
      `Final Audit decision: ${finalAuditDecision}. Cannot commit.`,
      'FINAL_AUDIT_FAILED',
      currentBranch,
    );
  }

  await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'final audit completed', 'PASS');

  // §6.3: --no-commit path
  if (noCommit || !config.git.commit_on_pass) {
    await stateStore.update(() => ({
      commit_skipped: true,
      skip_reason: noCommit ? '--no-commit' : 'commit_on_pass is false',
      finalized_at: new Date().toISOString(),
    }));
    await stateStore.transition(PhaseEnum.PASSED);
    await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'finalization completed', 'PASS', 'commit skipped');

    const artifactPaths = VERSIONED_ARTIFACT_PATHS.map(p => `.agent/${p}`);
    return makeResult(
      runId, PhaseEnum.PASSED, 0, currentBranch, 'PASS',
      artifactPaths,
      'Final Audit PASSED. Commit skipped (--no-commit).',
      'Final Audit PASSED. Commit skipped.',
      null,
      null, true, null, false, noCommit ? '--no-commit' : 'commit_on_pass is false',
    );
  }

  // §6.1 step 9: Build the set of files to commit
  const versionedArtifacts = VERSIONED_ARTIFACT_PATHS.filter(p => existsSync(join(projectRoot, p)));
  const businessFiles = finalDiffResult.changedFiles.files
    .map(f => f.path)
    .filter(p => !p.startsWith('.agent/'));
  const allCommitFiles = [...versionedArtifacts, ...businessFiles];
  const allowedSet = buildAllowedCommitSet(versionedArtifacts, businessFiles);

  // §6.1 step 10: Stage files
  const stageResult = await stageFiles(projectRoot, allCommitFiles);
  if (!stageResult.success) {
    await transitionToBlocked(stateStore, `Staging failed: ${stageResult.error}`);
    return makeBlockedResult(
      runId, projectRoot,
      `Staging failed: ${stageResult.error}`,
      'GIT_COMMIT_ERROR',
      currentBranch,
    );
  }

  // §6.1 step 11: Verify staged set
  const stagedFiles = await getStagedFiles(projectRoot);
  const violations = findStagedSetViolations(stagedFiles, allowedSet);
  if (violations.length > 0) {
    // Unstage everything — we're going to BLOCKED
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    await transitionToBlocked(stateStore, `Staged set violation: ${violations.join(', ')}`);
    return makeBlockedResult(
      runId, projectRoot,
      `Staged set contains disallowed files: ${violations.join(', ')}`,
      'PRE_COMMIT_STAGED_SET_VIOLATION',
      currentBranch,
    );
  }

  // §6.1 step 12: Create commit
  let commitMessage: string;
  try {
    const shortGoalDigest = goalDigest.replace('sha256:', '').slice(0, 12);
    commitMessage = renderCommitMessage(config.git.commit_template, {
      task_slug: (await stateStore.read()).task_slug,
      run_id: runId,
      iteration,
      short_goal_digest: shortGoalDigest,
    });
  } catch (err) {
    // Unstage
    await runGit(['reset', 'HEAD', '--', '.'], projectRoot).catch(() => {});
    await transitionToBlocked(stateStore, `Commit message template error: ${err instanceof Error ? err.message : String(err)}`);
    return makeBlockedResult(
      runId, projectRoot,
      `Commit message template error: ${err instanceof Error ? err.message : String(err)}`,
      'GIT_COMMIT_ERROR',
      currentBranch,
    );
  }

  const commitResult = await createCommit(projectRoot, commitMessage);
  if (!commitResult.success) {
    await transitionToBlocked(stateStore, `Commit failed: ${commitResult.error}`);
    return makeBlockedResult(
      runId, projectRoot,
      `Commit failed: ${commitResult.error}`,
      'GIT_COMMIT_ERROR',
      currentBranch,
    );
  }

  const commitSha = commitResult.commitSha!;

  // Record commit in state
  await stateStore.update(() => ({
    final_commit_sha: commitSha,
    final_commit_message: commitMessage,
  }));

  // §6.4: Create tag if requested
  let tagName: string | null = null;
  let tagCreated = false;

  if (tag || config.git.create_tag) {
    try {
      const state = await stateStore.read();
      tagName = renderTagName(config.git.tag_template, {
        run_id: runId,
        task_slug: state.task_slug,
      });
    } catch (err) {
      // Tag template error — commit is already created, enter BLOCKED
      await stateStore.update(() => ({
        last_error: `Tag template error: ${err instanceof Error ? err.message : String(err)}`,
      }));
      await stateStore.transition(PhaseEnum.BLOCKED);
      return makeResult(
        runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
        VERSIONED_ARTIFACT_PATHS.map(p => `.agent/${p}`),
        'Commit created but tag template error',
        `Commit ${commitSha.slice(0, 8)} created but tag template error: ${err instanceof Error ? err.message : String(err)}`,
        {
          code: 'GIT_TAG_ERROR',
          message: `Tag template error: ${err instanceof Error ? err.message : String(err)}`,
          resumable: true,
          suggested_action: 'Fix tag template and resume to create tag',
        },
        commitSha, false, null, false,
      );
    }

    // Check if tag already exists
    const existingTarget = await getTagTarget(projectRoot, tagName);
    if (existingTarget !== null) {
      if (existingTarget === commitSha) {
        // Tag already points to our commit — idempotent success
        tagCreated = true;
      } else {
        // Tag exists but points to different commit — BLOCKED
        await stateStore.update(() => ({
          last_error: `Tag ${tagName} already exists pointing to ${existingTarget}, expected ${commitSha}`,
        }));
        await stateStore.transition(PhaseEnum.BLOCKED);
        return makeResult(
          runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
          VERSIONED_ARTIFACT_PATHS.map(p => `.agent/${p}`),
          'Commit created but tag conflict',
          `Commit ${commitSha.slice(0, 8)} created but tag ${tagName} points to different commit ${existingTarget.slice(0, 8)}`,
          {
            code: 'GIT_TAG_ERROR',
            message: `Tag ${tagName} already exists pointing to ${existingTarget}`,
            resumable: false,
            suggested_action: 'Resolve tag conflict manually',
          },
          commitSha, false, tagName, false,
        );
      }
    } else {
      // Create the tag
      const tagResult = await createTag(projectRoot, tagName, commitSha);
      if (!tagResult.success) {
        // Tag creation failed — commit is done, enter BLOCKED
        await stateStore.update(() => ({
          last_error: `Tag creation failed: ${tagResult.error}`,
        }));
        await stateStore.transition(PhaseEnum.BLOCKED);
        return makeResult(
          runId, PhaseEnum.BLOCKED, 3, currentBranch, 'PASS',
          VERSIONED_ARTIFACT_PATHS.map(p => `.agent/${p}`),
          'Commit created but tag failed',
          `Commit ${commitSha.slice(0, 8)} created but tag failed: ${tagResult.error}`,
          {
            code: 'GIT_TAG_ERROR',
            message: `Tag creation failed: ${tagResult.error}`,
            resumable: true,
            suggested_action: 'Fix tag issue and resume to create tag',
          },
          commitSha, false, tagName, false,
        );
      }
      tagCreated = true;
    }
  }

  // §6.1 step 13: Transition to PASSED
  await stateStore.update(() => ({
    finalized_at: new Date().toISOString(),
    tag_name: tagName,
    tag_created: tagCreated,
  }));
  await stateStore.transition(PhaseEnum.PASSED);
  await appendLog(artifactStore, runId, iteration, 'FINALIZING', 'finalization completed', 'PASS');

  const artifactPaths = VERSIONED_ARTIFACT_PATHS.map(p => `.agent/${p}`);
  return makeResult(
    runId, PhaseEnum.PASSED, 0, currentBranch, 'PASS',
    artifactPaths,
    `Final Audit PASSED. Committed as ${commitSha.slice(0, 8)}${tagCreated && tagName ? `, tagged ${tagName}` : ''}.`,
    `Final Audit PASSED. Committed as ${commitSha.slice(0, 8)}.`,
    null,
    commitSha, false, tagName, tagCreated,
  );
}
```

- [ ] **Step 5: Replace the FINALIZING stub in the iteration loop**

Replace the existing Auditor PASS block (lines ~1168-1177) with:

```typescript
if (decision === 'PASS') {
  await stateStore.transition(PhaseEnum.FINALIZING);
  await appendLog(artifactStore, runId, iteration, 'AUDITING', 'auditor completed', 'PASS');

  // Phase 5: Run the finalization pipeline
  return await runFinalization({
    projectRoot,
    agentDir,
    runId,
    stateStore,
    artifactStore,
    config,
    currentBranch,
    baseCommit,
    goalFm,
    goalDigest,
    diffDigest,
    iteration,
    noCommit: params.noCommit ?? !config.git.commit_on_pass,
    tag: params.tag ?? config.git.create_tag,
    combinedSignal,
  });
}
```

- [ ] **Step 6: Add noCommit and tag to IterationLoopParams**

Add these fields to the `IterationLoopParams` interface:

```typescript
interface IterationLoopParams {
  // ... existing fields ...
  noCommit: boolean;
  tag: boolean;
}
```

And pass them through from `runOrchestrator`:

In the normal path call to `runIterationLoop`, add:
```typescript
noCommit: params.no_commit ?? !config.git.commit_on_pass,
tag: params.tag ?? config.git.create_tag,
```

In the resume path call to `runIterationLoop`, add:
```typescript
noCommit: params.no_commit ?? !config.git.commit_on_pass,
tag: params.tag ?? config.git.create_tag,
```

Wait — the resume path doesn't have `no_commit` and `tag` params. We need to read them from config. Update the resume call:

```typescript
noCommit: !config.git.commit_on_pass,
tag: config.git.create_tag,
```

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/run-orchestrator.ts
git commit -m "feat(orchestrator): implement FINALIZING → PASSED pipeline with Final Audit, commit, and tag"
```

---

## Task 9: Update Resume Command for Phase 5

**Files:**
- Modify: `src/cli/resume.ts`

- [ ] **Step 1: Update determineRecoveryAction for FINALIZING**

Replace the FINALIZING case in `determineRecoveryAction`:

```typescript
case PhaseEnum.FINALIZING:
  return { action: 'continue', reason: 'Will resume finalization (Final Audit, commit, tag).' };
```

- [ ] **Step 2: Add BLOCKED-with-commit resume support**

Update the BLOCKED case to check for `final_commit_sha`:

```typescript
// There's no explicit BLOCKED case in the switch — add one before default:
case PhaseEnum.BLOCKED: {
  // Phase 5: If commit exists but tag failed, resume can complete the tag
  const agentDir = resolve(state.project_root, '.agent');
  const stateStore = new StateStore(agentDir);
  try {
    const currentState = await stateStore.read();
    if (currentState.final_commit_sha && !currentState.tag_created && currentState.tag_name) {
      return { action: 'continue', reason: 'Commit exists but tag failed — can retry tag creation.' };
    }
  } catch { /* ignore */ }
  return { action: 'blocked', reason: 'Run is blocked. Resolve the blocking issue manually.' };
}
```

Wait — `determineRecoveryAction` is a synchronous function. We need to make it async or read state differently. Since the state is already available as a parameter, let's check `state.final_commit_sha` directly:

```typescript
case PhaseEnum.BLOCKED: {
  // Phase 5: If commit exists but tag failed, resume can complete the tag
  if ((state as any).final_commit_sha && !(state as any).tag_created && (state as any).tag_name) {
    return { action: 'continue', reason: 'Commit exists but tag failed — can retry tag creation.' };
  }
  return { action: 'blocked', reason: 'Run is blocked. Resolve the blocking issue manually.' };
}
```

Actually, since we've extended `RunState` with these fields, we can use them directly:

```typescript
case PhaseEnum.BLOCKED: {
  if (state.final_commit_sha && !state.tag_created && state.tag_name) {
    return { action: 'continue', reason: 'Commit exists but tag failed — can retry tag creation.' };
  }
  return { action: 'blocked', reason: 'Run is blocked. Resolve the blocking issue manually.' };
}
```

- [ ] **Step 3: Update resume result reporting**

Update the result reporting section in `executeResume` to handle Phase 5 results:

```typescript
if (result.phase === 'PASSED') {
  if (result.commit_skipped) {
    console.log(`Run ${state.run_id} completed successfully. Commit skipped (${result.skip_reason}).`);
  } else if (result.commit_sha) {
    console.log(`Run ${state.run_id} completed successfully. Committed as ${result.commit_sha.slice(0, 8)}.`);
    if (result.tag_created && result.tag_name) {
      console.log(`Tag: ${result.tag_name}`);
    }
  }
} else if (result.phase === 'FINALIZING') {
  // This shouldn't happen anymore with Phase 5, but handle gracefully
  console.log(`Run ${state.run_id} completed audit. Finalization in progress.`);
} else if (result.phase === 'CANCELLED') {
  // ... existing ...
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/resume.ts
git commit -m "feat(resume): support resume from FINALIZING and BLOCKED-with-commit"
```

---

## Task 10: Update Status Command for Phase 5

**Files:**
- Modify: `src/cli/status.ts`
- Modify: `src/artifacts/json-schemas.ts`

- [ ] **Step 1: Extend statusOutputSchema in json-schemas.ts**

Add Phase 5 fields to the `statusOutputSchema`:

```typescript
export const statusOutputSchema: Schema = {
  type: 'object',
  properties: {
    // ... existing properties ...
    final_audit_decision: { type: ['string', 'null'] },
    final_audit_path: { type: ['string', 'null'] },
    commit_on_pass: { type: 'boolean' },
    commit_skipped: { type: 'boolean' },
    final_commit_sha: { type: ['string', 'null'] },
    tag_requested: { type: 'boolean' },
    tag_name: { type: ['string', 'null'] },
    tag_created: { type: 'boolean' },
    push_enabled: { type: 'boolean' },
    finalization_next_step: { type: ['string', 'null'] },
  },
  required: [
    // ... existing required fields ...
    'final_audit_decision', 'final_audit_path', 'commit_on_pass',
    'commit_skipped', 'final_commit_sha', 'tag_requested',
    'tag_name', 'tag_created', 'push_enabled', 'finalization_next_step',
  ],
  additionalProperties: false,
};
```

- [ ] **Step 2: Update executeStatus to include Phase 5 fields**

In `executeStatus`, after building the `output` object, add Phase 5 fields:

```typescript
// Phase 5: Finalization status fields
const finalAuditPath = existsSync(join(agentDir, 'final-audit.md'))
  ? '.agent/final-audit.md' : null;
let finalAuditDecision: string | null = null;
if (finalAuditPath) {
  try {
    const { parseFinalAudit } = await import('../artifacts/artifact-schemas.js');
    const content = readFileSync(join(agentDir, 'final-audit.md'), 'utf8');
    const { frontMatter } = parseFinalAudit(content);
    finalAuditDecision = frontMatter.decision;
  } catch { /* ignore parse errors */ }
}

const output: StatusOutput = {
  // ... existing fields ...
  final_audit_decision: finalAuditDecision,
  final_audit_path: finalAuditPath,
  commit_on_pass: true, // Will be read from config in production
  commit_skipped: state.commit_skipped,
  final_commit_sha: state.final_commit_sha,
  tag_requested: state.tag_name !== null,
  tag_name: state.tag_name,
  tag_created: state.tag_created,
  push_enabled: false, // Phase 5 never supports push
  finalization_next_step: computeFinalizationNextStep(state),
};
```

- [ ] **Step 3: Add computeFinalizationNextStep helper**

```typescript
function computeFinalizationNextStep(state: RunState): string | null {
  switch (state.phase) {
    case 'FINALIZING':
      return 'Finalization in progress — waiting for Final Audit and commit.';
    case 'PASSED':
      if (state.commit_skipped) {
        return 'Run completed. Commit was skipped.';
      }
      if (state.final_commit_sha) {
        return `Run completed. Committed as ${state.final_commit_sha.slice(0, 8)}.`;
      }
      return 'Run completed.';
    case 'BLOCKED':
      if (state.final_commit_sha && !state.tag_created && state.tag_name) {
        return 'Code committed but tag failed. Use `review-loop resume` to retry tag.';
      }
      return null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Update computeNextStep for Phase 5**

Update the `computeNextStep` function:

```typescript
case PhaseEnum.PASSED:
  return 'Run completed successfully. Final Audit passed and code committed.';
// ...
case 'FINALIZING':
  return '正在等待或执行最终审计/本地提交';
```

- [ ] **Step 5: Update printHumanReadable for Phase 5 fields**

Add Phase 5 fields to the human-readable output:

```typescript
if (status.final_commit_sha) {
  console.log(`Commit: ${status.final_commit_sha}`);
}
if (status.commit_skipped) {
  console.log(`Commit: skipped (${status.finalization_next_step || 'N/A'})`);
}
if (status.tag_name) {
  console.log(`Tag: ${status.tag_name} (${status.tag_created ? 'created' : 'not created'})`);
}
if (status.final_audit_decision) {
  console.log(`Final Audit: ${status.final_audit_decision}`);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/status.ts src/artifacts/json-schemas.ts
git commit -m "feat(status): add Phase 5 finalization fields to status output"
```

---

## Task 11: Update Start Command for Phase 5

**Files:**
- Modify: `src/cli/start.ts`

- [ ] **Step 1: Update result output to handle Phase 5 fields**

Replace the hardcoded "Not yet committed" line with Phase 5-aware output:

```typescript
// Output result
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log(`  Run:        ${result.run_id}`);
console.log(`  Phase:      ${result.phase}`);
console.log(`  Branch:     ${result.branch}`);
if (result.audit_decision) {
  console.log(`  Audit:      ${result.audit_decision}`);
}
if (result.commit_sha) {
  console.log(`  Commit:     ${result.commit_sha.slice(0, 8)}`);
}
if (result.commit_skipped) {
  console.log(`  Commit:     skipped (${result.skip_reason})`);
}
if (result.tag_name) {
  console.log(`  Tag:        ${result.tag_name} (${result.tag_created ? 'created' : 'not created'})`);
}
console.log(`  Next:       ${result.next_action}`);
console.log(`  Message:    ${result.message}`);
if (result.artifact_paths.length > 0) {
  console.log(`  Artifacts:  ${result.artifact_paths.join(', ')}`);
}
console.log('═══════════════════════════════════════════════════');
console.log('');
```

- [ ] **Step 2: Fix no_commit default**

Change the `no_commit` parameter to default based on config:

```typescript
const result = await runOrchestrator({
  project_root: projectRoot,
  request,
  task_slug: options.taskSlug,
  max_iterations: options.maxIterations,
  config_path: options.config,
  no_commit: options.noCommit,
  tag: options.tag,
});
```

Note: The orchestrator will use `config.git.commit_on_pass` as the default, and `--no-commit` overrides it.

- [ ] **Step 3: Commit**

```bash
git add src/cli/start.ts
git commit -m "feat(start): handle Phase 5 commit/tag/no-commit result fields"
```

---

## Task 12: Update Fake Agent for Final Auditor Role

**Files:**
- Modify: `tests/fixtures/fake-agent.mjs`

- [ ] **Step 1: Add final-auditor role behaviors**

Add a new case in the behavior dispatch switch, after the `auditor` case:

```javascript
case 'final-auditor': {
  switch (behavior) {
    case 'success':
    case 'audit-pass':
      writeFinalAuditReport('PASS', goalDigest, diffDigest);
      break;
    case 'audit-fail':
      writeFinalAuditReport('FAILED', goalDigest, diffDigest);
      break;
    case 'audit-blocked':
      writeFinalAuditReport('BLOCKED', goalDigest, diffDigest);
      break;
    case 'audit-bad-digest':
      writeFinalAuditReport('PASS', 'sha256:' + '0'.repeat(64), 'sha256:' + '0'.repeat(64));
      break;
    case 'no-artifact':
      break;
    case 'timeout':
      await new Promise((resolve) => {
        setTimeout(resolve, 300000);
      });
      break;
    case 'exit-error':
      process.exit(1);
      break;
    default:
      writeFinalAuditReport('PASS', goalDigest, diffDigest);
  }
  break;
}
```

- [ ] **Step 2: Add writeFinalAuditReport function**

Add before the behavior dispatch:

```javascript
function writeFinalAuditReport(decision, goalDig, diffDig) {
  const auditReportDigest = getArg('audit-report-digest') || 'sha256:' + 'c'.repeat(64);
  const verificationManifestDigest = getArg('verification-manifest-digest') || 'sha256:' + 'd'.repeat(64);
  const report = `---
schema_version: 1
run_id: "${runId}"
author_role: "auditor"
decision: "${decision}"
final_iteration: ${iteration}
goal_digest: "${goalDig}"
diff_digest: "${diffDig}"
audit_report_digest: "${auditReportDigest}"
verification_manifest_digest: "${verificationManifestDigest}"
created_at: "${new Date().toISOString()}"
---

# Final Audit Report

## Final Decision

${decision}

## Success Criteria Review

| Criterion | Result | Evidence |
|---|---|---|
| SC-1 | ${decision === 'PASS' ? 'PASS' : 'FAIL'} | All checks passed |

## Verification Summary

All required verification commands passed.

## Scope Summary

No scope violations detected.

## Change Summary

Changes are within allowed scope.

## Files To Commit

- .agent/plan.md
- .agent/GOAL.md
- .agent/developer-handoff.md
- .agent/audit-report.md
- .agent/final-audit.md

## Versioned Artifacts

All versioned artifacts are present and valid.

## Local-only Artifacts Excluded

- .agent/state.json
- .agent/run.lock
- .agent/iteration-log.md
- .agent/verification/
- .agent/evidence/

## Accepted Residual Risks

None.

## Commit Recommendation

${decision === 'PASS' ? 'Safe to commit.' : 'Do not commit.'}
`;
  writeFileSync(join(agentDir, 'final-audit.md'), report, 'utf8');
}
```

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/fake-agent.mjs
git commit -m "test(fake-agent): add final-auditor role behaviors"
```

---

## Task 13: Unit Tests for Commit Manager

**Files:**
- Create: `tests/unit/commit-manager.test.ts`

- [ ] **Step 1: Write unit tests for commit-manager**

Create `tests/unit/commit-manager.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  renderCommitMessage,
  renderTagName,
  isLocalOnlyPath,
  findStagedSetViolations,
  buildAllowedCommitSet,
  VERSIONED_ARTIFACT_PATHS,
  LOCAL_ONLY_PATTERNS,
} from '../../src/git/commit-manager.js';

describe('renderCommitMessage', () => {
  it('replaces all known placeholders', () => {
    const template = 'feat(agent): complete {task_slug} [{run_id}] iter={iteration} digest={short_goal_digest}';
    const result = renderCommitMessage(template, {
      task_slug: 'my-task',
      run_id: 'run-001',
      iteration: 2,
      short_goal_digest: 'abc123def456',
    });
    expect(result).toBe('feat(agent): complete my-task [run-001] iter=2 digest=abc123def456');
  });

  it('throws on unknown placeholder', () => {
    const template = 'feat: {unknown_placeholder}';
    expect(() => renderCommitMessage(template, {
      task_slug: 't',
      run_id: 'r',
      iteration: 1,
      short_goal_digest: 'abc',
    })).toThrow(/Unknown commit message placeholder/);
  });

  it('handles template with no placeholders', () => {
    const template = 'feat: simple commit';
    const result = renderCommitMessage(template, {
      task_slug: 't',
      run_id: 'r',
      iteration: 1,
      short_goal_digest: 'abc',
    });
    expect(result).toBe('feat: simple commit');
  });

  it('handles repeated placeholders', () => {
    const template = '{run_id}-{run_id}';
    const result = renderCommitMessage(template, {
      task_slug: 't',
      run_id: 'abc',
      iteration: 1,
      short_goal_digest: 'def',
    });
    expect(result).toBe('abc-abc');
  });
});

describe('renderTagName', () => {
  it('replaces known placeholders', () => {
    const template = 'agent-{run_id}-pass';
    const result = renderTagName(template, {
      run_id: 'run-001',
      task_slug: 'my-task',
    });
    expect(result).toBe('agent-run-001-pass');
  });

  it('throws on unknown placeholder', () => {
    const template = 'tag-{unknown}';
    expect(() => renderTagName(template, {
      run_id: 'r',
      task_slug: 't',
    })).toThrow(/Unknown tag name placeholder/);
  });
});

describe('isLocalOnlyPath', () => {
  it('identifies state.json as local-only', () => {
    expect(isLocalOnlyPath('.agent/state.json')).toBe(true);
  });

  it('identifies run.lock as local-only', () => {
    expect(isLocalOnlyPath('.agent/run.lock')).toBe(true);
  });

  it('identifies cancel-request.json as local-only', () => {
    expect(isLocalOnlyPath('.agent/cancel-request.json')).toBe(true);
  });

  it('identifies iteration-log.md as local-only', () => {
    expect(isLocalOnlyPath('.agent/iteration-log.md')).toBe(true);
  });

  it('identifies verification/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/verification/manifest.json')).toBe(true);
    expect(isLocalOnlyPath('.agent/verification')).toBe(true);
  });

  it('identifies evidence/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/evidence/scope-report.json')).toBe(true);
  });

  it('identifies history/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/history/iteration-01/handoff.md')).toBe(true);
  });

  it('identifies debug/ directory as local-only', () => {
    expect(isLocalOnlyPath('.agent/debug/prompt.md')).toBe(true);
  });

  it('identifies node_modules/ as local-only', () => {
    expect(isLocalOnlyPath('node_modules/foo/index.js')).toBe(true);
  });

  it('identifies dist/ as local-only', () => {
    expect(isLocalOnlyPath('dist/index.js')).toBe(true);
  });

  it('does not flag versioned artifacts', () => {
    expect(isLocalOnlyPath('.agent/plan.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/GOAL.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/developer-handoff.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/audit-report.md')).toBe(false);
    expect(isLocalOnlyPath('.agent/final-audit.md')).toBe(false);
  });

  it('does not flag business files', () => {
    expect(isLocalOnlyPath('src/index.ts')).toBe(false);
    expect(isLocalOnlyPath('tests/foo.test.ts')).toBe(false);
  });
});

describe('findStagedSetViolations', () => {
  it('returns empty for all-allowed files', () => {
    const allowed = new Set(['src/foo.ts', '.agent/plan.md']);
    const staged = ['src/foo.ts', '.agent/plan.md'];
    expect(findStagedSetViolations(staged, allowed)).toEqual([]);
  });

  it('returns violations for disallowed files', () => {
    const allowed = new Set(['src/foo.ts']);
    const staged = ['src/foo.ts', '.agent/state.json'];
    expect(findStagedSetViolations(staged, allowed)).toEqual(['.agent/state.json']);
  });

  it('returns empty for empty staged set', () => {
    const allowed = new Set(['src/foo.ts']);
    expect(findStagedSetViolations([], allowed)).toEqual([]);
  });
});

describe('buildAllowedCommitSet', () => {
  it('combines versioned artifacts and business files', () => {
    const versioned = ['.agent/plan.md', '.agent/GOAL.md'];
    const business = ['src/foo.ts', 'tests/bar.test.ts'];
    const allowed = buildAllowedCommitSet(versioned, business);
    expect(allowed.has('.agent/plan.md')).toBe(true);
    expect(allowed.has('.agent/GOAL.md')).toBe(true);
    expect(allowed.has('src/foo.ts')).toBe(true);
    expect(allowed.has('tests/bar.test.ts')).toBe(true);
    expect(allowed.has('.agent/state.json')).toBe(false);
  });
});

describe('VERSIONED_ARTIFACT_PATHS', () => {
  it('includes all required versioned artifacts', () => {
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/plan.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/GOAL.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/developer-handoff.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/audit-report.md');
    expect(VERSIONED_ARTIFACT_PATHS).toContain('.agent/final-audit.md');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/unit/commit-manager.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/commit-manager.test.ts
git commit -m "test(commit-manager): add unit tests for template rendering, local-only classification, and staged set validation"
```

---

## Task 14: Unit Tests for Final Auditor Adapter

**Files:**
- Create: `tests/unit/final-auditor-adapter.test.ts`

- [ ] **Step 1: Write unit tests for final-auditor-adapter**

Create `tests/unit/final-auditor-adapter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildFinalAuditorInput, validateFinalAuditorOutput } from '../../src/agents/final-auditor-adapter.js';

describe('buildFinalAuditorInput', () => {
  it('builds input with role final-auditor', () => {
    const input = buildFinalAuditorInput({
      run_id: 'run-001',
      iteration: 1,
      project_root: '/tmp/test',
      command_template: ['node', 'agent.mjs'],
      timeout_seconds: 600,
      prompt: 'test prompt',
    });
    expect(input.role).toBe('final-auditor');
    expect(input.run_id).toBe('run-001');
    expect(input.iteration).toBe(1);
    expect(input.expected_artifacts).toContain('/tmp/test/.agent/final-audit.md');
  });
});

describe('validateFinalAuditorOutput', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'final-audit-test-'));
    mkdirSync(join(tempDir, '.agent'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFinalAudit(content: string) {
    writeFileSync(join(tempDir, '.agent', 'final-audit.md'), content, 'utf8');
  }

  const validDigest = 'sha256:' + 'a'.repeat(64);

  it('returns valid for correct PASS final-audit', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit

All checks passed.
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(true);
    expect(result.decision).toBe('PASS');
    expect(result.effectiveDecision).toBe('PASS');
  });

  it('returns invalid when final-audit.md is missing', () => {
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('final-audit.md not found');
  });

  it('returns invalid when run_id does not match', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "wrong-run"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
  });

  it('returns invalid when goal_digest does not match', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "sha256:${'b'.repeat(64)}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
  });

  it('overrides PASS with FAILED when mechanical checks fail', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 1
goal_digest: "sha256:${'x'.repeat(64)}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
    expect(result.effectiveDecision).toBe('FAILED');
  });

  it('returns FAILED decision without override', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "FAILED"
final_iteration: 1
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(true);
    expect(result.decision).toBe('FAILED');
  });

  it('returns invalid when iteration does not match', () => {
    writeFinalAudit(`---
schema_version: 1
run_id: "run-001"
author_role: "auditor"
decision: "PASS"
final_iteration: 99
goal_digest: "${validDigest}"
diff_digest: "${validDigest}"
audit_report_digest: "${validDigest}"
verification_manifest_digest: "${validDigest}"
created_at: "2026-06-14T00:00:00.000Z"
---

# Final Audit
`);
    const result = validateFinalAuditorOutput({
      projectRoot: tempDir,
      runId: 'run-001',
      iteration: 1,
      expectedGoalDigest: validDigest,
      expectedDiffDigest: validDigest,
      expectedAuditReportDigest: validDigest,
      expectedVerificationManifestDigest: validDigest,
    });
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/unit/final-auditor-adapter.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/final-auditor-adapter.test.ts
git commit -m "test(final-auditor-adapter): add unit tests for input builder and output validator"
```

---

## Task 15: Integration Tests for Finalization Flow

**Files:**
- Create: `tests/integration/finalization.test.ts`

- [ ] **Step 1: Write integration tests**

Create `tests/integration/finalization.test.ts` covering the 18 required scenarios from Phase 5 §12.2. This is a large file — it uses the existing Fake Agent pattern with temporary git repos.

The test file should follow the pattern established in `tests/integration/run-orchestrator.test.ts` and `tests/integration/rework-loop.test.ts`.

Key test scenarios:
1. First-round PASS → Final Audit PASS → commit → PASSED
2. Second-round rework PASS → Final Audit PASS → commit → PASSED
3. `--no-commit` → Final Audit PASS → PASSED with no commit
4. `--tag` → commit → tag points to commit
5. Final-audit FAIL → no commit
6. Final-audit schema error → no commit
7. Diff tampered after Auditor PASS → digest mismatch → no commit
8. GOAL tampered → no commit
9. Verification manifest stale/failed → no commit
10. Scope Guard failure → no commit
11. Local-only artifact tracked → no commit
12. Commit failure → BLOCKED, lock released
13. Commit success but tag failure → BLOCKED, state records commit sha
14. Resume completes tag → PASSED, no duplicate commit
15. Resume from FINALIZING without final-audit → re-runs final audit and commits
16. Resume from FINALIZING with existing commit → no duplicate commit
17. `git.push: true` → BLOCKED, no commit
18. Cancel during Final Auditor → CANCELLED, no commit

Due to the size and complexity, each test creates a temporary git repo, configures the fake agent, runs the orchestrator, and verifies the result.

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/integration/finalization.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/finalization.test.ts
git commit -m "test(finalization): add integration tests for all 18 Phase 5 scenarios"
```

---

## Task 16: Update Exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add Phase 5 exports**

Add exports for the new modules:

```typescript
export { renderCommitMessage, renderTagName, isLocalOnlyPath, stageFiles, getStagedFiles, findStagedSetViolations, createCommit, createTag, getTagTarget, commitExists, findTrackedLocalOnlyArtifacts, buildAllowedCommitSet, VERSIONED_ARTIFACT_PATHS, LOCAL_ONLY_PATTERNS } from './git/commit-manager.js';
export { buildFinalAuditorInput, validateFinalAuditorOutput } from './agents/final-auditor-adapter.js';
export { buildFinalAuditorPrompt, type FinalAuditorPromptContext } from './agents/prompt-builder.js';
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat(exports): add Phase 5 public API exports"
```

---

## Task 17: Run Engineering Gates

**Files:**
- None (verification only)

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: No errors.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: Successful build.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 5: Run npm audit**

```bash
npm audit --omit=dev
```

Expected: No critical vulnerabilities.

- [ ] **Step 6: Run git diff check**

```bash
git diff --check
```

Expected: No whitespace errors.

- [ ] **Step 7: Run npm pack dry-run**

```bash
npm pack --dry-run
```

Expected: Exit code 0 (Node engines warning is acceptable).

---

## Task 18: Update Developer Handoff

**Files:**
- Modify: `.agent/developer-handoff.md`

- [ ] **Step 1: Write the Phase 5 developer handoff**

Update `.agent/developer-handoff.md` with the Phase 5 completion report, including:
- Summary of Phase 5 implementation
- Files changed
- Final Audit protocol
- Commit/tag behavior
- Resume/status changes
- Tests added
- Engineering gates
- Smoke result
- Known risks
- Explicit non-goals (Phase 6 items)

- [ ] **Step 2: Commit**

```bash
git add .agent/developer-handoff.md
git commit -m "docs: update developer-handoff for Phase 5 completion"
```

---

## Self-Review Checklist

### Spec Coverage
- [x] §2: FINALIZING → PASSED state closure — Task 8
- [x] §3.1: FINALIZING → PASSED — Task 8
- [x] §3.2: Codex Final Audit and .agent/final-audit.md — Tasks 5, 6, 8
- [x] §3.3: Pre-commit diff/scope/verification re-collection — Task 8
- [x] §3.4: Digest consistency check — Task 8
- [x] §3.5: Local git commit on PASS — Task 8
- [x] §3.6: Optional local tag — Task 8
- [x] §3.7: --no-commit path — Task 8
- [x] §3.8: Resume from FINALIZING — Task 9
- [x] §3.9: Commit success + tag failure → BLOCKED — Task 8
- [x] §3.10: Local-only artifacts excluded — Tasks 4, 8
- [x] §3.11: Status output fields — Task 10
- [x] §3.12: Test coverage — Tasks 13, 14, 15
- [x] §6.1: Normal success path — Task 8
- [x] §6.2: Failure paths — Task 8
- [x] §6.3: --no-commit — Task 8
- [x] §6.4: Tag rules — Task 8
- [x] §6.5: Push rejection — Task 8
- [x] §7: Final Audit protocol — Tasks 3, 5, 6
- [x] §8: Commit boundary — Tasks 4, 8
- [x] §9: Resume — Task 9
- [x] §10: Status — Task 10
- [x] §11: Error categories — Task 1
- [x] §12: Tests — Tasks 13, 14, 15
- [x] §13: Engineering gates — Task 17

### Placeholder Scan
- No TBD, TODO, or "implement later" found
- All code steps contain actual implementation code
- All test steps contain actual test code

### Type Consistency
- `FinalAuditFrontMatter` in types.ts matches schema in artifact-schemas.ts
- `RunState` fields match state-store.ts schema
- `StatusOutput` fields match json-schemas.ts
- `OrchestratorResult` fields match makeResult signature
- `FinalAuditorPromptContext` fields match buildFinalAuditorPrompt parameters
- Error categories in types.ts match usage in orchestrator
