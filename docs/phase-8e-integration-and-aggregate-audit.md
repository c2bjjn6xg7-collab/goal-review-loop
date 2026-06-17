# Phase 8E Requirement: Integration Merge And Aggregate Audit

> Status: Planned
> Scope: Goal Review Loop repository
> Priority: High
> Parent: `docs/phase-8d-worktree-parallel-execution.md`
> Depends on: Phase 8D (all tasks reach terminal status with branch + worktree + per-task artifacts recorded)
> Review Loop mode: one focused implementation run
> Created: 2026-06-17 (split out of Phase 8D after design review)

## 1. Purpose

Phase 8D produces per-task commits on isolated branches but explicitly does
**not** merge them. Phase 8E is the integration phase: it takes the set of
passed task commits, assembles them into a single integrated diff, runs a
fresh Final Aggregate Audit on **that integrated diff**, and only then creates
the project-level commit/tag.

The critical invariant this phase protects:

> **The Final Aggregate Auditor must audit the diff it is being asked to
> approve.** Per-task audits (Phase 8D) audited each task's diff in isolation.
> After cherry-pick the integrated diff is *not* identical to the union of
> per-task diffs: cherry-pick can shift context, rename detection can fire
> differently on the combined tree, and any conflict the user resolved
> manually (§5 — Phase 8E itself never auto-resolves) introduces hunks no
> per-task audit has seen. Therefore Phase 8E recomputes `diff_digest` from
> the integrated diff and never reuses a per-task `diff_digest` or
> audit-report as evidence for the integrated result.

This is the single highest-risk item in the 8-series (see design review
Q1.5). The whole phase is structured around not silently violating it.

```text
Phase 8D output: { task_id -> passed, branch, commit_sha } per task
  -> select passed tasks in DAG topological order
  -> cherry-pick each task commit onto integration branch
  -> on conflict: BLOCKED + conflict-report (no auto-resolve)
  -> recompute diff_digest from integration branch vs base_commit
  -> run integration scope guard (GOAL-level allowed_changes)
  -> run integration verification (GOAL-level commands)
  -> run Final Aggregate Auditor on the integrated diff
  -> only on PASS: create project commit + tag
```

## 2. In Scope

- Select the set of `passed` task commits from Phase 8D output.
- Assemble them in DAG topological order onto an integration branch.
- Detect and report cherry-pick conflicts; do **not** auto-resolve.
- Recompute `diff_digest` from the integrated diff (never reuse per-task digest).
- Run integration-level scope guard against GOAL `allowed_changes`.
- Run integration-level verification commands.
- Run a **fresh** Final Aggregate Audit on the integrated diff.
- Create the project-level commit and tag only on Final Audit PASS.
- Write integration evidence under `.agent/integration/`.

## 3. Out Of Scope

- Auto-resolving merge conflicts (any conflict → BLOCKED, user intervenes).
- Re-running per-task Developer/Auditor (Phase 8D's job).
- Pushing the integration commit to remote.
- Retrying a failed Final Audit by re-merging differently — if Final Audit
  fails, the run is BLOCKED; the user decides whether to drop a task and
  re-integrate, or rework a task in Phase 8D.
- Handling tasks that Phase 8D left `failed`/`blocked` — those are simply
  excluded from the integration set, and the user is told which tasks were
  excluded and why. Integration does not silently drop work.

## 4. Integration Order

Tasks are cherry-picked in **DAG topological order**, not wave order.

Wave index (Phase 8D §7.1) is a concurrency artifact, not a dependency
ordering. Two tasks may be in different waves purely because of
`allowed_changes` overlap (Q1.3) while having no real dependency; conversely
two tasks in the same wave always have no dependency between them. The
dependency truth lives in `depends_on`, so topological order is the correct
integration sequence.

If the topological sort is ambiguous (multiple valid orders), ties are broken
by `task_id` lexicographic order for determinism.

The integration branch is created from the same `base_commit` all Phase 8D
worktrees branched from:

```text
integration branch: integration/{run_id}
base: {base_commit}   # identical to Phase 8D worktree base
```

## 5. Cherry-Pick And Conflict Handling

For each task in topological order:

1. `git cherry-pick {task_commit_sha}` onto the integration branch.
2. If the cherry-pick applies cleanly → record the new SHA, continue.
3. If the cherry-pick conflicts → **abort the cherry-pick** (`git cherry-pick --abort`), write `.agent/conflict-report.md`, and BLOCKED the run. Do not attempt `git checkout --theirs`/`--ours` or any automated resolution.

`conflict-report.md` must include:

- run ID
- the two+ task IDs whose changes conflict
- their branch names and commit SHAs
- the conflicting file paths (from `git diff --name-only --diff-filter=U`)
- the conflict type (`cherry_pick_conflict`)
- recommended next action: "Inspect the conflict, resolve manually on the
  integration branch, then `review-loop resume`. Alternatively, drop one of
  the conflicting tasks and re-integrate."

**Why no auto-resolve:** review-loop's contract is "mechanically verifiable +
human/audit decides." Auto-merging conflict hunks is a Developer-class
decision (it produces code), not an orchestrator decision. An auto-resolved
hunk would enter the integrated diff with no human and no per-task audit
having seen it — exactly the diff_digest-invariant violation this phase
exists to prevent.

## 6. diff_digest Recomputation (The Core Invariant)

After all passed tasks are cherry-picked onto the integration branch, the
integrated diff is collected against `base_commit` using the existing
`collectDiff` (`src/git/diff-collector.ts`):

```ts
const integrationDiff = await collectDiff({
  projectRoot,
  baseCommit,            // same base all worktrees used
  iteration: integrationIteration,
});
const integrationDigest = `sha256:${integrationDiff.diffDigest}` as Digest;
```

Rules:

1. **`integrationDigest` is the only digest the Final Aggregate Auditor
   receives.** It is written to `state.json` `audited_diff_digest` and to
   `final-audit.md` `diff_digest`.
2. **No per-task `diff_digest` from Phase 8D may be reused** as the Final
   Audit's `diff_digest` — the digest must be recomputed from the integrated
   diff, even if only one task passed. The point is provenance, not value: a
   single clean cherry-pick with no rename *may* yield the same digest by
   coincidence, but the integration code path must still run `collectDiff`
   and must never read the per-task digest into the Final Audit input.
   (Renaming, context shifts, and multi-task combination usually make them
   differ; coincidence is tolerated, code reuse is not.)
3. The Final Aggregate Auditor's prompt must be told explicitly which hunks
   are "integration-only" (conflict resolutions, if any were manually applied
   between Phase 8D and this audit — there shouldn't be any in the auto path,
   but if the user manually resolved a conflict per §5, those hunks are
   flagged as "no per-task audit backing").

This rule is why Phase 8E exists as a separate phase: cramming integration
into Phase 8D would have let per-task PASS lull the Final Audit into trusting
a digest no audit had actually covered.

## 7. Integration Scope Guard

Before verification, run `checkScope` (`src/scope/scope-guard.ts`) with the
**GOAL-level** `allowed_changes`/`disallowed_changes`, not any task's:

```ts
const scopeResult = checkScope({
  allowedChanges: goalFm.allowed_changes,
  disallowedChanges: goalFm.disallowed_changes,
  changedFiles: integrationDiff.changedFiles,
  orchestratorOwnedFiles: finalOrchestratorOwned,
});
```

This mirrors the existing integration scope check in `task-graph-loop.ts`
(serial path, lines ~399-414). Any denied file → BLOCKED with
`SCOPE_VIOLATION`. This catches the case where two tasks each edited within
their own `allowed_changes`, but their union exceeds the GOAL's global scope.

## 8. Integration Verification

Run the GOAL's `verification_commands` (not per-task commands) against the
integrated workspace. This is the existing integration verification step in
`task-graph-loop.ts` (lines ~421-445). A failed required command → BLOCKED
with `VERIFICATION_FAILED`.

Per-task verification passing in Phase 8D does **not** imply integration
verification passes: tasks can each pass their scoped tests while the
combination breaks (e.g. two tasks each pass typecheck against a shared
interface they each modified compatibly-in-isolation but
incompatibly-together).

## 9. Final Aggregate Audit

Only after scope + verification pass, run the Final Aggregate Auditor on the
integrated diff. This reuses the existing finalization pipeline
(`runFinalization` in `run-orchestrator.ts`) but with two differences from
the serial Phase 8B path:

1. The `diff_digest` fed to the auditor is `integrationDigest` (§6), never a
   per-task digest.
2. The auditor prompt must include a section listing, per task, "this task's
   commit was cherry-picked from branch X; its per-task audit (if any) is at
   `.agent/task-runs/{task_id}/audit-report.md`; the diff you are auditing is
   the integrated result and may differ from the union of per-task diffs."

On Final Audit PASS → create project commit + tag (existing finalization
logic). On FAIL/BLOCKED → run is BLOCKED; the user decides whether to drop a
task and re-integrate or send a task back to Phase 8D for rework.

## 10. Partial Integration (Excluded Tasks)

If Phase 8D left some tasks `failed`/`blocked`, integration proceeds with
only the `passed` set **only if** no `passed` task `depends_on` an excluded
task. Otherwise:

- Any `passed` task transitively depending on an excluded task is itself
  excluded (it cannot be meaningfully integrated without its dependency).
- `.agent/integration/excluded-tasks.md` records every excluded task and why.
- The GOAL is marked PARTIAL — Final Audit can still run on the reduced set,
  but the run result must surface "N of M tasks integrated" prominently so
  the user does not mistake a partial PASS for a complete one.

The user can choose to BLOCKED instead of partial-integrate via config
`integration.require_all_passed: true` (default `false`).

## 11. Evidence And Artifacts

Written under `.agent/integration/`:

```text
.agent/integration/
  integration-plan.json        # ordered task list, SHAs, base_commit
  cherry-pick-log.jsonl        # per-task cherry-pick result (clean/conflict)
  conflict-report.md           # only on conflict
  changed-files.json           # integrated diff changed files
  diff-metadata.json           # integrated diff metadata
  scope-report.json            # GOAL-level scope result
  verification/manifest.json   # GOAL-level verification manifest
  excluded-tasks.md            # only if tasks excluded
```

All integration evidence is registered with the orchestrator file registry
(`OrchestratorFileRegistry`) so post-audit tampering is detected, matching
the existing Phase 8B pattern.

## 12. Resume

Resume must recover from:

- integration branch created, no tasks cherry-picked yet → restart cherry-pick sequence.
- some tasks cherry-picked, interrupted → continue from the last successfully applied task (idempotent: re-applying an already-applied commit is detected via the cherry-pick log and skipped).
- conflict written, user manually resolved on the branch → detect the manual resolution, continue from the next task.
- scope/verification done, Final Audit pending → rerun Final Audit only.
- Final Audit done, commit/tag pending → run finalization only.

Resume must not re-cherry-pick a task whose commit is already on the
integration branch (detect via `git branch --contains` or the cherry-pick
log).

## 13. Acceptance Criteria

Phase 8E is complete when:

1. After Phase 8D completes with all tasks `passed`, `review-loop resume`
   (or an explicit integrate command) assembles the integration branch.
2. Tasks are cherry-picked in DAG topological order, verified by a test with
   a known graph.
3. A clean cherry-pick sequence produces an integration branch whose diff
   against `base_commit` is collected and its `diff_digest` computed fresh.
4. **diff_digest invariant:** the `diff_digest` in `final-audit.md` equals
   the digest freshly computed from the integrated diff. It must be computed
   by `collectDiff` on the integration branch, **never copied** from a
   per-task `diff_digest`. The test asserts: (a) `final-audit.md` `diff_digest`
   == digest of `collectDiff(integration branch, base_commit)`; (b) the code
   path that would set `audited_diff_digest` from a per-task value does not
   exist (statically — grep the integration module for any read of
   `.agent/task-runs/*/` `diff_digest` into the Final Audit input). Note the
   freshly-computed digest *may* coincide with a per-task digest by accident
   (single clean task, no rename); coincidence is acceptable, code reuse is
   not — the invariant is about provenance, not value inequality.
5. A cherry-pick conflict writes `.agent/integration/conflict-report.md`,
   aborts the cherry-pick (`git cherry-pick --abort`), and leaves the run
   BLOCKED — no auto-resolution attempted.
6. Integration scope guard uses GOAL-level `allowed_changes`; a test where
   two tasks each pass their task scope but the union exceeds GOAL scope is
   caught here and BLOCKED.
7. Integration verification uses GOAL-level commands; a test where per-task
   verification passes but integration verification fails is caught and
   BLOCKED.
8. Final Aggregate Audit runs on the integrated diff with the fresh
   `diff_digest`; the auditor prompt explicitly references per-task audit
   paths and warns the integrated diff may differ.
9. Partial integration: with one `failed` task that nothing depends on,
   integration proceeds with the rest and `excluded-tasks.md` records the
   exclusion; the run result surfaces "N of M".
10. Partial integration: with one `failed` task that a `passed` task depends
    on, the dependent task is also excluded (transitive).
11. `integration.require_all_passed: true` BLOCKEDs the run if any task is
    not `passed`, instead of partial-integrating.
12. Resume from each interruption point in §12 is idempotent (no duplicate
    cherry-picks, no duplicate Final Audit).
13. All integration evidence is registered with the orchestrator file
    registry; post-write tampering is detected.
14. No `git push` or destructive git cleanup runs in this phase.
15. Engineering gates pass: `npm run typecheck`, `npm run lint`, `npm test`,
    `npm run build`, `npm audit --omit=dev`, `npm pack --dry-run`,
    `git diff --check`.

## 14. Relationship To Phase 8D

| Concern | Phase 8D | Phase 8E |
|---|---|---|
| Per-task branch + worktree | creates | consumes (read-only) |
| Per-task Developer/verification/audit | runs | does not rerun |
| Concurrency / waves | owns | n/a (sequential integration) |
| Failure escalation (1-C + 2-C) | owns | n/a |
| Cherry-pick / merge | explicitly out of scope | owns |
| `diff_digest` for Final Audit | per-task (own audits) | recomputed (integrated) |
| Final Aggregate Audit | out of scope | owns |
| Project commit + tag | out of scope | owns |

Phase 8E does not modify Phase 8D's behavior; it reads Phase 8D's
`.agent/task-runs/{task_id}/` output and the task graph.

## 15. Suggested Review Loop Request

```text
Implement Phase 8E according to docs/phase-8e-integration-and-aggregate-audit.md.
Treat that document as the source of truth. Implement integration branch
assembly in DAG topological order, cherry-pick with conflict-to-BLOCKED (no
auto-resolve), fresh diff_digest recomputation from the integrated diff,
GOAL-level scope and verification, and a fresh Final Aggregate Audit on the
integrated diff. Do not reuse any per-task diff_digest or audit-report as
evidence for the integrated result.
```
