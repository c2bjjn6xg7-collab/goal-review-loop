# Phase 8D Pre-Concurrency: Consecutive Failure Guard

## Why this is in scope before Phase 9 routing

The orchestrator currently has exactly one safeguard against runaway iteration:
`config.loop.max_iterations` (capped at 10). When a task graph or a single goal
gets stuck in a flaky loop — Auditor BLOCK every round, Developer empty-response
every retry, infra error every attempt — the loop will still consume the full
budget before stopping.

That waste matters most under two conditions Phase 9 will introduce:

1. **Cost-aware model routing.** Premium worker calls are expensive. A single
   stuck task should not burn three premium iterations before we notice.
2. **Concurrent task execution (Phase 8C/8D).** With multiple tasks running in
   parallel, the blast radius of a runaway task multiplies.

A small, deterministic counter that stops the loop early when the same kind of
failure repeats N times closes that gap. It is roughly two parameters and one
counter — small enough to ship without disturbing the state machine.

## Stock Audit

Audit date: 2026-06-17

Current main HEAD: `333c040`

### What already exists

- `config.loop.max_iterations` — 1..10 cap on total iterations per goal.
- `config.loop.stop_on_infrastructure_error` — boolean kill-switch on infra
  errors only.
- One-shot Developer retry on `AGENT_ERROR` inside a single iteration
  (`run-orchestrator.ts` ~ line 932).
- Per-task `iterations` counter inside `task-results.json`.

### What is missing

- No counter for "same failure class N times in a row".
- No counter for "agent CLI invocation retry budget".
- No early-exit reason in `state.json.last_error` distinguishing "iteration
  budget exhausted" from "consecutive failure threshold tripped".

## Objective

Add a deterministic guard that stops a run early when the same failure class
repeats more than a configured threshold, and cap how many times a single agent
CLI invocation may be retried within one iteration.

This is **not** a behavior overhaul. It is two new config keys, one new state
field, and an early-exit branch in the existing loop.

## Success Criteria

1. New config keys under `config.loop`:
   - `max_consecutive_failures` — integer, range 1..10, default 3.
   - `max_agent_retries` — integer, range 1..10, default 2.
   Both keys are optional. If absent, defaults apply. JSON schema in
   `src/artifacts/config.ts` is updated to accept them.

2. A `consecutive_failure_count` field is added to `state.json` runtime state.
   It is reset to 0 on any iteration that produces a passing Auditor decision
   or a passing per-task result. It increments by 1 on every iteration that
   ends in BLOCKED for one of the tracked failure classes (see #4).

3. When `consecutive_failure_count >= max_consecutive_failures`, the orchestrator
   exits early into `BLOCKED` with `last_error.code =
   "CONSECUTIVE_FAILURE_LIMIT"` and a message naming the threshold and the
   repeated failure class.

4. Tracked failure classes are exactly:
   - Auditor decision = BLOCK
   - Developer reported `status: BLOCKED` in handoff
   - Verification command failure
   - Infrastructure / `AGENT_ERROR`
   Other terminal phases (PASSED, CANCELLED, manual abort) reset the counter.

5. The single-iteration Developer retry loop respects `max_agent_retries`
   instead of the current hard-coded `1`. Retry attempts are logged with
   `developer retry N` as today.

6. `state.json` schema includes the new field. Resume restores it. CLI
   `status` and `progress.md` surface the current count and threshold when
   non-zero.

7. Task-graph mode treats the counter as **per-run, not per-task**. A single
   task failing once and a different task failing once in the next iteration
   together count as 2 toward the threshold. Rationale: routing escalation
   in Phase 9 should react to systemic flakiness, not one stubborn task.

8. Behavior unchanged when the new keys are at default and no consecutive
   failures occur. All 767 existing tests must still pass without
   modification.

## Non-Goals

- Do not change `max_iterations` semantics or its 1..10 cap.
- Do not introduce per-task counters or per-agent counters. One run-wide counter
  only.
- Do not introduce automatic model escalation. Phase 9 owns routing.
- Do not introduce backoff timers, jittered retry, or exponential delay. The
  retry shape stays as today.
- Do not change `last_error` structure beyond adding the new code constant.
- Do not change CLI flags. Configuration is YAML-only for this phase.

## Constraints

- `allowed_changes`:
  - `src/types.ts` — add `consecutive_failure_count`, `max_consecutive_failures`,
    `max_agent_retries`, and the new error code constant
  - `src/artifacts/config.ts` — schema and default config
  - `src/orchestrator/run-orchestrator.ts` — counter increment, early exit,
    retry budget plumbing
  - `src/orchestrator/state-store.ts` — whitelist new field for persistence
  - `src/cli/status.ts` and `src/runtime/progress-writer.ts` — surface counter
    when > 0
  - `tests/**` — new unit tests for counter logic, schema, resume
  - `docs/configuration.md` — document the two new keys with examples

- `disallowed_changes`:
  - `.git/**`
  - `.agent/state.json`, `.agent/GOAL.md`, `.agent/audit-report.md`,
    `.agent/final-audit.md`, `.agent/plan.md`
  - `prompts/**` — agent contracts unchanged
  - `src/scheduler/task-graph.ts` — schema unaffected
  - Any provider/network code

- No new dependencies.

## Verification Commands

All gates required:

1. `npm run typecheck`
2. `npm run lint`
3. `npm run build`
4. `npm test` — all 767 existing tests must still pass; new tests added for
   counter behavior must also pass
5. `git diff --check`

## Test Coverage Required

New unit tests must cover:

1. Counter increments on Auditor BLOCK across iterations.
2. Counter resets to 0 on any iteration that reaches PASS.
3. Early exit fires at exactly `max_consecutive_failures` and not before.
4. Default values apply when keys are absent.
5. Schema rejects values outside 1..10.
6. Resume from BLOCKED with non-zero counter restores the count and threshold.
7. `max_agent_retries = 1` produces exactly one retry attempt, not two.
8. Task-graph mode: failures across different tasks accumulate into one
   run-wide counter.

At least one integration test must drive the orchestrator through three
consecutive Auditor BLOCKs with `max_consecutive_failures = 3` and verify the
run terminates with `last_error.code = "CONSECUTIVE_FAILURE_LIMIT"`.

## Risks

- **Counter drift on resume.** If `consecutive_failure_count` is not in the
  state-store whitelist, resume will silently zero it and let the loop run
  past the threshold. Mitigation: explicit unit test on resume.
- **Class collapse.** Treating Developer BLOCKED and Auditor BLOCK as the
  same class hides distinct failure modes. We deliberately do that here for
  simplicity; Phase 9 routing can split classes if it needs to escalate
  differently per failure mode.
- **Interaction with single-iteration Developer retry.** The existing one-shot
  AGENT_ERROR retry happens *within* an iteration. The new counter increments
  *between* iterations. Both must coexist without double-counting.

## Suggested Approach

1. Add the two config keys with defaults, then verify the existing test suite
   still passes.
2. Add `consecutive_failure_count` to the state schema and state-store
   whitelist.
3. Wrap the existing iteration end-of-loop transitions in a single helper that
   classifies the outcome and updates the counter.
4. Add the early-exit branch right before the next iteration starts.
5. Replace the hard-coded `1` retry with `config.loop.max_agent_retries`.
6. Add unit tests, then the integration test.
7. Document in `docs/configuration.md`.

## Behavioral Equivalence Checklist

Before declaring success, the developer must confirm:

- [ ] Default config produces byte-identical behavior to current main on the
      Phase 8B integration tests.
- [ ] `state.json` shape change is additive only.
- [ ] Resume from any pre-existing state file (no counter field) defaults the
      counter to 0 cleanly.
- [ ] CLI `status` output unchanged when counter is 0.
- [ ] `progress.md` output unchanged when counter is 0.
- [ ] Final commit message template untouched.

## Definition of Done

- All 5 verification gates pass.
- All 8 listed unit-test scenarios plus the integration test added and green.
- `docs/configuration.md` shows the two new keys with realistic examples.
- A user with no YAML changes sees zero behavior difference.
- Phase 9 routing work can read `consecutive_failure_count` and the failure
  class without further plumbing.
