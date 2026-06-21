# Phase 8E R3 Finalization Commit And Tag Design

> Requirements: `docs/superpowers/specs/2026-06-21-phase-8e-r3-finalization-commit-tag-requirements.md`
> Parent: `docs/phase-8e-integration-and-aggregate-audit.md`

## Decision Summary

R3 turns an R2-audited integration branch into the project-level final commit. It runs after R2 Final Aggregate Audit PASS, validates that the business tree still matches the audited integrated diff, stages only the controlled final file set, creates the final commit on `integration/{run_id}`, and optionally creates a local tag.

R3 does not move the original branch. The final deliverable of this slice is a sealed integration branch commit. Promotion back to the original branch remains outside R3.

## Proposed Module

Create `src/orchestrator/integration-finalizer.ts`.

Suggested exports:

```ts
export interface IntegrationFinalizationResult {
  status: 'passed' | 'blocked';
  integration_branch: string;
  final_commit_sha: string | null;
  final_commit_message: string | null;
  tag_name: string | null;
  tag_created: boolean;
  artifact_paths: string[];
  error_code: ErrorCategory | null;
  error_message: string | null;
}

export async function runIntegrationFinalization(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  baseCommit: string;
  goalDigest: string;
  integrationBranch: string;
  iteration: number;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  tag: boolean;
  noCommit: boolean;
}): Promise<IntegrationFinalizationResult>;
```

The helper should be independent from `runFinalization()` because R3 starts after Final Aggregate Audit has already passed. Shared low-level git helpers may be extracted from `src/git/commit-manager.ts` when behavior-preserving.

## Data Flow

```text
R2 integrated audit PASS
  -> validate R2 evidence and current integration branch
  -> recompute business diff from base_commit
  -> compare against integrated-diff-metadata and final-audit context
  -> build final commit file set
  -> precise stage business files
  -> force-add allowlisted .agent artifacts
  -> verify staged set
  -> create final commit on integration/{run_id}
  -> optionally create local tag
  -> update state and return PASSED
```

## Evidence Validation

R3 should read and cross-check:

- `.agent/integration/integration-plan.json`
- `.agent/integration/integrated-diff-metadata.json`
- `.agent/integration/final-audit-context.json`
- `.agent/final-audit.md`
- `.agent/state.json`

The validation should require the same:

- `run_id`
- `base_commit`
- `integration_branch`
- integrated diff digest
- integration HEAD audited by R2
- Final Aggregate Audit decision `PASS`

The current branch should be switched to `integration/{run_id}` only when tracked worktree state is clean enough to switch safely. Untracked ignored `.agent` artifacts may exist because they are expected R2 evidence.

## Business Tree Digest Check

Use `collectDiff({ projectRoot, baseCommit, iteration })` after switching to the integration branch. Compare the recomputed digest and business changed-file list with R2 integrated evidence.

The R2 digest is expected to exclude ignored `.agent/**` runtime files because repository `.gitignore` ignores `.agent/**`. R3 should therefore treat `.agent` files as commit artifacts, not business diff input.

If the digest comparison is too strict because finalization artifacts become tracked on resume, the implementation should compare a normalized business file set and tracked business diff while still proving no non-`.agent` file changed after R2.

## Versioned Artifact Policy

Add a task-graph integration artifact allowlist, for example:

```ts
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
```

Optional artifact paths may be represented separately and filtered by existence:

```ts
export const OPTIONAL_INTEGRATION_VERSIONED_ARTIFACT_PATHS = [
  '.agent/integration/conflict-report.md',
  '.agent/integration/excluded-tasks.md',
] as const;
```

Do not add `.agent/task-runs/**` to this R3 list.

## Controlled Force-Add

Extend `stageFiles()` or add a sibling helper that supports per-path force mode:

```ts
stageFiles(projectRoot, [
  { path: 'src/feature.ts', force: false },
  { path: '.agent/final-audit.md', force: true },
]);
```

Rules:

- `force: true` is allowed only for paths in the integration versioned artifact allowlist;
- local-only paths are rejected before invoking git;
- staging uses `git add -- <path>` for business files;
- staging uses `git add -f -- <path>` for allowlisted ignored artifacts;
- callers verify the final staged set with `findStagedSetViolations()`.

This preserves the Phase 5 rule that the orchestrator never uses broad staging.

## Commit Flow

R3 should render `config.git.commit_template` with the same placeholder semantics as existing finalization:

- `{task_slug}`
- `{run_id}`
- `{iteration}`
- `{short_goal_digest}`

The commit is created on `integration/{run_id}`. After success, write:

- `final_commit_sha`
- `final_commit_message`
- `commit_skipped: false`
- `skip_reason: null`
- `finalized_at`
- `branch: integration/{run_id}`

If `noCommit` is true or `config.git.commit_on_pass` is false, R3 may preserve existing skip behavior only if the caller explicitly requested a no-commit run. The normal Phase 8E R3 path should create a commit.

## Tag Flow

Reuse `renderTagName()`, `getTagTarget()`, and `createTag()`.

Tag behavior should mirror existing finalization:

- render the tag when CLI `tag` or `config.git.create_tag` requests it;
- if the tag exists and points to the final commit, treat it as success;
- if the tag exists and points elsewhere, BLOCKED with `GIT_TAG_ERROR`;
- if tag creation fails, BLOCKED but preserve the final commit SHA in state.

## Resume Flow

Resume should first inspect state:

1. If `final_commit_sha` exists, verify it before trusting it.
2. If the commit is valid and the tag is complete or not requested, return PASSED.
3. If the commit is valid and the tag is missing, run only tag handling.
4. If the commit SHA is stale, clear final commit state and rerun precommit validation from R2 evidence.

Commit verification should check:

- commit exists;
- commit is reachable from `integration/{run_id}`;
- required artifact paths exist in the commit tree;
- committed `.agent/final-audit.md` belongs to the run and decision `PASS`;
- committed integration metadata matches run id, base commit, branch, and integrated digest.

## Wave Loop Integration

In `src/orchestrator/task-graph-wave-loop.ts`, replace the R2 success mapping:

1. run R1 integration merge;
2. run R2 integrated audit;
3. if R2 blocks, return BLOCKED as today;
4. if R2 passes, call `runIntegrationFinalization()`;
5. map R3 PASSED to an `OrchestratorResult` with `commit_skipped: false`;
6. map R3 BLOCKED to an actionable BLOCKED result.

The wave loop should continue to surface `.agent/integration/**` artifacts in `artifact_paths`.

## Interaction With Existing Finalization

Existing serial finalization remains owned by `runFinalization()`. R3 should not route wave integration through `runFinalization()` because that would rerun Final Aggregate Audit and use Phase 5 artifact assumptions.

Allowed shared work:

- add force-add support to `src/git/commit-manager.ts`;
- add integration-specific artifact constants;
- extract tag-resume helpers if tests prove behavior stays unchanged.

Avoid broad refactors of serial task-graph or non-task-graph finalization.

## Error Mapping

- stale or missing R2 evidence: `STATE_CONFLICT` or `FINAL_AUDIT_FAILED`
- business tree mismatch after R2 PASS: `STATE_CONFLICT`
- local-only file would be committed: `PRE_COMMIT_STAGED_SET_VIOLATION`
- staging or commit failure: `GIT_COMMIT_ERROR`
- tag template, conflict, or creation failure: `GIT_TAG_ERROR`
- unsupported push request: `UNSUPPORTED_PUSH`

## Testing Strategy

Recommended tests:

- `tests/unit/integration-finalizer.test.ts`
  - artifact allowlist filters existing files;
  - local-only `.agent` paths are rejected;
  - R2 metadata mismatch maps to BLOCKED;
  - staged-set verification rejects extra files;
  - resume verifies existing final commit evidence.
- `tests/unit/commit-manager.test.ts`
  - force-add stages ignored allowlisted paths;
  - force-add rejects non-allowlisted `.agent` paths.
- `tests/integration/integration-finalizer.test.ts`
  - creates commit on `integration/{run_id}` with business files and R3 artifacts;
  - does not move original branch;
  - creates tag when requested;
  - resumes from commit-created/tag-missing state.
- `tests/integration/task-graph-parallel-wave.test.ts`
  - all-pass wave now returns a final commit SHA and `commit_skipped: false`;
  - R2 blockers still stop before R3.

## Follow-Up Slice

A later slice may add controlled promotion of the final integration commit back to the original branch. That slice should define whether promotion is fast-forward-only, merge-commit-based, or manual.
