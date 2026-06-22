---
schema_version: 1
run_id: "20260622110907-p3so08"
author_role: "planner"
---

# Phase 9 Observability Gaps — R11 next-action hint + R5/R12 artifact_refs

## Requirement Understanding

The user wants two low-risk observability patches to close spec gaps in Phase 9:

**R11 — next-action hint.** When a run is resumed or in flight, both
`review-loop status --watch` and the dashboard should show "what happens next"
for the current phase. The hint logic already exists as `computeNextStep` in
`src/cli/status.ts:371-406`, but only the non-watch status path calls it. The
watch path (`watchEventStream` → `renderTextSummary`) and the dashboard
(`DashboardEventSource.getSnapshot` + `dashboard-html.ts`) do not. The user
wants the logic extracted into a shared pure function and reused by all three
call sites, with no behavior change to the existing strings.

**R5/R12 — artifact_refs on existing events.** Several orchestrator emit
call sites are missing artifact references that are already on disk:

- `role.exited` for planner/developer/auditor/final-auditor — should carry a
  `transcript` ref pointing at `.agent/transcripts/iteration-NN-<role>.md`
  (the file `emitTranscript` writes one line above each `role.exited`).
- `audit.decision` (~line 1866) — payload should carry `finding_count`
  (number) and `rework_reason` (string, only when `decision !== 'PASS'`).
  The audit-report body is not structured, so `rework_reason` is a
  path-reference fallback per the spec.
- `run.completed` (PASSED, three sites in `runFinalization`) — should carry
  a `final-audit` artifact_ref at `.agent/final-audit.md`.
- `verification.completed` (~line 1533) — already has a `verification-log`
  ref; just needs an explicit test assertion.

The user explicitly excludes: the event schema (`EventDraft`/`ReviewLoopEvent`
already have `artifact_refs` and `payload`), `integration.*` events,
`review-loop.yaml`, task-graph/wave event details, and orchestrator
scheduling logic. No new dependencies.

## Current Project Status

Codebase explored; the relevant call sites are:

- `src/cli/status.ts:371-406` — `computeNextStep(phase, iteration, max)`. Pure
  function. Branches on `isTerminal(phase)` (PASSED/FAILED/BLOCKED/CANCELLED)
  then on the non-terminal phase. Used only by `executeStatus` at line 294.
- `src/cli/status.ts:171-207` — `renderTextSummary(events, json)`. Already
  derives `phase = terminalEv ? terminalEv.phase : last.phase`. This is where
  the watch path's `Next:` line belongs.
- `src/web/event-source.ts:41-46` — `DashboardSnapshot` interface
  (`run_id`, `current_phase`, `latest_events`, `artifacts`). Needs
  `next_action: string`.
- `src/web/event-source.ts:90-165` — `getSnapshot` (active path).
- `src/web/event-source.ts:172-193` — `buildSnapshot` (archive path).
- `src/web/dashboard-html.ts:46` — `Phase:` pill markup. The `Next:` line
  goes adjacent. `render(snapshot)` at line 118 sets `phaseEl` text; a new
  `nextActionEl` setter follows the same `setText` pattern.
- `src/orchestrator/run-orchestrator.ts` — four `role.exited` emit sites
  (planner ~752, developer ~1350, auditor ~1769, final-auditor ~2673), one
  `audit.decision` site (~1866), three PASSED `emitRunTerminal` sites in
  `runFinalization` (~2455, ~2825, ~3007), and the existing
  `verification.completed` ref at ~1533.
- `src/orchestrator/run-orchestrator.ts:3429-3456` — `emitTranscript` already
  uses the path `.agent/transcripts/iteration-${NN}-${role}.md` with
  `String(iteration).padStart(2, '0')`. The new `transcript` artifact_ref
  must reuse this exact convention.
- `src/agents/auditor-adapter.ts:235-242` — `AuditorValidationResult` has
  `errors: string[]` and `decision`. `errors.length` is the only structured
  finding count available at `audit.decision` emit time.
- Existing tests: `tests/integration/orchestrator-events.test.ts` already
  drives a full PASSED run and asserts event kinds; it is the natural place
  to add artifact_ref assertions. `tests/unit/event-source.test.ts` already
  seeds events and asserts snapshot fields. `tests/integration/status-watch.test.ts`
  covers `watchEventStream`.

## Technical Approach

**Shared next-action module.** Create `src/runtime/next-action.ts`
exporting `computeNextAction(phase, iteration, maxIterations)`. Move the
body of `computeNextStep` there verbatim, including the `isTerminal` import
from `src/orchestrator/state-machine.js`. `status.ts` imports it; the local
function is deleted. `event-source.ts` imports it for snapshot population.
Keeping the module under `src/runtime/` matches the existing
`src/runtime/` location of `event-store.ts` and avoids a new top-level
directory.

**Watch path.** `renderTextSummary` already computes `phase`. Add a small
derivation of `iteration`/`max_iterations` from the latest `role.started` or
`role.exited` event (these events don't currently carry iteration on the
event itself, but `lastRoleStarted` is already captured; if iteration isn't
on the event, pass 0/0 — `computeNextAction` still returns a meaningful
phase-based message). Print `Next: <hint>` on the line after `Phase:`.

**Dashboard snapshot.** Add `next_action: string` to `DashboardSnapshot`.
Populate in both `getSnapshot` (active path) and `buildSnapshot` (archive
path) via `computeNextAction(currentPhase, iter, max)`. Empty-events
snapshots return `next_action: ''`.

**Dashboard HTML.** Add `<div>Next: <span id="next-action">…</span></div>`
after the `Phase:` line. Wire `nextActionEl` in the script and set its text
in `render(snapshot)`. No `innerHTML` (existing tests assert this).

**Orchestrator artifact_refs.** At each of the four `role.exited` sites,
build the transcript path from the in-scope `iteration` (planner uses 0)
and add `artifact_refs: [{ type: 'transcript', path: transcriptPath }]`
(merged with any existing refs — none of the four sites currently has one).
At the `audit.decision` site, extend `payload` to include `finding_count:
auditValidation.errors.length` and conditionally `rework_reason:
'.agent/audit-report.md'` when `decision !== 'PASS'`. At the three PASSED
`emitRunTerminal` sites, append `{ type: 'final-audit', path:
'.agent/final-audit.md' }` to the existing `artifact_refs` array.

**Tests.** New `tests/unit/next-action.test.ts` exercises every branch.
Extend `tests/unit/event-source.test.ts` with `next_action` assertions.
Extend `tests/integration/status-watch.test.ts` with a `Next:` line
assertion. Extend `tests/integration/orchestrator-events.test.ts` with
artifact_ref and payload assertions on the four event kinds.

## Work Breakdown

The work splits into two independently-verifiable modules. They touch
disjoint source files (task-1: `src/runtime/`, `src/cli/status.ts`,
`src/web/`; task-2: `src/orchestrator/run-orchestrator.ts`) and can be
landed in either order. Each task's `npm test` runs the full suite, so
cross-module regressions are caught regardless of order.

- **task-1 — R11 next-action hint.** Create `src/runtime/next-action.ts`,
  rewire `src/cli/status.ts` (import + delete local `computeNextStep` +
  `renderTextSummary` `Next:` line), add `next_action` to
  `DashboardSnapshot` and populate it in `event-source.ts`, render it in
  `dashboard-html.ts`. New `tests/unit/next-action.test.ts`; extend
  `tests/unit/event-source.test.ts` and `tests/integration/status-watch.test.ts`.
  Verification: `npm test` (covers typecheck-free unit + integration).
- **task-2 — R5/R12 artifact_refs.** In `src/orchestrator/run-orchestrator.ts`,
  add `transcript` artifact_ref to the four `role.exited` emits, extend
  `audit.decision` payload with `finding_count` + conditional
  `rework_reason`, and add `final-audit` artifact_ref to the three PASSED
  `emitRunTerminal` sites. Extend
  `tests/integration/orchestrator-events.test.ts` with the corresponding
  assertions (including a `verification-log` assertion on
  `verification.completed`). Verification: `npm test`.

No separate integration task is needed: the two modules have no compile
coupling, and `npm test` already runs the full integration suite
(including `orchestrator-events.test.ts` which exercises the whole
pipeline end-to-end) for each task.

## Risks

- **Watch-path iteration derivation.** `role.started`/`role.exited` events
  do not currently carry `iteration` on the event object. The fallback
  (pass 0/0 to `computeNextAction`) yields the terminal/unknown-phase
  branch for terminal phases and the non-terminal message with `0/0`
  interpolation for live phases. This is acceptable — the hint is still
  useful — but the iteration number will be missing from the watch `Next:`
  line. Mitigation: document the fallback in the code comment; do not
  expand the event schema (out of scope). *Risk: low.*
- **`audit.decision` `finding_count` semantics.** `auditValidation.errors`
  are *mechanical* check failures, not auditor-emitted findings. The
  audit-report body has unstructured findings prose. The spec explicitly
  allows the path-reference fallback for `rework_reason`, and
  `finding_count = errors.length` is the only structured count available
  without parsing markdown. Mitigation: name the field `finding_count`
  (per spec) and document in a comment that it reflects mechanical-check
  findings; `rework_reason` carries the audit-report path for human
  follow-up. *Risk: low.*
- **Three PASSED emit sites.** The three `emitRunTerminal` calls in
  `runFinalization` (~2455, ~2825, ~3007) are easy to miss. Mitigation:
  the integration test asserts `run.completed` PASSED has a `final-audit`
  ref, which fails if any path that actually executes in the test omits
  it. The commit-exists path (~2455) only fires on resume with an existing
  commit and may not be exercised by the default test — call this out in
  the task description so the Developer applies the edit to all three
  sites uniformly. *Risk: low.*
- **`computeNextStep` relocation regression.** Any typo in moving the
  function body changes user-facing strings and breaks existing status
  tests. Mitigation: the move is verbatim; success criterion 1 requires
  byte-for-byte equivalence; existing status tests guard the non-watch
  path. *Risk: low.*
- **Dashboard HTML `innerHTML` invariant.** Existing
  `tests/unit/dashboard-html.test.ts` asserts no `innerHTML` use. The new
  `Next:` line must use `setText`/`createTextNode`. Mitigation: success
  criterion 5 calls this out; the existing test will fail otherwise. *Risk:
  low.*

```ReviewLoopRequest
type: risk_note
origin_agent: planner
priority: medium
message: iteration/max not present on role.started/role.exited events
target: planner
question: The watch path and dashboard snapshot cannot derive iteration/max from the event stream today (events don't carry iteration). Should we (a) pass 0/0 and accept that the live-phase hint omits the iteration number, or (b) add iteration to role.started/role.exited events (schema change, out of scope per Non-Goals)? The plan defaults to (a) per the user's "不要改事件 schema" constraint.
blocking: false
```
