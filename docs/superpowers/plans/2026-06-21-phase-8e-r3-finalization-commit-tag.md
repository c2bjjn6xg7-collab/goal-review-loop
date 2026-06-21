# Phase 8E R3 Finalization Commit And Tag Implementation Plan

> **For agentic workers:** Follow `docs/superpowers/agent-task-planning-guidelines.md`. This is an atomic orchestrator finalization module. Do not split it into file-level tasks unless every slice can independently typecheck and pass targeted tests.

**Goal:** After Phase 8E R2 Final Aggregate Audit PASS, create the final project commit on `integration/{run_id}`, optionally create a local tag, and record finalization state without moving the original branch.

**Source Specs:**

- `docs/phase-8e-integration-and-aggregate-audit.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-design.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-design.md`
- `docs/superpowers/specs/2026-06-21-phase-8e-r3-finalization-commit-tag-requirements.md`
- `docs/superpowers/specs/2026-06-21-phase-8e-r3-finalization-commit-tag-design.md`

**Critical Invariants:**

- Final Aggregate Audit PASS from R2 is required.
- R3 commits the exact audited business tree.
- R3 finalizes on `integration/{run_id}` and does not move the original branch.
- R3 uses precise staging only.
- Ignored `.agent` artifacts may be force-added only through an explicit allowlist.
- `.agent/task-runs/**` stays out of the R3 commit.
- Push remains unsupported.

---

## Files

Expected files for this atomic module:

- Create: `src/orchestrator/integration-finalizer.ts`
- Modify: `src/orchestrator/task-graph-wave-loop.ts`
- Modify: `src/git/commit-manager.ts`
- Create: `tests/unit/integration-finalizer.test.ts`
- Modify: `tests/unit/commit-manager.test.ts`
- Create: `tests/integration/integration-finalizer.test.ts`
- Modify: `tests/integration/task-graph-parallel-wave.test.ts`

Optional, only if needed for clean reuse:

- Modify: `src/orchestrator/run-orchestrator.ts` to extract tag verification helpers without changing serial finalization behavior.
- Modify: `src/orchestrator/integration-audit.ts` only if R2 result mapping needs a small handoff field for R3.

Do not modify:

- provider/model routing
- Planner/Developer/Auditor commands
- R1 cherry-pick conflict policy
- R2 Final Aggregate Audit prompt semantics
- original branch promotion behavior
- task branch/worktree cleanup behavior

---

## Task 1: Commit Manager Force-Add Support

**Files:**

- Modify: `src/git/commit-manager.ts`
- Modify: `tests/unit/commit-manager.test.ts`

### Step 1: Add tests first

Cover:

1. ordinary business paths still stage with precise pathspecs;
2. allowlisted ignored `.agent` paths can be staged with force mode;
3. non-allowlisted `.agent` paths are rejected before git is invoked;
4. local-only runtime artifacts are rejected;
5. existing `stageFiles()` behavior remains compatible for current callers.

### Step 2: Implement force-add support

Add a narrow helper or extend `stageFiles()` with structured inputs.

The helper must:

- accept exact paths only;
- use `git add -- <path>` for normal files;
- use `git add -f -- <path>` only for allowlisted `.agent` artifacts;
- reject local-only paths;
- return explicit errors for caller mapping.

Keep `git add -A` out of the implementation.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/unit/commit-manager.test.ts
```

---

## Task 2: Integration Finalizer Helper

**Files:**

- Create: `src/orchestrator/integration-finalizer.ts`
- Create: `tests/unit/integration-finalizer.test.ts`
- Create: `tests/integration/integration-finalizer.test.ts`

### Step 1: Write unit tests first

Cover:

1. validates matching R2 evidence;
2. blocks on missing Final Audit PASS;
3. blocks on integrated digest mismatch;
4. builds the final commit set from business files plus R3 artifact allowlist;
5. excludes `.agent/task-runs/**` and local-only runtime files;
6. maps staging, commit, and tag failures to stable error categories.

### Step 2: Implement helper

Implement `runIntegrationFinalization()` to:

1. switch safely to `integration/{run_id}`;
2. load and validate R2 evidence;
3. recompute and compare the business diff;
4. build the commit file set;
5. stage with precise pathspecs and controlled force-add;
6. verify staged set;
7. render and create the final commit;
8. optionally create the tag;
9. update state and return result metadata.

### Step 3: Add integration tests

Use temporary git repositories and the existing R2 fixture helpers where possible.

Cover:

1. commit is created on `integration/{run_id}`;
2. original branch remains at its pre-integration SHA;
3. committed tree includes business files and required R3 artifacts;
4. committed tree excludes local-only `.agent` files and `.agent/task-runs/**`;
5. tag is created when requested;
6. resume after commit but before tag creates only the tag.

### Step 4: Verify

Run:

```bash
npm test -- --run tests/unit/integration-finalizer.test.ts tests/integration/integration-finalizer.test.ts tests/unit/commit-manager.test.ts
```

---

## Task 3: Wave Loop Wiring

**Files:**

- Modify: `src/orchestrator/task-graph-wave-loop.ts`
- Modify: `tests/integration/task-graph-parallel-wave.test.ts`

### Step 1: Update all-pass expectations

The all-pass wave test should expect:

- R1 creates `integration/{run_id}`;
- R2 writes integrated audit evidence and Final Aggregate Audit PASS;
- R3 creates a final commit SHA;
- result `commit_skipped === false`;
- result `skip_reason === null`;
- final branch is `integration/{run_id}`;
- original branch is not moved.

### Step 2: Wire implementation

After `runIntegrationAudit()` passes:

1. call `runIntegrationFinalization()`;
2. if R3 blocks, transition and return BLOCKED with artifact paths;
3. if R3 passes, transition and return PASSED with commit/tag metadata;
4. preserve existing R1 and R2 blocked behavior.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/integration/task-graph-parallel-wave.test.ts tests/integration/integration-finalizer.test.ts tests/unit/integration-finalizer.test.ts
```

---

## Task 4: Resume And Tag Edge Cases

**Files:**

- Modify: `tests/integration/integration-finalizer.test.ts`
- Modify: `src/orchestrator/integration-finalizer.ts`

### Step 1: Add resume tests

Cover:

1. state has valid `final_commit_sha` and no tag requested returns PASSED without duplicate commit;
2. state has valid `final_commit_sha` and tag requested creates tag;
3. state has valid `final_commit_sha` and existing matching tag returns PASSED;
4. state has valid `final_commit_sha` and existing conflicting tag returns BLOCKED;
5. stale `final_commit_sha` is cleared and finalization reruns only when R2 evidence still validates.

### Step 2: Implement resume logic

Keep resume checks explicit and fail closed. A commit may be trusted only after tree and evidence validation succeeds.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/integration/integration-finalizer.test.ts
```

---

## Task 5: Full Validation

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
git diff --check
```

Then inspect accidental high-risk changes:

```bash
git diff -- review-loop.yaml prompts src/providers src/scheduler/failure-policy.ts src/orchestrator/failure-guard.ts
```

Expected: no diff unless the implementation explicitly explains a narrow shared helper extraction.

---

## Acceptance Checklist

- [ ] R3 requires R2 Final Aggregate Audit PASS.
- [ ] R3 recomputes and validates the integrated business diff before commit.
- [ ] R3 creates the final commit on `integration/{run_id}`.
- [ ] R3 does not move the original branch.
- [ ] R3 stages only business files plus allowlisted versioned artifacts.
- [ ] R3 force-adds ignored `.agent` artifacts only when allowlisted.
- [ ] R3 excludes local-only runtime artifacts and `.agent/task-runs/**`.
- [ ] R3 records `final_commit_sha`, `final_commit_message`, and finalization state.
- [ ] R3 creates or verifies a local tag when requested.
- [ ] R3 resume does not create duplicate commits.
- [ ] Full gates pass.

---

## Review-Loop Request

Use this request when starting the implementation run:

```text
Implement Phase 8E R3 Finalization Commit And Tag as one atomic orchestrator module.

Authoritative docs:
- docs/superpowers/agent-task-planning-guidelines.md
- docs/phase-8e-integration-and-aggregate-audit.md
- docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md
- docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-design.md
- docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-requirements.md
- docs/superpowers/specs/2026-06-20-phase-8e-r2-integrated-verification-audit-design.md
- docs/superpowers/specs/2026-06-21-phase-8e-r3-finalization-commit-tag-requirements.md
- docs/superpowers/specs/2026-06-21-phase-8e-r3-finalization-commit-tag-design.md
- docs/superpowers/plans/2026-06-21-phase-8e-r3-finalization-commit-tag.md

Scope:
- Create src/orchestrator/integration-finalizer.ts
- Modify src/orchestrator/task-graph-wave-loop.ts
- Modify src/git/commit-manager.ts for controlled force-add support
- Create tests/unit/integration-finalizer.test.ts
- Modify tests/unit/commit-manager.test.ts
- Create tests/integration/integration-finalizer.test.ts
- Modify tests/integration/task-graph-parallel-wave.test.ts
- Optional narrow helper extraction from src/orchestrator/run-orchestrator.ts only if required for tag verification reuse

Non-goals:
- Do not rerun Final Aggregate Audit in R3.
- Do not move the original branch.
- Do not push commits or tags.
- Do not auto-resolve integration conflicts.
- Do not commit .agent/task-runs/**.
- Do not change provider/model routing.

Critical details:
- .agent/** is ignored by .gitignore, so R3 must force-add only allowlisted .agent artifacts.
- Use precise staging only; never use git add -A or git add .
- Final commit is created on integration/{run_id}.
- Original branch promotion is a later slice or manual action.

Validation:
- npm run typecheck
- npm run lint -- --max-warnings 0
- npm run build
- npm test -- --run
- git diff --check
```
