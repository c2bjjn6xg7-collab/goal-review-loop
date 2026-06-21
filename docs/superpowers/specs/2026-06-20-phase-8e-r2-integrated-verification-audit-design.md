# Phase 8E R2 Integrated Verification And Final Audit Design

> Requirements: `docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-requirements.md`
> Parent: `docs/phase-8e-integration-and-aggregate-audit.md`

## Decision Summary

R2 extends the R1 integration branch assembly path with integrated safety gates. Once `integration/{run_id}` is assembled, the orchestrator recomputes the integrated diff digest, runs GOAL-level scope guard, runs GOAL-level verification commands, and runs Final Aggregate Audit against the integrated diff.

R2 still does not create the project-level final commit or tag. A PASS means "integrated branch audited", not "project finalized".

## Proposed Module

Create `src/orchestrator/integration-audit.ts` as the R2 orchestration helper.

Suggested exports:

```ts
export interface IntegrationAuditResult {
  status: 'passed' | 'blocked';
  integration_branch: string;
  integration_head: string | null;
  integrated_diff_digest: string | null;
  audit_decision: 'PASS' | 'FAIL' | 'BLOCKED' | null;
  artifact_paths: string[];
  error_code: ErrorCategory | null;
  error_message: string | null;
}

export async function runIntegrationAudit(params: {
  projectRoot: string;
  agentDir: string;
  runId: string;
  baseCommit: string;
  goalDigest: string;
  goalFrontMatter: GoalFrontMatter;
  verificationCommands: GoalVerificationCommand[];
  integrationBranch: string;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  orchestratorRegistry: OrchestratorFileRegistry;
  config: ReviewLoopConfig;
  combinedSignal: AbortSignal;
}): Promise<IntegrationAuditResult>;
```

The helper should keep R2 logic out of `task-graph-wave-loop.ts` while letting the wave loop decide how to map the helper result into the final `OrchestratorResult`.

## Data Flow

```text
R1 integration merge PASS
  -> validate integration branch and plan evidence
  -> collect integrated diff from base_commit to integration HEAD
  -> write integrated diff metadata
  -> run GOAL-level scope guard
  -> run GOAL-level verification
  -> build Final Aggregate Audit context from integrated diff
  -> run Final Aggregate Auditor
  -> PASS/BLOCKED result without final commit/tag
```

## Integrated Diff

Use the existing diff collector rather than task-run result digests.

Expected behavior:

- ensure the current branch is `integration/{run_id}`;
- get integration HEAD with `git rev-parse HEAD`;
- call the existing diff collection path with `baseCommit`;
- write `.agent/integration/integrated-diff-metadata.json`;
- register any detailed diff artifacts with the orchestrator registry.

The metadata JSON should include:

```json
{
  "schema_version": 1,
  "run_id": "...",
  "base_commit": "...",
  "integration_branch": "integration/...",
  "integration_head": "...",
  "integrated_diff_digest": "sha256:...",
  "changed_files": [],
  "created_at": "..."
}
```

## Scope Guard

Run `checkScope` using GOAL-level `allowed_changes` and `disallowed_changes`.

Write the report under `.agent/integration/scope-report.json`. If the existing `writeScopeReport` format is reused, the path may be adapted to the integration directory, but the result must be stable and registered.

On denied files, return blocked immediately with `SCOPE_VIOLATION`.

## Verification

Run `runVerification` with GOAL-level commands against the integration branch workspace.

Write `.agent/integration/verification-manifest.json` or register the existing manifest path if the current verification writer cannot target the integration directory without unnecessary refactor.

On required command failure, return blocked immediately with `VERIFICATION_FAILED`.

## Final Aggregate Audit

Run Final Aggregate Audit after scope and verification pass.

The prompt/input must include:

- integrated diff digest;
- integrated diff summary and changed files;
- integration branch and HEAD;
- base commit;
- integration plan task provenance;
- a direct note that per-task `diff_digest` values are not used as integrated evidence.

Prefer reusing existing final-auditor prompt builder and validator. If existing finalization code is too coupled to commit/tag creation, extract the smallest shared helper needed to run only the final audit. Keep the extraction behavior-preserving and covered by tests.

Write `.agent/integration/final-audit-context.json` before invoking the auditor. Continue writing `.agent/final-audit.md` as the final audit report because existing status and CLI code already know that path.

## Wave Loop Integration

In `src/orchestrator/task-graph-wave-loop.ts`, replace the R1 success return with:

1. run R1 integration merge;
2. if R1 blocks, return BLOCKED as today;
3. run `runIntegrationAudit`;
4. if R2 blocks, transition and return BLOCKED;
5. if R2 passes, return PASSED with `commit_skipped: true` and a skip reason that final commit/tag are deferred.

R2 should preserve the current R1 artifact paths and add R2 artifacts.

## Error Mapping

- integration precondition failure: `STATE_CONFLICT`
- integrated scope failure: `SCOPE_VIOLATION`
- integrated verification failure: `VERIFICATION_FAILED`
- final audit schema failure: `FINAL_AUDIT_SCHEMA_ERROR`
- final audit FAIL/BLOCKED: `FINAL_AUDIT_FAILED`

## Testing Strategy

Use targeted unit tests for digest provenance and result mapping, and integration tests for the wave all-pass path.

Recommended tests:

- `tests/unit/integration-audit.test.ts`
  - per-task `diff_digest` does not appear in final audit context;
  - integrated metadata uses recomputed digest;
  - failure result mapping is stable.
- `tests/integration/task-graph-parallel-wave.test.ts`
  - all-pass wave now assembles integration branch, runs R2 gates, writes final audit, and still skips final commit/tag.
- `tests/integration/integration-audit.test.ts`
  - scope violation blocks before verification;
  - verification failure blocks before final audit;
  - final audit failure blocks without commit/tag.

## Follow-Up Slice

R3 should create the project-level final commit/tag only after R2 Final Aggregate Audit PASS. R3 should also decide whether the final commit is created on `integration/{run_id}` or moved back to the original branch through a controlled fast-forward or merge policy.
