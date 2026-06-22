---
schema_version: 1
run_id: "20260622053529-cukmg2"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---

# Phase 9 R2C — Dashboard Cancel Button

## Summary

Implemented `POST /api/cancel` on the dashboard HTTP server plus a
`Cancel Run` button in the dashboard HTML. The route reuses the
existing cancel mechanism (`.agent/cancel-request.json` + best-effort
SIGTERM via `LockManager`) — no new cancel protocol.

## Changes

- `src/web/dashboard-server.ts`
  - Added `POST /api/cancel` handler, matched **before** the generic
    non-GET 405 path so `GET /api/cancel` correctly returns 405.
  - 409 when `state.json` is missing (no active run).
  - 409 when `state.phase` ∈ `{PASSED, FAILED, BLOCKED, CANCELLED}`.
  - 200 with `{ ok: true, message: 'cancel requested', run_id,
    requested_at }` on the happy path; writes `.agent/cancel-request.json`
    via `atomicWriteJSON` matching the `CancelRequest` type with
    `requested_by = "dashboard:<pid>"`.
  - Best-effort `process.kill(pid, 'SIGTERM')` when a lock file is
    present and the PID is alive; signal errors are swallowed so the
    cancel-request file remains the durable signal. Never blocks waiting
    for orchestrator exit.

- `src/web/dashboard-html.ts`
  - New `<button id="cancel-btn">` adjacent to the run id.
  - Three states: `Cancel Run` (enabled, active phase), `Cancelling…`
    (disabled, click in flight) and `Run ended` (disabled, terminal /
    unknown phase).
  - Click handler POSTs `/api/cancel`. Non-2xx responses clear the
    in-flight flag, surface the error via `textContent` only, and
    re-enable the button so the user can retry. No `innerHTML` writes
    of run-supplied strings.

- `tests/unit/dashboard-cancel.test.ts` (new)
  - 200 happy path + `cancel-request.json` written with
    `dashboard:<pid>` (fixture deliberately omits `run.lock` to skip
    the SIGTERM branch).
  - 409 when state.json is in a terminal phase (FAILED).
  - 409 when state.json is missing.
  - 405 on GET `/api/cancel`.

- `tests/unit/dashboard-html.test.ts`
  - Added assertions for the strings `cancel-btn`, `Cancel Run`,
    `Cancelling`, and `Run ended`.
  - Added assertion that the page POSTs to `/api/cancel`.

## Verification

- `npm test` → **94 files, 1263 tests passed**.
- Existing dashboard tests (`dashboard-html.test.ts`,
  `dashboard-server.test.ts`) still pass unchanged.
- No new npm dependencies added.

## Scope Notes

All changes confined to the four allowed paths. No modifications to
`src/cli/*`, `src/orchestrator/**`, the event store / bus, or
`review-loop.yaml`.
