---
schema_version: 1
run_id: "20260622053529-cukmg2"
author_role: "planner"
---

# Phase 9 R2C — Dashboard Cancel Button

## Requirement Understanding

The user wants to extend the read-only Phase 9 dashboard (R2A, polling
`/api/events`; R2B, SSE bridge at `/api/events/stream`) with a single
operational control: a **Cancel Run** button.

Key constraints derived from the request:

- Only the **cancel** action is in scope. Resume / retry are explicitly
  out of scope because they would require restarting the orchestrator
  process, which lives outside the dashboard HTTP server.
- The HTTP endpoint must **reuse the existing cancel mechanism** already
  used by `review-loop cancel` (the CLI). No new cancel protocol.
- The button must reflect run state: disabled in terminal phases, enabled
  while the run is in progress, and shown as `Cancelling…` after the
  user clicks until the phase transitions to `CANCELLED`.
- Basic safety: the POST endpoint must verify there is an active run
  (state.json exists, phase is non-terminal) before writing the cancel
  request. Otherwise return `409 Conflict`.
- Tests are mandatory at the HTTP route level.
- R2A read-only routes (`GET /`, `GET /api/events`) and R2B SSE route
  (`GET /api/events/stream`) must remain functional.
- Do not touch event-store / event-bus / orchestrator (R1 territory),
  do not modify `review-loop.yaml`, do not modify `src/cli/status.ts`.

## Current Project Status

- Base commit: `bee382d5ea92369cc921991e412996105e640d9e` (main).
- Dashboard server: `src/web/dashboard-server.ts` exposes `GET /` and
  `GET /api/events`, bound to `127.0.0.1`. The handler currently treats
  any non-GET method as `405`. R2C will need to add `POST /api/cancel`
  to the routing table before the method check.
- Dashboard HTML: `src/web/dashboard-html.ts` polls `/api/events` every
  2s and renders the snapshot. It already exposes the run id and the
  current phase in dedicated DOM elements — R2C will add a button
  adjacent to the run id node.
- Event source: `src/web/event-source.ts` returns a snapshot with
  `run_id` and `current_phase`. It already classifies terminal phases
  (`run.completed`, `run.blocked`, `run.failed`). The dashboard treats
  any of `PASSED / FAILED / BLOCKED / CANCELLED` as terminal.
- Existing cancel mechanism in `src/cli/cancel.ts`:
  1. Read state, refuse if phase ∈ `{PASSED, FAILED, BLOCKED, CANCELLED}`.
  2. Read lock to get orchestrator PID.
  3. Write `.agent/cancel-request.json` via `atomicWriteJSON`.
  4. Send `SIGTERM` to the PID and wait for grace period (config).
  The orchestrator polls the cancel-request file on every iteration and
  transitions to `CANCELLED` itself.
- R2B (SSE bridge) lives on branch `agent/20260622043223-giis2q-...` and
  is not yet merged into `main` at the base commit. R2C is written so
  its HTML works regardless of whether snapshots arrive via polling
  (R2A) or SSE (R2B) — both populate the same `render()` snapshot. If
  R2B is merged before R2C lands, no additional wiring is needed.
- Tests live in `tests/unit/dashboard-server.test.ts` and
  `tests/unit/dashboard-html.test.ts`. R2C will add a focused test file
  for the cancel route.

## Technical Approach

### 1. New POST /api/cancel route

Add a `POST /api/cancel` branch to the dashboard server's request
handler, **before** the `method !== 'GET'` rejection. It must:

1. Reject any method other than `POST` on `/api/cancel` with `405`.
2. Read `.agent/state.json`. If missing, return `409 Conflict` with
   `{ error: 'no_active_run', ... }`.
3. If `state.phase ∈ TERMINAL_PHASES`, return `409 Conflict` with
   `{ error: 'run_terminal', phase, ... }`.
4. Otherwise, write `.agent/cancel-request.json` using the same
   `CancelRequest` shape from `src/types.ts` and the same
   `atomicWriteJSON` helper used by `src/cli/cancel.ts`. `requested_by`
   should be `dashboard:${pid}` so the audit trail distinguishes the
   dashboard source.
5. If a lock file is present and its PID is alive, attempt
   `process.kill(pid, 'SIGTERM')` to mirror the CLI behaviour. Do **not**
   block waiting for the process to exit — the dashboard route returns
   immediately.
6. Return `200 OK` with `{ ok: true, message: 'cancel requested',
   run_id, requested_at }`.

Reuse:

- `StateStore` from `src/orchestrator/state-store.js`.
- `LockManager` from `src/runtime/lock-manager.js`.
- `atomicWriteJSON` from `src/runtime/atomic-file.js`.
- `CancelRequest` type from `src/types.js`.

This deliberately mirrors `executeCancel` in `src/cli/cancel.ts` but
without the grace-period wait, so the HTTP request finishes quickly.

### 2. Dashboard HTML — Cancel button

Add a `<button id="cancel-btn" type="button">` next to the run id in the
`<header>` block. The script section will:

- Maintain a small client-side `cancelling` flag set on click.
- On render, update the button:
  - If `current_phase` ∈ `{PASSED, FAILED, BLOCKED, CANCELLED}` →
    disabled, label `Run ended`, clear `cancelling`.
  - Else if `cancelling` is true → disabled, label `Cancelling…`.
  - Else → enabled, label `Cancel Run`.
- On click:
  - Disable button immediately, set `cancelling = true`, label
    `Cancelling…`.
  - `fetch('/api/cancel', { method: 'POST' })`. On non-2xx response,
    revert `cancelling = false`, surface the error message in a small
    inline status element under the button (no `innerHTML` — text only).
- The `cancelling` flag is cleared whenever a snapshot reports a
  terminal phase, which is the documented success signal.

All DOM updates use `textContent` only (consistent with R2A's
XSS-conscious style).

### 3. Tests

Add `tests/unit/dashboard-cancel.test.ts` that boots the dashboard
server against a temporary `.agent` directory:

- **Happy path**: state.json with a non-terminal phase (e.g.
  `EXECUTING_DEVELOPER`) → POST returns 200, `.agent/cancel-request.json`
  is created with the right `run_id`, response body is
  `{ ok: true, message: 'cancel requested', ... }`. No real process is
  signalled because no lock file is present.
- **Terminal phase**: state.json with phase `PASSED` → POST returns 409,
  no `cancel-request.json` is written.
- **No active run**: `.agent/state.json` missing → POST returns 409,
  no `cancel-request.json` is written.
- **Wrong method**: `GET /api/cancel` → 405.

Also add a small assertion to `tests/unit/dashboard-html.test.ts` that
the rendered HTML contains a Cancel button element id (`cancel-btn`)
and the strings `Cancel Run`, `Cancelling…`, `Run ended` so the UI
contract is locked in.

### 4. Out of scope (explicit)

- No resume button. No retry button. No WebSocket.
- No edits to event-store, event-bus, orchestrator, run-orchestrator,
  task-graph-loop, review-loop.yaml, or `src/cli/status.ts`.
- No change to the cancel protocol — only an HTTP wrapper around the
  existing one.

## Work Breakdown

This is intentionally a **single atomic task**. Per
`docs/superpowers/agent-task-planning-guidelines.md`, source + adjacent
tests for a route should land together; splitting the route, HTML, and
tests into separate Developer rounds would leave the repo in a state
where either the server returns 404 for a button the UI exposes, or the
button is hidden behind a working route. One task keeps typecheck and
tests green at each commit boundary.

Scope of the task:

- `src/web/dashboard-server.ts` — add `POST /api/cancel` handler.
- `src/web/dashboard-html.ts` — add Cancel button and click handler.
- `tests/unit/dashboard-cancel.test.ts` — new file with the four cases
  above.
- `tests/unit/dashboard-html.test.ts` — add UI contract assertion.

## Risks

1. **Race with terminal-state transitions.** Between the phase check and
   writing the cancel request, the run could enter a terminal phase.
   Re-reading state in the route is sufficient; if a benign race causes
   a cancel request to be written for a just-terminated run, the
   orchestrator simply will not act on it (it stops polling on terminal
   exit). This matches the CLI behaviour.
2. **R2B not yet merged at base commit.** The user request says R2B is
   in place; the base commit is on `main` where R2B is still on a
   feature branch. R2C is designed to work whether the dashboard data
   source is the R2A poller or the R2B SSE stream — both push the same
   snapshot shape into the same `render()` function. The Cancel button
   does not depend on `/api/events/stream`.
3. **SIGTERM in tests.** Tests run inside the same node process. We
   must not signal a real PID. The test fixtures will omit `run.lock`,
   which causes the route to skip the kill attempt — the same path the
   CLI takes when no lock is present.
4. **HTML injection.** Phase / run id strings come from `events.jsonl`
   and `state.json`. All DOM updates already use `textContent`; the
   Cancel button must continue this discipline.
5. **Method routing regression.** Adding `POST /api/cancel` requires
   handling it before the generic `method !== 'GET'` rejection. The
   `405` response must still hold for unsupported method/path
   combinations elsewhere (e.g. `POST /api/events` → 405). The route
   test covers wrong method on `/api/cancel`; the existing
   dashboard-server test covers other paths.
