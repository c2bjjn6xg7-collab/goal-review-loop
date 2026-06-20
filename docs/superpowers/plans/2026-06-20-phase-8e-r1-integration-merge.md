# Phase 8E R1 Integration Merge Implementation Plan

> **For agentic workers:** Follow `docs/superpowers/agent-task-planning-guidelines.md`. This is an atomic cross-file module; do not split below independently-buildable units.

**Goal:** After Phase 8D wave tasks pass, assemble their task commits onto `integration/{run_id}` in DAG topological order, with conflict-to-BLOCKED behavior and integration evidence. R1 does not run Final Aggregate Audit or create the final project commit/tag.

**Source Specs:**

- `docs/phase-8e-integration-and-aggregate-audit.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md`
- `docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-design.md`

**Critical Invariants:**

- Never use per-task `diff_digest` as integrated evidence.
- Never auto-resolve cherry-pick conflicts.
- Use `orderedTasks(taskGraph)`, not wave order.
- Keep Final Aggregate Audit/final commit out of R1.

---

## Files

Expected files for this atomic module:

- Create: `src/orchestrator/integration-plan.ts`
- Create: `src/orchestrator/integration-runner.ts`
- Modify: `src/orchestrator/task-graph-wave-loop.ts`
- Create: `tests/unit/integration-plan.test.ts`
- Create: `tests/integration/integration-runner.test.ts`
- Modify: `tests/integration/task-graph-parallel-wave.test.ts`
- Optional modify: `src/index.ts` only if exports are required by tests or public API

Do not modify:

- `src/orchestrator/task-graph-loop.ts` serial behavior
- `src/orchestrator/run-orchestrator.ts` monolithic loop
- P6 failure guard/retry modules
- provider routing/model configuration
- prompts, unless a later 8E final-audit slice explicitly requires it

---

## Task 1: Integration Plan Helper

**Files:**

- Create: `src/orchestrator/integration-plan.ts`
- Create: `tests/unit/integration-plan.test.ts`

### Step 1: Write tests first

Cover:

1. all passed task-run results are selected in `orderedTasks(taskGraph)` order;
2. missing result is excluded;
3. failed/blocked result is excluded;
4. passed result with null `final_commit_sha` or null `branch` is excluded;
5. if a dependency is excluded, dependent passed tasks are excluded transitively;
6. `diff_digest` from task-run result is not copied into the plan.

Use temp dirs and `writeTaskRunResult()` to create realistic `.agent/task-runs/{task_id}/result.json` files.

### Step 2: Implement helper

Implement `buildIntegrationPlan()` using:

- `orderedTasks(taskGraph)` from `src/scheduler/task-graph.ts`
- `readTaskRunResult()` from `src/scheduler/task-run-result.ts`

The returned plan should include only `task_id`, `branch`, `commit_sha`, `status: "passed"`, and exclusion metadata. Do not include `diff_digest`.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/unit/integration-plan.test.ts
```

---

## Task 2: Integration Runner

**Files:**

- Create: `src/orchestrator/integration-runner.ts`
- Create: `tests/integration/integration-runner.test.ts`

### Step 1: Write real-git tests first

Use temporary git repositories. Cover:

1. creates `integration/{run_id}` from `base_commit` and cherry-picks commits cleanly;
2. rerun skips already-applied commits and does not duplicate changes;
3. conflict writes `.agent/integration/conflict-report.md`, aborts cherry-pick, and leaves no unresolved conflict state;
4. existing integration branch not descended from `base_commit` returns blocked/state-conflict style result;
5. no automatic conflict-resolution command is used. Prefer asserting final repo state and no conflict markers remain after abort.

### Step 2: Implement runner

Implement `runIntegrationMerge()`:

- ensure `.agent/integration/` exists;
- write `integration-plan.json`;
- validate branch name;
- create or reuse `integration/{run_id}`;
- cherry-pick each task commit;
- write `cherry-pick-log.jsonl`;
- on conflict, collect conflicted paths, write `conflict-report.md`, abort cherry-pick, return `status: 'blocked'`.

Use existing `runGit` utilities where possible. Keep implementation small and explicit.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/integration/integration-runner.test.ts
```

---

## Task 3: Wave Loop Wiring

**Files:**

- Modify: `src/orchestrator/task-graph-wave-loop.ts`
- Modify: `tests/integration/task-graph-parallel-wave.test.ts`

### Step 1: Update the all-pass wave integration test

Change the existing all-pass wave test so it expects:

- result message mentions integration branch assembled, not “Proceed to Phase 8E”;
- `artifact_paths` includes `.agent/integration` evidence;
- `integration/{run_id}` exists;
- checking out or inspecting `integration/{run_id}` shows task files from all passed tasks;
- R1 still has `commit_sha === null`, `commit_skipped === true`, and skip reason says Final Aggregate Audit/final commit are deferred.

Keep the no-task-graph config-error test intact.

### Step 2: Wire implementation

In `runTaskGraphWaveLoop()` after all wave tasks pass:

1. call `buildIntegrationPlan()`;
2. if the plan has exclusions, write evidence and return BLOCKED for R1 fail-closed behavior;
3. call `runIntegrationMerge()`;
4. if blocked, transition BLOCKED and return `makeBlockedResult()`;
5. if passed, transition to PASSED with clear R1 messaging and no final commit/tag.

Do not call `runFinalization()` in R1.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/integration/task-graph-parallel-wave.test.ts tests/integration/integration-runner.test.ts tests/unit/integration-plan.test.ts
```

---

## Task 4: Full Validation

Run:

```bash
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
```

Then check forbidden changes:

```bash
git diff -- src/orchestrator/task-graph-loop.ts src/orchestrator/run-orchestrator.ts src/orchestrator/failure-guard.ts src/scheduler/failure-policy.ts review-loop.yaml prompts
```

Expected: no diff in forbidden files.

---

## Acceptance Checklist

- [ ] Integration plan selects passed task commits in DAG order.
- [ ] Exclusions are explicit and transitive.
- [ ] Integration branch is `integration/{run_id}` and starts from `base_commit`.
- [ ] Clean cherry-picks apply task files to the integration branch.
- [ ] Rerun skips already-applied commits.
- [ ] Conflict path writes conflict report, aborts cherry-pick, and BLOCKEDs.
- [ ] Wave all-pass path invokes integration instead of returning the old placeholder.
- [ ] No per-task `diff_digest` is used for integrated evidence.
- [ ] No Final Aggregate Audit/final project commit/tag in R1.
- [ ] Full gates pass.

---

## Review-Loop Request

Use this request when starting the plugin run:

```text
Implement Phase 8E R1 Integration Merge as one atomic module.

Authoritative docs:
- docs/superpowers/agent-task-planning-guidelines.md
- docs/phase-8e-integration-and-aggregate-audit.md
- docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-requirements.md
- docs/superpowers/specs/2026-06-20-phase-8e-r1-integration-merge-design.md
- docs/superpowers/plans/2026-06-20-phase-8e-r1-integration-merge.md

Do not split this into tiny file-level tasks. Keep it as a single atomic cross-file implementation task unless every split task can independently typecheck and pass targeted tests.

Scope:
- Create src/orchestrator/integration-plan.ts
- Create src/orchestrator/integration-runner.ts
- Modify src/orchestrator/task-graph-wave-loop.ts
- Create tests/unit/integration-plan.test.ts
- Create tests/integration/integration-runner.test.ts
- Modify tests/integration/task-graph-parallel-wave.test.ts
- Optional src/index.ts only if needed for exports

Non-goals:
- Do not run Final Aggregate Audit in R1.
- Do not create final project commit/tag in R1.
- Do not auto-resolve cherry-pick conflicts.
- Do not reuse per-task diff_digest as integrated evidence.
- Do not change provider/model routing, P6 retry/guard behavior, serial task-graph loop, or prompts.

Validation:
- npm run typecheck
- npm run lint -- --max-warnings 0
- npm run build
- npm test -- --run
```
