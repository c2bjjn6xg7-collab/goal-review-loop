# Phase 8E R2 Integrated Verification And Final Audit Implementation Plan

> **For agentic workers:** Follow `docs/superpowers/agent-task-planning-guidelines.md`. This is an atomic orchestrator module. Do not split it into file-level tasks unless every slice can independently typecheck and pass targeted tests.

**Goal:** After R1 assembles `integration/{run_id}`, run integrated diff collection, GOAL-level scope guard, GOAL-level verification, and Final Aggregate Audit against the integrated diff. R2 does not create the final project commit or tag.

**Source Specs:**

- `docs/phase-8e-integration-and-aggregate-audit.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-design.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-design.md`

**Critical Invariants:**

- Never use per-task `diff_digest` as integrated evidence.
- Final Aggregate Audit must audit the integrated diff.
- Scope guard and verification use GOAL-level settings.
- Final commit/tag stay out of R2.
- R1 conflict/exclusion behavior remains fail-closed.

---

## Files

Expected files for this atomic module:

- Create: `src/orchestrator/integration-audit.ts`
- Modify: `src/orchestrator/task-graph-wave-loop.ts`
- Create: `tests/unit/integration-audit.test.ts`
- Create or modify: `tests/integration/integration-audit.test.ts`
- Modify: `tests/integration/task-graph-parallel-wave.test.ts`

Optional, only if needed for clean reuse:

- Modify: `src/orchestrator/run-orchestrator.ts` to extract a behavior-preserving final-audit-only helper.
- Modify: `src/agents/prompt-builder.ts` only if existing final-auditor input cannot express integrated provenance without prompt-template changes.

Do not modify:

- provider/model routing
- P6 retry/guard behavior
- R1 conflict auto-resolution policy
- task branch/worktree cleanup behavior
- project-level final commit/tag logic except for extracting shared final audit code if unavoidable

---

## Task 1: Integrated Audit Helper

**Files:**

- Create: `src/orchestrator/integration-audit.ts`
- Create: `tests/unit/integration-audit.test.ts`

### Step 1: Write tests first

Cover:

1. final audit context includes integrated digest and integration branch metadata;
2. final audit context does not include per-task `diff_digest`;
3. integration precondition failures map to BLOCKED results;
4. scope, verification, and final-audit failures map to the expected error categories;
5. PASS result preserves `commit_skipped` semantics for the caller.

### Step 2: Implement helper

Implement `runIntegrationAudit()` to:

1. validate current integration branch and R1 plan evidence;
2. collect integrated diff from `baseCommit`;
3. write `.agent/integration/integrated-diff-metadata.json`;
4. run GOAL-level scope guard;
5. run GOAL-level verification commands;
6. write `.agent/integration/final-audit-context.json`;
7. run Final Aggregate Audit;
8. return passed or blocked without final commit/tag.

Keep the module explicit. Avoid pulling final commit/tag concerns into the helper.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/unit/integration-audit.test.ts
```

---

## Task 2: Wave Loop Wiring

**Files:**

- Modify: `src/orchestrator/task-graph-wave-loop.ts`
- Modify: `tests/integration/task-graph-parallel-wave.test.ts`

### Step 1: Update all-pass wave expectations

The all-pass wave test should expect:

- R1 integration branch still exists and contains task files;
- R2 writes integrated diff metadata;
- R2 writes final audit context;
- `.agent/final-audit.md` exists and records PASS;
- result `audit_decision === "PASS"`;
- result `commit_sha === null`;
- result `commit_skipped === true`;
- skip reason says final commit/tag are deferred to R3.

### Step 2: Wire implementation

After `runIntegrationMerge()` passes:

1. call `runIntegrationAudit()`;
2. if blocked, transition and return BLOCKED with artifact paths;
3. if passed, transition to PASSED and return R2 success semantics;
4. do not call final commit/tag creation.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/integration/task-graph-parallel-wave.test.ts tests/unit/integration-audit.test.ts
```

---

## Task 3: Failure Path Integration Tests

**Files:**

- Create or modify: `tests/integration/integration-audit.test.ts`

### Step 1: Add real-flow tests

Cover:

1. GOAL-level scope violation blocks before verification;
2. GOAL-level verification failure blocks before Final Aggregate Audit;
3. Final Aggregate Audit FAIL/BLOCKED blocks without final commit/tag;
4. R1 conflict/exclusion still blocks before R2 gates.

Use temporary git repositories and existing fake-agent fixtures where possible. Avoid mocking git diff behavior when a real repo is clearer.

### Step 2: Verify

Run:

```bash
npm test -- --run tests/integration/integration-audit.test.ts tests/integration/task-graph-parallel-wave.test.ts tests/unit/integration-audit.test.ts
```

---

## Task 4: Full Validation

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
git diff --check
```

Then check forbidden or risky areas:

```bash
git diff -- review-loop.yaml prompts src/scheduler/failure-policy.ts src/orchestrator/failure-guard.ts
```

Expected: no diff unless an implementation note explicitly explains why a shared final-audit helper required a narrow extraction.

---

## Acceptance Checklist

- [ ] Integrated diff is collected from `base_commit` to `integration/{run_id}`.
- [ ] Integrated diff digest is recomputed and recorded.
- [ ] Per-task `diff_digest` is not used in final audit input.
- [ ] GOAL-level scope guard runs against integrated changed files.
- [ ] GOAL-level verification commands run against the integration branch.
- [ ] Final Aggregate Audit receives integrated diff context and provenance.
- [ ] Scope, verification, and final-audit failures BLOCKED without final commit/tag.
- [ ] Final Audit PASS returns PASSED with `commit_skipped: true`.
- [ ] R2 does not create project-level final commit/tag.
- [ ] Full gates pass.

---

## Review-Loop Request

Use this request when starting the implementation run:

```text
Implement Phase 8E R2 Integrated Verification And Final Audit as one atomic module.

Authoritative docs:
- docs/superpowers/agent-task-planning-guidelines.md
- docs/phase-8e-integration-and-aggregate-audit.md
- docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md
- docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-design.md
- docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-requirements.md
- docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-design.md
- docs/superpowers/plans/2026-06-20-phase-8e-r2-integrated-verification-audit.md

Do not split this into tiny file-level tasks. Keep it as a single atomic orchestrator module unless every split task can independently typecheck and pass targeted tests.

Scope:
- Create src/orchestrator/integration-audit.ts
- Modify src/orchestrator/task-graph-wave-loop.ts
- Create tests/unit/integration-audit.test.ts
- Create or modify tests/integration/integration-audit.test.ts
- Modify tests/integration/task-graph-parallel-wave.test.ts
- Optional narrow extraction from src/orchestrator/run-orchestrator.ts only if required to reuse final-audit-only behavior

Non-goals:
- Do not create final project commit/tag in R2.
- Do not auto-resolve cherry-pick conflicts.
- Do not reuse per-task diff_digest as integrated evidence.
- Do not change provider/model routing, P6 retry/guard behavior, prompts, or task cleanup policy.

Validation:
- npm run typecheck
- npm run lint -- --max-warnings 0
- npm run build
- npm test -- --run
- git diff --check
```
