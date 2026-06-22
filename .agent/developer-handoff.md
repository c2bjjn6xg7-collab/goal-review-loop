---
schema_version: 1
run_id: "20260622020433-0g30a6"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---

# Phase 9 R2A — Read-only Dashboard

Implemented the read-only Phase 9 R2A web dashboard end-to-end.

## Files added

- `src/web/event-source.ts` — `DashboardEventSource` builds a snapshot
  (`run_id`, `current_phase`, `latest_events`, `artifacts`) by reusing
  `EventStore.readAll()`. Prefers `run_id` from `state.json` when present
  and falls back to `"unknown"`. Gracefully handles missing `.agent` or
  `events.jsonl` (returns empty snapshot, no throw). `latest_events` is
  truncated to the most recent `MAX_LATEST_EVENTS = 20`, sorted by `seq`
  ascending. `current_phase` is taken from the first terminal event
  (`run.completed|blocked|failed`) when present, otherwise the last event.
  Artifacts are deduped by `type:path`, keeping the first label seen.
- `src/web/dashboard-html.ts` — `renderDashboardHtml()` returns the inline
  HTML page. The client uses `fetch('/api/events', …)` + `setInterval(…,
  2000)` and renders all dynamic fields via `textContent` /
  `document.createTextNode` only (no `innerHTML`).
- `src/web/dashboard-server.ts` — `createDashboardServer({ projectRoot })`
  returns `{ start, stop, port }`. Server is built on `node:http`, bound
  to `127.0.0.1` only. Routes: `GET /` → HTML 200; `GET /api/events` →
  JSON snapshot 200; any other path → 404 JSON; non-GET → 405 JSON.
  `start(port=0)` returns the actual listening port; `stop()` closes the
  listener so further requests are refused.
- `src/cli/dashboard.ts` — `createDashboardCommand()` registers the
  Commander subcommand with `--port` (default 0) and `--project-root`
  (default `process.cwd()`). On start it prints
  `Dashboard listening on http://127.0.0.1:<port>` and wires
  SIGINT/SIGTERM to call `server.stop()` before exit.
- `tests/unit/event-source.test.ts`,
  `tests/unit/dashboard-html.test.ts`,
  `tests/unit/dashboard-server.test.ts` — vitest unit coverage for:
  - HTML 200 + `text/html; charset=utf-8` + key tokens.
  - `/api/events` happy path, sort order, and 20-event truncation.
  - Graceful degrade when `.agent` and/or `events.jsonl` are missing.
  - 404 JSON for unknown paths; 405 JSON for non-GET methods.
  - Artifact dedupe & label preservation, `state.json` `run_id` precedence.
  - `stop()` closes the listener so a fresh request fails.

## Files modified

- `src/cli/index.ts` — added
  `program.addCommand(createDashboardCommand())` and the matching import.
  No other change.

## Constraints respected

- No npm dependencies added (`package.json` unchanged).
- No new code paths write to `.agent/` — server, event source, CLI, and
  the new tests perform reads only (tests seed events in `os.tmpdir()`).
- `src/runtime/event-store.ts`, `src/runtime/event-bus.ts`,
  `src/cli/status.ts`, and `review-loop.yaml` are untouched.
- Only paths in `allowed_changes` were modified.

## Verification

All required commands pass locally on this branch:

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm test` — 91 test files / 1253 tests pass.

Additionally, `node dist/cli/main.js dashboard --help` prints the new
subcommand with `--port` and `--project-root` options and the read-only
description, satisfying success criterion #1.
