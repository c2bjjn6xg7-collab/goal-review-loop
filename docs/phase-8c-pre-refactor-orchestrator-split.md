# Phase 8C Pre-Refactor: Split run-orchestrator.ts

## Why this is a prerequisite, not a nice-to-have

Phase 8B merged `runTaskGraphLoop` into `src/orchestrator/run-orchestrator.ts`. The file is now 3412 lines and holds two execution paths in a single namespace:

- Single-task path: `runIterationLoop` (~ lines 690-1500)
- Task-graph path: `runTaskGraphLoop` (~ lines 2821-3300)
- Shared helpers: state transitions, lock handling, finalization, archive, file registry, scope/diff helpers

Phase 8C will add task-level concurrency (multiple Developers running in parallel against a task graph). Phase 8D will add per-task worktree/branch isolation. Both phases must touch state machine, scope, finalization, and archive logic. If they ship into the current 3412-line file, three concrete things break down:

1. **PR diffs become unreviewable.** A concurrency PR will edit hundreds of lines scattered across both execution paths and shared helpers. Reviewers cannot cleanly tell which lines belong to the new concurrency logic versus incidental changes to the sequential path. Edge cases get missed.

2. **Cross-path regressions.** Adding `if (parallel)` branches inside shared helpers means a refactor in the concurrency path can silently change sequential-path behavior. The blast radius of every commit grows with the file.

3. **Test granularity collapses.** Today `task-graph.test.ts` validates the schema and topology in isolation, but the loop itself can only be exercised through the full orchestrator entry point. Once concurrency lands, narrow unit tests for scheduler decisions become impossible without spinning up the entire orchestrator.

This is not premature abstraction. It is a forced move: Phase 8C cannot land cleanly without it.

## Stock Audit

Audit date: 2026-06-17

Current main HEAD: `fd7c71a` (Phase 8B merged)

### Concrete file metrics

- `src/orchestrator/run-orchestrator.ts` — 3412 lines
- `src/scheduler/task-graph.ts` — 263 lines (validation + topo only)

### Top-level functions inside run-orchestrator.ts

- `runOrchestrator` (entry point)
- `runIterationLoop` — single-task loop
- `runTaskGraphLoop` — task-graph loop
- `runFinalization` — commit + final audit + tag
- `verifySystemProtectedPaths`
- `registerAgentLogs`, `registerDirectoryFiles`
- `buildTaskChangedFiles`

Each of these will be touched by Phase 8C/8D. Splitting now keeps each PR's blast radius bounded.

## Objective

Extract `runTaskGraphLoop` and its task-graph-specific helpers into a dedicated module so the orchestrator entry stays a thin dispatcher and the task-graph path becomes independently reviewable and testable.

This is a **pure relocation refactor**. No behavior change. No new feature. No new public API beyond what's already exported.

## Success Criteria

1. New file `src/orchestrator/task-graph-loop.ts` exists and exports `runTaskGraphLoop` plus any helpers exclusively used by the task-graph path (e.g. `buildTaskChangedFiles` if not used elsewhere).
2. `src/orchestrator/run-orchestrator.ts` imports `runTaskGraphLoop` from the new module and contains zero inline implementation of the task-graph loop body.
3. `runOrchestrator` retains the existing dispatch logic: single-task GOAL still routes to `runIterationLoop` in `run-orchestrator.ts`; task-graph GOAL routes to the imported `runTaskGraphLoop`.
4. Shared helpers (state machine, lock, archive, scope guard wrappers) remain in `run-orchestrator.ts` if they are used by both paths. If a helper is used only by the task-graph path, move it.
5. `run-orchestrator.ts` line count drops below 2800 (adjusted: runFinalization is a ~700-line shared helper called by both runIterationLoop and runTaskGraphLoop, so it must remain in run-orchestrator.ts per criterion 4).
6. `task-graph-loop.ts` line count is between 400 and 900 (the existing implementation is roughly 480 lines).
7. No public type or runtime behavior changes. `state.json` schema, `progress.json` schema, CLI flags, and resume semantics are byte-identical to current main.
8. All existing tests pass without modification: `tests/unit/task-graph.test.ts`, `tests/unit/task-prompt-builder.test.ts`, `tests/integration/task-graph.test.ts`, plus full suite.

## Non-Goals

- Do not change any orchestration logic, retry policy, scope rules, or state transitions.
- Do not introduce concurrency, worktrees, or worker pools (those are Phase 8C/8D).
- Do not rename existing exported symbols. Internal helpers may be renamed only if their visibility actually changes.
- Do not split `runIterationLoop`. It is out of scope for this refactor.
- Do not modify `task-graph.ts` (validation/topo module). It already lives in `src/scheduler/`.

## Constraints

- `allowed_changes`:
  - `src/orchestrator/run-orchestrator.ts`
  - `src/orchestrator/task-graph-loop.ts` (new)
  - Test files only if an import path break forces it
- `disallowed_changes`:
  - `.git/**`
  - `.agent/state.json`, `.agent/GOAL.md`, `.agent/audit-report.md`, `.agent/final-audit.md`, `.agent/plan.md`
  - `src/types.ts` — type surface must not change
  - `src/scheduler/task-graph.ts` — schema/validator must not change
  - `prompts/**` — prompt contracts unchanged
- Imports between the two files use ESM relative paths (`./task-graph-loop.js`).
- No new dependencies.

## Verification Commands

All gates required:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run build`
4. `npm test` — all 767 tests must still pass
5. `git diff --check`

## Risks

- **Hidden coupling between loops.** If `runIterationLoop` and `runTaskGraphLoop` share more state or helpers than the obvious ones, extraction may surface circular imports. Mitigation: keep shared helpers in `run-orchestrator.ts` and import them into `task-graph-loop.ts`, never the reverse.
- **State-store integration.** Both loops mutate `task_graph_state` and stage status. The state-store API itself is shared and lives in `src/orchestrator/state-store.ts`, so this should not require changes there. If it does, that's a signal the split is being done at the wrong seam.
- **Test imports.** Integration tests currently import only `runOrchestrator`. They should not need updates. If they do, the entry-point dispatch is broken.

## Behavioral Equivalence Checklist

Before declaring success, the developer must confirm:

- [ ] `runOrchestrator` entry signature unchanged
- [ ] State transitions for task-graph path unchanged
- [ ] `progress.json` and `progress.md` outputs unchanged for task-graph runs
- [ ] BLOCKED → resume from failed task index still works (covered by existing integration test)
- [ ] Single-task path completely untouched in behavior
- [ ] No new files in `.agent/` artifact set
- [ ] Final commit message template unchanged

## Suggested Approach

1. Create `src/orchestrator/task-graph-loop.ts` with the function signature copied verbatim.
2. Move the function body. Resolve imports by adding them to the new file.
3. In `run-orchestrator.ts`, replace the function body with a re-export or thin call to the imported function. Verify `runOrchestrator` dispatch still hits the new import.
4. Move `buildTaskChangedFiles` only if grep confirms it is task-graph-only.
5. Run typecheck after each step. Do not batch the move with logic edits.
6. Run full test suite. If any test fails, the move is not yet behavior-preserving.

## Definition of Done

- All 5 verification gates pass
- `run-orchestrator.ts` is under 2800 lines (runFinalization is shared, cannot be moved)
- `task-graph-loop.ts` is between 400 and 900 lines
- Auditor confirms no behavior change against the behavioral equivalence checklist
- Phase 8C concurrency work can begin against the new module without further restructuring
