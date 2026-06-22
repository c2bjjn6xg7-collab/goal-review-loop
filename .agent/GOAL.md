---
schema_version: 1
run_id: "20260622110907-p3so08"
goal_id: "phase-9-obs-gaps-r11-r5-r12"
title: "Phase 9 Observability Gaps — R11 next-action hint + R5/R12 artifact_refs"
allowed_changes:
  - "src/runtime/next-action.ts"
  - "src/cli/status.ts"
  - "src/web/event-source.ts"
  - "src/web/dashboard-html.ts"
  - "src/orchestrator/run-orchestrator.ts"
  - "tests/unit/next-action.test.ts"
  - "tests/unit/event-source.test.ts"
  - "tests/integration/status-watch.test.ts"
  - "tests/integration/orchestrator-events.test.ts"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
  - "src/runtime/event-store.ts"
  - "src/runtime/event-bus.ts"
  - "review-loop.yaml"
  - "package.json"
  - "package-lock.json"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
  - id: "typecheck"
    command: ["npm", "run", "typecheck"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "lint"
    command: ["npm", "run", "lint"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "build"
    command: ["npm", "run", "build"]
    cwd: "."
    required: true
    timeout_seconds: 300
---

# Objective

Close two Phase 9 observability gaps in a single run:

1. **R11 next-action hint** — surface "what happens next" in both `review-loop status --watch` text output and the dashboard UI, driven by one shared pure function so the logic is not duplicated across `status.ts` and `event-source.ts`.
2. **R5/R12 artifact_refs** — attach transcript, final-audit, and audit-decision metadata to existing `eventBus.emit(...)` call sites in the orchestrator without changing event semantics or the event schema.

# Success Criteria

1. New module `src/runtime/next-action.ts` exports a pure function
   `computeNextAction(phase: string, iteration: number, maxIterations: number): string`
   whose logic is byte-for-byte the same as the current `computeNextStep` in
   `src/cli/status.ts:371-406` — same phase → message mapping, same terminal-phase
   handling via `isTerminal` from `src/orchestrator/state-machine.js`, same
   iteration/max interpolation. No behavior change, only relocation.

2. `src/cli/status.ts` imports `computeNextAction` from the new module and the
   local `computeNextStep` is deleted. `executeStatus` calls `computeNextAction`
   to populate `next_step`. Non-watch `review-loop status` behavior is unchanged.

3. `watchEventStream`'s `renderTextSummary` in `src/cli/status.ts` calls
   `computeNextAction` using the derived current phase (the same `terminalEv ?
   terminalEv.phase : last.phase` value already computed) plus the best
   iteration/max available from the event stream (look at the latest
   `role.started`/`role.exited` event's context; if none, pass 0/0 so the
   function returns the terminal or unknown-phase branch). It prints a
   `Next: <hint>` line immediately below the `Phase:` line. JSON-mode watch
   output is unchanged (still one JSON event per line).

4. `DashboardSnapshot` in `src/web/event-source.ts` gains a `next_action: string`
   field. Both the active path in `getSnapshot` and the helper `buildSnapshot`
   populate it by calling `computeNextAction(currentPhase, iteration, maxIterations)`.
   Iteration/max are derived best-effort from the event stream (latest
   `role.started`/`role.exited` if available, else 0/0). When no events exist,
   `next_action` is the empty string.

5. The dashboard HTML in `src/web/dashboard-html.ts` renders
   `Next: <next_action>` adjacent to the `Phase:` pill (e.g. a new
   `<div>Next: <span id="next-action">…</span></div>`), updated in
   `render(snapshot)` via `setText`. No `innerHTML` is used anywhere in the
   change.

6. `role.exited` events for planner, developer, auditor, and final-auditor in
   `src/orchestrator/run-orchestrator.ts` carry a `transcript` artifact_ref
   with path `.agent/transcripts/iteration-NN-<role>.md` where `NN` is
   `String(iteration).padStart(2, '0')` and `<role>` is the literal role string
   ('planner', 'developer', 'auditor', 'final-auditor'). For planner,
   iteration is 0 → `iteration-00-planner.md`. The path is constructed with
   the same iteration/role values already passed to `emitTranscript` at the
   adjacent call site.

7. `audit.decision` event payload in `src/orchestrator/run-orchestrator.ts`
   (~line 1866) includes:
   - `finding_count`: number, = `auditValidation.errors.length` (the only
     structured finding count available at emit time).
   - `rework_reason`: string, `'.agent/audit-report.md'`, present only when
     `decision !== 'PASS'` (path-reference fallback per spec, because audit
     findings are not structured in the audit-report front matter).

8. `run.completed` (PASSED) terminal emits at the three sites in
   `runFinalization` — commit-skipped path (~line 2825), commit-exists path
   (~line 2455), and committed path (~line 3007) — include
   `{ type: 'final-audit', path: '.agent/final-audit.md' }` in their
   `artifact_refs` array (in addition to the existing entries).

9. `verification.completed` event (~line 1526) already has a `verification-log`
   artifact_ref at ~line 1533. Confirm it remains and add an explicit
   assertion in tests.

10. New unit test file `tests/unit/next-action.test.ts` covers: each
    non-terminal phase (INITIALIZING, PLANNING, DEVELOPING, REWORKING,
    VERIFYING, AUDITING, FINALIZING) returns the expected message with
    iteration/max interpolation; each terminal phase (PASSED, FAILED,
    BLOCKED, CANCELLED) returns the expected terminal message; an unknown
    phase returns 'Unknown phase.'; iteration and max_iterations are
    interpolated into the DEVELOPING/REWORKING/VERIFYING/AUDITING messages.

11. `tests/unit/event-source.test.ts` is extended to assert the snapshot
    includes a `next_action` string field for at least one seeded phase (e.g.
    PLANNING) and that it is non-empty when events exist; and that it is the
    empty string when no events exist.

12. `tests/integration/status-watch.test.ts` is extended to assert the watch
    text summary contains a line starting with `Next:`.

13. `tests/integration/orchestrator-events.test.ts` is extended to assert:
    - At least one `role.exited` event has a `transcript` artifact_ref whose
      path matches `/^\.agent\/transcripts\/iteration-\d{2}-(planner|developer|auditor|final-auditor)\.md$/`.
    - The `audit.decision` event payload has a numeric `finding_count`.
    - When the run PASSED, the `audit.decision` `decision` is PASS and
      `rework_reason` is absent; a separate seeded FAIL run asserts
      `rework_reason === '.agent/audit-report.md'` is present. (If seeding a
      FAIL run is impractical in this test file, at minimum assert
      `finding_count` is a number on every `audit.decision` event and that
      `rework_reason` is a string when present.)
    - The `run.completed` PASSED event has a `final-audit` artifact_ref
      pointing at `.agent/final-audit.md`.
    - The `verification.completed` event has a `verification-log`
      artifact_ref.

14. No new npm dependencies. `npm run typecheck`, `npm run lint --max-warnings=0`,
    `npm run build`, and `npm test` all pass with zero errors and zero warnings.

# Non-Goals

- Do NOT change the `EventDraft` / `ReviewLoopEvent` schema in
  `src/runtime/event-store.ts`. The `artifact_refs` and `payload` fields
  already exist — use them as-is.
- Do NOT touch `integration.*` events (separate task scope).
- Do NOT modify `review-loop.yaml`, `package.json`, or `package-lock.json`.
- Do NOT touch task-graph/wave event details (worker branch, `task.*` /
  `wave.*` events) — that is a separate task.
- Do NOT change orchestrator scheduling logic. The only orchestrator edits
  are adding fields to existing `eventBus.emit({ ... })` calls.
- Do NOT change the existing `computeNextStep` message text — only relocate
  it. User-facing strings stay identical so existing status tests pass.
- Do NOT add `next_action` to `StatusOutput` (the JSON status object). It
  already has `next_step`. The dashboard snapshot is a separate surface.
- Do NOT modify `src/runtime/event-store.ts` or `src/runtime/event-bus.ts`.

# Constraints

- TypeScript, ESM, reuse existing build (`tsc`).
- No new npm dependencies.
- Follow existing code patterns: `EventDraft` for emits, `ArtifactRef` for
  refs, `isTerminal` from `src/orchestrator/state-machine.js` for terminal
  phase checks.
- Transcript path format MUST match `emitTranscript`'s existing convention
  (see `src/orchestrator/run-orchestrator.ts:3449`):
  `.agent/transcripts/iteration-${NN}-${role}.md` where `NN` is
  `String(iteration).padStart(2, '0')` and `role` is the literal role string.
  For planner, iteration is 0 → `iteration-00-planner.md`.
- All four verification commands must pass with zero errors and zero warnings.
