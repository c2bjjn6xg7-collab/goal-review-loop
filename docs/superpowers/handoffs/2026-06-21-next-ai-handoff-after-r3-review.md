# Next AI Handoff After Phase 8E R3 Review

Date: 2026-06-21
Repository: `/Users/dengyidong/Desktop/cc劳工系统`
Current branch: `agent/20260621080825-3ppz47-phase-8e-r3-finalization`
Latest commit: `a66bbe2 fix(phase-8e): resume blocked r3 finalization`

## Current State

The repository is clean at the time of this handoff.

Latest known status command:

```bash
git status --short --branch
```

Expected output:

```text
## agent/20260621080825-3ppz47-phase-8e-r3-finalization
```

Latest commit:

```text
a66bbe2 fix(phase-8e): resume blocked r3 finalization
```

Phase 8E R3 finalization was implemented, hardened, reviewed, fixed, and re-reviewed. The latest Codex review found no discrete introduced correctness issues.

Review report path from the last run:

```text
/tmp/phase-8e-r3-blocked-resume-codex-review.md
```

Review result:

```text
I did not identify any discrete, introduced correctness issues in the R3 blocked-resume changes. The updated paths are covered by the added integration tests and the full test suite passes.
```

## What Was Just Fixed

The latest fix made Phase 8E R3 finalization resume correctly after a pre-commit `BLOCKED` state.

Key behavior now covered:

- R3 finalization blockers are marked with `Phase 8E R3 finalization BLOCKED`.
- Top-level task-graph resume routes marked R3 blockers back into R3 finalization.
- Tag retry resumes still work when `final_commit_sha` exists but tag creation failed.
- R2 integrated audit blockers are not misclassified as R3 finalization blockers.
- `BLOCKED` R3 finalization can force-transition back to `FINALIZING` before retrying.
- R3 success paths clear `last_error`.

Main touched files in the latest commit:

- `src/orchestrator/integration-finalizer.ts`
- `src/orchestrator/run-orchestrator.ts`
- `src/orchestrator/task-graph-wave-loop.ts`
- `tests/integration/integration-finalizer.test.ts`

## Validation Already Run

These checks passed before this handoff:

```bash
npm test -- --run tests/integration/integration-finalizer.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
npm test -- --run
git diff --check
```

The final full test run passed:

```text
Test Files  81 passed (81)
Tests       1193 passed (1193)
```

One earlier full-suite run had a transient timeout in `tests/integration/cli-pack.test.ts`; a single-file rerun passed, and the later full-suite rerun also passed.

## Phase Completion Assessment

Phase 8E is effectively complete through R3:

- R1 integration merge: implemented.
- R2 integrated verification and Final Aggregate Audit: implemented.
- R3 finalization commit/tag: implemented.
- R3 blocked-resume tail issue: fixed and re-reviewed.

Phase 9 has been specified and is the next implementation phase.

Relevant Phase 9 documents:

- `docs/superpowers/specs/2026-06-21-phase-9-review-loop-observability-requirements.md`
- `docs/superpowers/specs/2026-06-21-phase-9-review-loop-observability-design.md`
- `docs/superpowers/plans/2026-06-21-phase-9-r1-event-stream-and-watch.md`

## Next Recommended Work

Start Phase 9 R1: durable event stream and watch UI.

The first slice should not attempt the full visual web dashboard. Build the foundation that a later dashboard will consume:

1. Add `.agent/events.jsonl` as an append-only durable event stream.
2. Add `EventStore` and `EventBus`.
3. Emit high-signal run, phase, role, verification, task/wave, integration, audit, finalization, and provider failure events.
4. Add `review-loop status --watch`.
5. Add `review-loop status --watch --json`.

Suggested first implementation order:

1. Create `src/runtime/event-store.ts` with unit tests.
2. Create `src/runtime/event-bus.ts` with unit tests.
3. Wire low-risk lifecycle events in `src/orchestrator/run-orchestrator.ts`.
4. Wire agent subprocess and verification command events.
5. Wire task graph, integration audit, and finalizer events.
6. Implement status watch CLI.
7. Add integration coverage for watch behavior.

## Critical Boundaries

Do not change scheduling semantics while doing Phase 9 R1.

Preserve these invariants:

- `.agent/state.json` remains authoritative for resume.
- The event stream is observability only.
- The event stream must not weaken scope guard, diff digest, verification, Auditor, Final Auditor, or commit/tag gates.
- Existing runs without `.agent/events.jsonl` must still resume.
- Large logs should stay in artifacts; events should link to them through artifact refs.
- Do not expose raw private chain-of-thought. Show visible output, decisions, reasoning summaries, assumptions, evidence, and progress notes instead.
- Provider quota failures should become visible structured events so users can understand repeated resumes and avoid wasting quota.

## Hermes Deck Comparison Context

The user previously provided a comparison with Hermes Deck.

The conclusion already captured in Phase 9 docs:

- Do borrow Hermes-style live event visibility and session/run observability.
- Do not convert `review-loop` into chat-driven scheduling.
- The review-loop value is the fixed auditable pipeline:
  `Planner -> Developer -> Verify -> Auditor -> Final Auditor -> Finalize`.
- A later phase may add optional second-opinion delegation, but Phase 9 R1 is not that phase.

## Plugin And YAML Context

This repository is the plugin/tool implementation repository.

`review-loop.yaml` is configuration for running the review loop in a project. Other repositories that want to use the tool need their own config, but the software implementation changes happen here.

Recent provider-routing context:

- Planner was changed to run through `claude -p` via `review-loop.yaml`.
- Developer already uses Claude.
- Auditor and Final Auditor intentionally remain Codex as review/final safety gates.
- Do not switch Auditor or Final Auditor to Claude unless the user explicitly changes that strategy.

## Recommended Startup Commands For The Next AI

Run these first:

```bash
git status --short --branch
git log --oneline -5
sed -n '1,240p' docs/superpowers/plans/2026-06-21-phase-9-r1-event-stream-and-watch.md
sed -n '1,260p' docs/superpowers/specs/2026-06-21-phase-9-review-loop-observability-requirements.md
sed -n '1,260p' docs/superpowers/specs/2026-06-21-phase-9-review-loop-observability-design.md
```

Before editing Phase 9 code, inspect the current modules:

```bash
sed -n '1,220p' src/cli/status.ts
sed -n '1,260p' src/runtime/process-runner.ts
sed -n '1,220p' src/verification/verification-runner.ts
sed -n '1,260p' src/orchestrator/run-orchestrator.ts
sed -n '1,220p' src/orchestrator/task-graph-wave-loop.ts
```

Use `rg` to locate existing subprocess, transcript, progress, and status helpers before adding new abstractions.

## Suggested Verification For Phase 9 R1

At minimum, run targeted tests as each slice lands:

```bash
npm test -- --run tests/unit/event-store.test.ts
npm test -- --run tests/unit/event-bus.test.ts tests/unit/event-store.test.ts
npm test -- --run tests/integration/status-watch.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
git diff --check
```

Before final handoff or commit, run:

```bash
npm test -- --run
npm run build
```

If full-suite concurrency produces a timeout in `tests/integration/cli-pack.test.ts`, rerun that file alone once to distinguish a transient timeout from a real regression.

## Suggested Commit Strategy

Keep Phase 9 R1 in small commits:

1. `feat(phase-9): add event store`
2. `feat(phase-9): add event bus`
3. `feat(phase-9): emit lifecycle events`
4. `feat(phase-9): add status watch`

If the user wants one atomic commit instead, use:

```text
feat(phase-9): add review loop event stream and watch
```

## Human-Friendly Summary

The next job is not to revisit Phase 8E unless a regression appears. Phase 8E R3 passed review. Move forward into Phase 9 R1 and make the review loop observable: durable events first, terminal watch second, web dashboard later.
