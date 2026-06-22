# Phase 9 Dogfood Lessons and Milestone Record

> Date: 2026-06-22
> Status: Milestone — Phase 9 R1/R2 complete, R3 not started
> Specs: `2026-06-21-phase-9-review-loop-observability-design.md`, `-requirements.md`

## What shipped

Phase 9 added a structured event layer and an interactive dashboard to `review-loop`. The scheduler remains a strict pipeline; the UI reads events and triggers the existing cancel mechanism — it does not own scheduling.

### Tags

| Tag | Scope | Implemented by |
|---|---|---|
| `phase-9-r1-reviewed` | EventStore, EventBus, orchestrator lifecycle events, `status --watch` (text + json) | hand-written + 2 review passes |
| `phase-9-r2a-reviewed` | Read-only web dashboard (HTML + 2s polling) | review-loop (claude planner/developer + codex auditor) |
| `phase-9-r2b-reviewed` | SSE real-time push (`GET /api/events/stream`, hello + heartbeat + polling) | review-loop |
| `phase-9-r2c-reviewed` | Cancel action button (`POST /api/cancel`, reuses `cancel-request.json` + SIGTERM) | review-loop |

R2A/R2B/R2C were each produced end-to-end by review-loop driving real `claude` and `codex` agents — the system dogfooding itself. The human role was: write the request, observe via the just-built event stream, do independent verification, and run two review passes per slice.

### Test scale

- Baseline before Phase 9: ~1193 tests.
- After R1 merge: 1233.
- After R2C merge: **1269 tests, all passing.** Zero regressions at each merge.

## Dogfood bugs found and fixed

Three bugs were invisible in unit/integration tests and only surfaced when review-loop ran against itself with real agents. This is the core value of dogfooding: real load exposes seams that synthetic tests miss.

### 1. Cross-run event stream contamination

**Symptom:** A fresh run after a previous run showed two `run.started` events with different `run_id` values.

**Root cause:** `EventStore` writes to a fixed path `.agent/events.jsonl` regardless of `run_id`. A previous run's events persisted; the new run appended to the same file.

**Fix:** `EventStore.archivePreviousRun()` moves any existing `events.jsonl` belonging to a different `run_id` to `.agent/history/events-<runId>.jsonl` before a fresh run emits its first event. Resume (same `run_id`) is untouched.

**Lesson:** Append-only history across runs is ambiguous. Isolate per-run.

### 2. Task-graph integration auditor missing events

**Symptom:** Task-graph runs only showed 3 roles (planner, developer, final-auditor) in the event stream. The integration Auditor (codex) ran and produced `audit-report.md`, but no `role.started` / `role.exited` / `audit.decision` events were emitted.

**Root cause:** R1 event wiring covered the serial iteration-loop auditor (`run-orchestrator.ts`) but missed the task-graph integration auditor (`task-graph-loop.ts`).

**Fix:** Added identical wiring: `role.started` before `runAgent`, `role.exited` after transcript, `audit.decision` after report registration, `provider.failure` on the failure path.

**Lesson:** When two code paths implement the same role, event wiring must be kept equivalent. A review checklist item: "did you wire events in every path that invokes this role?"

### 3. Stale-terminal-event selection (R2A + R1 status --watch)

**Symptom:** A resumed run's append-only history (`run.blocked → run.resumed → run.completed`) caused both `status --watch` and the dashboard to report `BLOCKED` instead of the final `PASSED`.

**Root cause:** Both consumers used `find()` (first match) to locate the terminal event, picking the stale `run.blocked`.

**Fix:** Use `reverse().find()` to pick the *last* terminal event. This bug appeared independently in two places (hand-written `status.ts` and review-loop-written `event-source.ts`), confirming it is a recurring pattern trap.

**Lesson:** Append-only + resume means terminal events can be superseded. Always select the last terminal event, never the first.

## Design guardrails for future Phase 9 work

These are rules derived from the dogfood bugs above. Future R3+ work must follow them.

1. **Per-run isolation is mandatory.** Never read or write `events.jsonl` without respecting `run_id`. The active file belongs to the current run; archived files in `.agent/history/` are historical. Any consumer that ignores `run_id` will mix runs.

2. **Use the last terminal event, not the first.** Any code that derives "current phase" from the event stream must pick the last event whose kind is in `{run.completed, run.blocked, run.failed}`. A resumed history legitimately contains superseded terminal events.

3. **Keep serial and task-graph event wiring equivalent.** Every role invocation — planner, developer, auditor, final-auditor — must emit the same set of events regardless of which orchestrator path invokes it. When adding a new emit point, grep for all call sites of that role across both `run-orchestrator.ts` and `task-graph-*.ts`.

4. **Dashboard/UI features consume events; they do not parse raw files.** All event reading goes through `EventStore` (`readAll`, `readSince`, `getLastSequence`). Direct file reads bypass the malformed-line tolerance and run-isolation logic. Do not re-implement JSONL parsing in UI code.

5. **Action buttons reuse existing mechanisms.** R2C's cancel button did not invent a new cancel protocol — it writes the same `.agent/cancel-request.json` the CLI SIGTERM handler uses. Future action buttons (resume, retry) must likewise delegate to existing orchestrator entry points, not create parallel control paths.

## What R3 should build

The event layer now supports: live view (polling + SSE), cancel, and per-run isolation with archive. The missing piece is **run selection** — the dashboard can only show the current run. An operator who wants to inspect a past run (archived in `.agent/history/`) has no entry point.

R3 priority: **historical run browser / multi-run management.**

Likely scope:
- Enumerate runs from `.agent/history/events-*.jsonl` + active `events.jsonl`.
- `GET /api/runs` listing run_id, phase, started_at, event count.
- Dashboard run switcher (select which run's events to display).
- Do not build JSON-RPC or complex multi-run orchestration yet.
