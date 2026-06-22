---
schema_version: 1
run_id: "20260622053529-cukmg2"
goal_id: "phase-9-r2c-dashboard-cancel-button"
title: "Phase 9 R2C — Dashboard Cancel Button (POST /api/cancel + UI)"
allowed_changes:
  - "src/web/dashboard-server.ts"
  - "src/web/dashboard-html.ts"
  - "tests/unit/dashboard-cancel.test.ts"
  - "tests/unit/dashboard-html.test.ts"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
  - "src/cli/status.ts"
  - "src/cli/cancel.ts"
  - "review-loop.yaml"
  - "src/orchestrator/**"
  - "src/runtime/event-store.ts"
  - "src/runtime/event-bus.ts"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Objective

Add a single operational control — a **Cancel Run** button — to the
Phase 9 dashboard, backed by a new `POST /api/cancel` HTTP route on the
dashboard server. The route must reuse the existing cancel mechanism
(`.agent/cancel-request.json` + SIGTERM to the orchestrator PID via the
existing `LockManager`), not invent a new cancel protocol. The button
must reflect run state in real time and disable itself when the run
reaches a terminal phase.

# Success Criteria

1. `src/web/dashboard-server.ts` exposes `POST /api/cancel`. The route
   is matched **before** the generic `method !== 'GET'` rejection.
   Sending `GET /api/cancel` returns HTTP `405` with a JSON error.
2. `POST /api/cancel` returns **`409 Conflict`** with a JSON error body
   when `.agent/state.json` is missing (no active run). No
   `cancel-request.json` is written.
3. `POST /api/cancel` returns **`409 Conflict`** with a JSON error body
   when `state.phase` is in `{PASSED, FAILED, BLOCKED, CANCELLED}`. No
   `cancel-request.json` is written.
4. `POST /api/cancel` returns **`200 OK`** with body
   `{ ok: true, message: "cancel requested", run_id, requested_at }`
   when the run is active. A `.agent/cancel-request.json` file is
   written matching the `CancelRequest` schema in `src/types.ts`
   (`schema_version`, `run_id`, `requested_at`, `requested_by`).
   `requested_by` is the string `dashboard:<pid>`.
5. The route reuses these existing modules (no reimplementation of
   cancel logic):
   - `StateStore` from `src/orchestrator/state-store.ts`
   - `LockManager` from `src/runtime/lock-manager.ts`
   - `atomicWriteJSON` from `src/runtime/atomic-file.ts`
   - `CancelRequest` type from `src/types.ts`
6. If a lock file is present and the PID is alive, the route attempts
   `process.kill(pid, 'SIGTERM')`. If sending the signal throws, the
   route still returns `200 OK` (the cancel-request file is the
   durable signal). The route does **not** block waiting for the
   orchestrator to exit.
7. `src/web/dashboard-html.ts` renders a `<button id="cancel-btn">`
   adjacent to the run id in the header:
   - When `current_phase` ∈ `{PASSED, FAILED, BLOCKED, CANCELLED}`
     (or `unknown`) the button is disabled with label `Run ended`.
   - Otherwise, with no cancel in flight, the button is enabled with
     label `Cancel Run`.
   - After click, the button is immediately disabled and labelled
     `Cancelling…` until a snapshot reports a terminal phase, at which
     point it transitions to the `Run ended` disabled state.
   - On a non-2xx response from `POST /api/cancel`, the in-flight flag
     is cleared so the user can retry, and the error is shown via
     `textContent` only (no `innerHTML` of server-supplied strings).
8. The existing routes (`GET /`, `GET /api/events`, and, when present,
   `GET /api/events/stream`) and their existing tests continue to pass.
9. A new test file `tests/unit/dashboard-cancel.test.ts` exercises the
   POST route end-to-end against the real HTTP server (no mocks of
   `node:http`) with four cases:
   - 200 happy path + `cancel-request.json` written
   - 409 when state.json shows a terminal phase
   - 409 when state.json is missing
   - 405 when method is GET on `/api/cancel`
10. `tests/unit/dashboard-html.test.ts` asserts that the rendered HTML
    contains the strings `cancel-btn`, `Cancel Run`, `Cancelling`, and
    `Run ended`.
11. `npm test` passes from the repository root.
12. No new runtime npm dependencies are added to `package.json`.

# Non-Goals

- No resume button. No retry button. No WebSocket transport.
- No changes to the event store, event bus, orchestrator, task-graph
  loop, run orchestrator, or `review-loop.yaml`.
- No changes to `src/cli/status.ts` or `src/cli/cancel.ts`.
- No new cancel protocol — only an HTTP wrapper around the existing
  `cancel-request.json` + SIGTERM flow.
- No authentication / authorization (server is bound to `127.0.0.1`).

# Constraints

- TypeScript only; reuse existing build (`tsconfig.json`, `vitest`).
- Server stays bound to `127.0.0.1` (do not change the bind host).
- All DOM updates in `dashboard-html.ts` must use `textContent`. Do
  **not** add `innerHTML` writes of user/run-supplied strings.
- Do not introduce new top-level npm dependencies.
- Do not block the HTTP request handler waiting for SIGTERM / process
  exit — return promptly after writing the cancel-request file.
- Tests must not signal real orchestrator PIDs. The happy-path test
  fixture should not write a `run.lock` file so the route's
  SIGTERM-attempt branch is skipped, matching the CLI behaviour when
  no lock is present.
- All file paths in `allowed_changes` are relative to the repository
  root; no `..` or absolute paths.
