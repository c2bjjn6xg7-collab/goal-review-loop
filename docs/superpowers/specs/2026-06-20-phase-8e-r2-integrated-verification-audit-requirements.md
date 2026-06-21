# Phase 8E R2 Integrated Verification And Final Audit Requirements

> Source of truth: `docs/phase-8e-integration-and-aggregate-audit.md`
> Builds on: `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md`
> Scope: second implementation slice for Phase 8E

## Problem

Phase 8E R1 creates `integration/{run_id}` and cherry-picks passed task commits in DAG order, but it deliberately stops before the safety gates that make the integrated tree auditable:

- it does not collect the integrated diff from `base_commit` to the integration branch;
- it does not recompute an integrated `diff_digest`;
- it does not run GOAL-level scope guard on the combined diff;
- it does not run GOAL-level verification commands against the integrated tree;
- it does not run Final Aggregate Audit on the integrated diff.

R2 must add those safety gates while still deferring the project-level final commit/tag to a later slice.

## Goals

1. After R1 assembles `integration/{run_id}`, collect a fresh integrated diff from `base_commit` to the current integration branch.
2. Recompute the integrated `diff_digest` from that integrated diff and record it as the only digest eligible for Final Aggregate Audit.
3. Run GOAL-level scope guard against the integrated changed files.
4. Run GOAL-level verification commands against the integrated workspace.
5. Run Final Aggregate Audit using integrated diff evidence and integrated digest only.
6. Return BLOCKED on integrated scope, verification, or final audit failure.
7. Keep final project commit/tag creation out of R2.

## Core Invariants

### I1. Integrated Digest Only

R2 must never reuse per-task `diff_digest` values from `.agent/task-runs/{task_id}/result.json`. It may read task-run results only for metadata needed to explain provenance, such as task id, branch, and commit sha. The digest passed to Final Aggregate Audit must be recomputed from the integrated diff.

### I2. Final Auditor Audits The Integrated Diff

The Final Aggregate Auditor must receive evidence for the exact integrated tree under review. The prompt/input must make clear that per-task audits are not substitutes for the integrated audit.

### I3. GOAL-Level Gates

Integrated scope guard and verification must use GOAL-level `allowed_changes`, `disallowed_changes`, and `verification_commands`, not per-task scopes or per-task verification commands.

### I4. No Final Commit Or Tag

R2 may return PASSED after Final Aggregate Audit PASS, but it must still set `commit_sha: null`, `commit_skipped: true`, `tag_created: false`, and a skip reason explaining that final commit/tag are deferred to R3.

### I5. No Conflict Auto-Resolution

R2 must not change R1 conflict handling. If R1 cannot assemble the integration branch cleanly, R2 must not attempt to resolve conflicts or continue verification.

## Functional Requirements

### R1. Integration Preconditions

Before running R2 gates, validate that:

- the integration branch is `integration/{run_id}`;
- the repository is currently on that branch, or can safely switch to it;
- the branch is a descendant of `base_commit`;
- `.agent/integration/integration-plan.json` exists and matches the current run id and base commit;
- the plan has no excluded tasks.

Any failed precondition returns BLOCKED with `STATE_CONFLICT` or `VERIFICATION_FAILED`, whichever best matches existing categories.

### R2. Integrated Diff Collection

Collect the integrated diff from `base_commit` to the integration branch using the existing diff collection path. Write integrated diff evidence under `.agent/integration/`.

The evidence must include:

- integrated changed files;
- integrated diff digest;
- base commit;
- integration branch;
- integration HEAD commit;
- timestamp;
- artifact paths for any detailed diff files.

### R3. Scope Guard

Run scope guard using GOAL-level `allowed_changes` and `disallowed_changes`.

If scope guard fails:

- transition to BLOCKED;
- write a scope report artifact under `.agent/integration/`;
- return an `OrchestratorResult` with `SCOPE_VIOLATION`;
- do not run integrated verification, Final Aggregate Audit, final commit, or tag.

### R4. Integrated Verification

Run GOAL-level verification commands against the integrated branch.

If a required command fails:

- transition to BLOCKED;
- write verification artifacts under `.agent/integration/`;
- return an `OrchestratorResult` with `VERIFICATION_FAILED`;
- do not run Final Aggregate Audit, final commit, or tag.

### R5. Final Aggregate Audit

Run Final Aggregate Audit after integrated scope and verification pass.

The auditor input must include:

- integrated diff digest;
- integrated changed files;
- integration branch and HEAD;
- base commit;
- task provenance from the integration plan;
- a statement that per-task `diff_digest` values are not reused as integrated evidence.

If Final Aggregate Audit fails or blocks:

- transition to BLOCKED;
- write `.agent/final-audit.md` and any supporting audit artifacts;
- return `FINAL_AUDIT_FAILED` or `FINAL_AUDIT_SCHEMA_ERROR` as appropriate;
- do not create final commit or tag.

### R6. R2 Success Result

On Final Aggregate Audit PASS:

- transition to PASSED;
- return branch `integration/{run_id}`;
- return `audit_decision: "PASS"`;
- return `commit_sha: null`;
- return `commit_skipped: true`;
- return `tag_name: null`;
- return `tag_created: false`;
- set `skip_reason` to explain that R2 ran integrated verification and Final Aggregate Audit but deferred final commit/tag to R3.

### R7. Evidence Files

R2 must write or register these artifacts where applicable:

- `.agent/integration/integrated-diff-metadata.json`
- `.agent/integration/scope-report.json`
- `.agent/integration/verification-manifest.json`
- `.agent/integration/final-audit-context.json`
- `.agent/final-audit.md`

Existing artifact formats may be reused when they already provide the same information.

### R8. Tests

Add targeted tests covering:

1. integrated diff digest is recomputed and does not copy per-task `diff_digest`;
2. GOAL-level scope violation BLOCKEDs before verification;
3. GOAL-level verification failure BLOCKEDs before Final Aggregate Audit;
4. Final Aggregate Audit FAIL/BLOCKED returns BLOCKED without final commit/tag;
5. Final Aggregate Audit PASS returns PASSED with `commit_skipped: true`;
6. R2 success includes integration branch and artifact paths;
7. R1 conflict/exclusion behavior still blocks before R2 gates;
8. no code path passes per-task `diff_digest` to final audit input.

### R9. Engineering Gates

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
git diff --check
```

## Non-Goals

- Do not create the project-level final commit.
- Do not create tags.
- Do not push to remote.
- Do not auto-resolve cherry-pick conflicts.
- Do not support manual conflict resume.
- Do not implement partial integration.
- Do not delete task branches or worktrees.
- Do not change provider/model routing.
- Do not change Auditor or Final Auditor model strategy.
- Do not alter serial task-graph behavior unless extracting a shared helper is required and covered by tests.
