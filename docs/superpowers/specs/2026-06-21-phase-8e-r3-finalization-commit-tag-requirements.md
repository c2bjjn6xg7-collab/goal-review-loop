# Phase 8E R3 Finalization Commit And Tag Requirements

> Source of truth: `docs/phase-8e-integration-and-aggregate-audit.md`
> Builds on: `docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-requirements.md`
> Scope: third implementation slice for Phase 8E

## Problem

Phase 8E R2 assembles `integration/{run_id}`, recomputes the integrated diff digest, runs GOAL-level scope and verification gates, and runs Final Aggregate Audit against the integrated diff. On PASS, R2 still returns `commit_skipped: true` because project-level final commit and tag creation were deferred to R3.

That leaves the audited integration branch unsealed:

- the reviewed business changes are present on `integration/{run_id}` but are not captured in a final commit;
- the Final Aggregate Audit PASS is recorded, but the repository has no final project commit SHA;
- optional tag creation has not run;
- resume cannot treat the run as fully finalized.

R3 must close Phase 8E by creating the final project commit, and optional tag, from the exact integrated tree that R2 audited.

## Goals

1. After R2 PASS, create the final project commit on `integration/{run_id}`.
2. Use the existing commit and tag templates where possible.
3. Record final commit and tag state in `.agent/state.json` and in the returned `OrchestratorResult`.
4. Commit only the controlled business file set plus an explicit allowlist of versioned run artifacts.
5. Force-add only allowlisted `.agent` artifacts because `.agent/**` is ignored by repository `.gitignore`.
6. Support idempotent resume after a commit, tag, or process interruption.
7. Keep the original branch unchanged in R3.
8. Keep push behavior unsupported.

## Core Invariants

### I1. Final Audit PASS Is Mandatory

R3 may finalize only after R2 has produced a valid Final Aggregate Audit PASS for the current `run_id`, `base_commit`, `integration/{run_id}`, integration HEAD, and integrated diff digest.

If R2 evidence is missing, stale, mismatched, or not a PASS, R3 must return BLOCKED. R3 must not rerun Final Aggregate Audit to repair missing R2 evidence.

### I2. Final Commit Must Seal The Audited Integration Tree

The final commit must be created from the exact business tree that R2 audited. Between R2 PASS and commit creation:

- no business file may change;
- the integration branch HEAD must remain the audited integration HEAD, or the implementation must prove that only allowlisted `.agent` artifact staging changed the commit tree;
- the recomputed business diff from `base_commit` must still match R2's integrated digest evidence.

If this cannot be proven, R3 must BLOCKED instead of committing.

### I3. Controlled Staging Only

R3 must not run `git add -A`, `git add .`, or any broad staging command.

The staged set must be built from:

- business files in the integrated diff, excluding `.agent/**`; and
- R3's explicit versioned artifact allowlist.

After staging, R3 must verify that the staged set contains no file outside that allowed set. On violation, reset the staged set and BLOCKED.

### I4. Ignored `.agent` Artifacts Need An Explicit Policy

The repository ignores `.agent/**`, so ordinary `git add -- .agent/...` is not enough for versioned artifacts. R3 must introduce controlled force-add behavior for allowlisted `.agent` files only.

The force-add path must reject any local-only runtime artifact and any `.agent` path not named by the R3 allowlist.

### I5. Original Branch Is Not Moved In R3

R3 finalizes on `integration/{run_id}`. It must not fast-forward, merge, rebase, or reset the original branch. Promoting the final integration commit back to the original branch is a later slice or a manual user action.

### I6. No Push

R3 must continue to reject `git.push: true`. It may create a local tag when requested, but it must not push commits or tags.

## Functional Requirements

### R1. Preconditions

Before staging or committing, R3 must validate:

- the repository can safely switch to `integration/{run_id}`;
- the current branch after validation is `integration/{run_id}`;
- the integration branch is a descendant of `base_commit`;
- `.agent/integration/integration-plan.json` exists and matches `run_id`, `base_commit`, and the integration branch;
- `.agent/integration/integrated-diff-metadata.json` exists and matches the current run;
- `.agent/integration/final-audit-context.json` exists and matches the same integrated digest and integration HEAD;
- `.agent/final-audit.md` exists, parses successfully, belongs to the current run, and has decision `PASS`;
- state `audited_diff_digest` matches the integrated digest evidence;
- R2 did not leave the run in BLOCKED.

Any failed precondition returns BLOCKED with `STATE_CONFLICT`, `FINAL_AUDIT_FAILED`, or `GIT_COMMIT_ERROR`, whichever best matches the existing error categories.

### R2. Business Tree Verification

R3 must verify that the business tree is still the R2-audited tree.

The implementation should:

1. recompute the diff from `base_commit` to the current integration branch using the same diff collector used by R2;
2. compare the recomputed digest to `.agent/integration/integrated-diff-metadata.json`;
3. compare changed business files to the R2 changed-file evidence;
4. ignore `.agent/**` when deciding whether business files changed after R2.

If the digest or business changed-file set does not match R2 evidence, R3 must BLOCKED and must not stage files.

### R3. Versioned Artifact Allowlist

R3 must define a task-graph integration artifact allowlist distinct from local-only runtime files.

Required versioned artifacts:

- `.agent/GOAL.md`
- `.agent/plan.md`
- `.agent/task-graph.json`
- `.agent/task-results.json`
- `.agent/final-audit.md`
- `.agent/integration/integration-plan.json`
- `.agent/integration/cherry-pick-log.jsonl`
- `.agent/integration/integrated-diff-metadata.json`
- `.agent/integration/changed-files.json`
- `.agent/integration/untracked-files.json`
- `.agent/integration/diff-metadata.json`
- `.agent/integration/scope-report.json`
- `.agent/integration/verification-manifest.json`
- `.agent/integration/final-audit-context.json`

Optional versioned artifacts, included only if they exist:

- `.agent/integration/conflict-report.md`
- `.agent/integration/excluded-tasks.md`

R3 should not commit `.agent/task-runs/**` in this slice. Task-run directories are bulky, provider-specific, and not needed to prove the final integrated result when `task-results.json`, the integration plan, integrated diff evidence, and Final Aggregate Audit are committed. A later slice may add a compact task-run manifest if needed.

R3 must exclude:

- `.agent/state.json`
- `.agent/run.lock`
- `.agent/cancel-request.json`
- `.agent/progress.json`
- `.agent/progress.md`
- `.agent/iteration-log.md`
- `.agent/verification/**`
- `.agent/evidence/**`
- `.agent/history/**`
- `.agent/debug/**`
- `.agent/transcripts/**`
- `.agent/task-runs/**`
- worktrees, dependency folders, build output, and test reports.

### R4. Staging

R3 must build the final staged set as:

- business files from the post-R2 integrated diff, excluding `.agent/**`; plus
- existing files from the R3 versioned artifact allowlist.

Staging rules:

- stage business files with precise pathspecs;
- force-add allowlisted `.agent` artifacts with precise pathspecs;
- never force-add paths outside the allowlist;
- verify `git diff --cached --name-only` is a subset of the allowed set;
- reset the staged set on staging, template, staged-set, or commit failure.

### R5. Commit Creation

On successful staging, R3 must render the configured commit template and create the final commit.

On commit success, R3 must update state:

- `final_commit_sha`
- `final_commit_message`
- `commit_skipped: false`
- `skip_reason: null`
- `finalized_at`
- `branch: integration/{run_id}`

The returned result must include the final commit SHA and `commit_skipped: false`.

### R6. Tag Creation

If the CLI flag or config requests tag creation, R3 must render the configured tag template and create a local tag pointing to the final commit.

Idempotency rules:

- if the tag already exists and points to the expected final commit, mark `tag_created: true`;
- if the tag already exists and points elsewhere, BLOCKED with `GIT_TAG_ERROR`;
- if tag creation fails after commit creation, return BLOCKED but keep `final_commit_sha` in state so resume can retry only tag creation.

### R7. Resume Behavior

R3 must be safe to resume from interruptions.

If state already contains `final_commit_sha`:

- verify the commit exists;
- verify the commit is on `integration/{run_id}` or reachable from it;
- verify the commit contains the required versioned artifacts;
- verify `.agent/final-audit.md` in the commit belongs to the current run and decision `PASS`;
- verify integration evidence in the commit points to the audited digest and integration branch;
- skip duplicate commit creation;
- proceed to tag handling if needed.

If state has no final commit SHA but HEAD already appears to be the finalization commit for the current run, the implementation may adopt it only if the same validations pass.

### R8. Result Mapping

On R3 success:

- phase is `PASSED`;
- branch is `integration/{run_id}`;
- `audit_decision` is `PASS`;
- `commit_sha` is the final commit SHA;
- `commit_skipped` is `false`;
- `skip_reason` is `null`;
- `tag_name` and `tag_created` reflect requested tag behavior;
- artifact paths include the committed R3 versioned artifact allowlist.

On R3 BLOCKED, the result must include a clear message and actionable suggested next step. If a commit was already created before a tag failure, return that commit SHA.

### R9. Tests

Add tests covering:

1. R3 blocks when Final Aggregate Audit evidence is missing or not PASS;
2. R3 blocks when current integration diff no longer matches R2 integrated digest evidence;
3. R3 stages business files plus allowlisted ignored `.agent` artifacts;
4. R3 never stages local-only `.agent` runtime files;
5. R3 creates a final commit on `integration/{run_id}` and records state/result correctly;
6. R3 creates a tag when requested;
7. R3 resumes when commit exists and tag is missing;
8. R3 treats an existing matching tag as success;
9. R3 blocks on tag conflict;
10. wave all-pass path now returns `commit_skipped: false` after R3;
11. original branch is not moved.

### R10. Engineering Gates

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
git diff --check
```

## Non-Goals

- Do not rerun Planner, Developer, Auditor, or Final Auditor in R3.
- Do not auto-resolve integration conflicts.
- Do not move the original branch.
- Do not push commits or tags.
- Do not delete task branches or worktrees.
- Do not commit `.agent/task-runs/**` in R3.
- Do not change provider/model routing.
- Do not change R1 cherry-pick ordering.
- Do not change R2 integrated digest or Final Aggregate Audit semantics.
