---
schema_version: 1
run_id: "20260622043223-giis2q"
goal_id: "phase-9-r2b-sse-realtime"
title: "Phase 9 R2B — SSE realtime push for the dashboard"
allowed_changes:
  - "src/web/**"
  - "tests/unit/dashboard-server-sse.test.ts"
  - "tests/unit/dashboard-server.test.ts"
  - "tests/unit/dashboard-html.test.ts"
  - "tests/unit/event-source.test.ts"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
  - "src/runtime/event-store.ts"
  - "src/runtime/event-bus.ts"
  - "src/orchestrator/**"
  - "src/cli/status.ts"
  - "review-loop.yaml"
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
---

# Objective

Add a Server-Sent Events push channel to the read-only dashboard delivered in Phase 9 R2A
so clients receive new `events.jsonl` entries within ~500 ms instead of waiting up to 2 s
for the next poll. Keep the existing JSON snapshot endpoint and 2 s polling path intact as
a fallback.

# Success Criteria

1. `GET /api/events/stream` is served by `src/web/dashboard-server.ts` with response
   headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, and
   `Connection: keep-alive`. The response is not buffered as a single body; bytes are
   flushed as they are written.
2. On connect, the stream's first non-comment frame is `event: hello\ndata: {"run_id":"<value>"}\n\n`
   where `<value>` is the run id resolved from `.agent/state.json` (falling back to
   `"unknown"` if missing), matching the existing snapshot behavior.
3. Whenever a new line is appended to `.agent/events.jsonl` (detected by polling
   `EventStore.readSince(lastSeq)` at the configured interval, default 500 ms), the
   server writes `data: <json>\n\n` for each new event, in `seq` order, exactly once per
   event per connection.
4. The server writes a heartbeat line `: heartbeat\n\n` at the configured interval
   (default 15 000 ms) for the lifetime of every open SSE connection.
5. When the client disconnects (`req` `close` event), the server clears both the poll
   interval and the heartbeat interval for that connection and removes it from the active
   connection set. No timers remain referenced for closed connections.
6. `DashboardServer.stop()` proactively ends any active SSE responses before awaiting
   `server.close()` and resolves within 1 s in tests (proves no SSE socket holds the close
   open).
7. `src/web/dashboard-html.ts` attempts `new EventSource('/api/events/stream')` on load.
   On a `hello` frame and on each `message`, the page is updated. Polling
   (`setInterval(tick, 2000)`) does **not** run while the SSE channel is open. If
   `EventSource` is undefined or `onerror` fires, the page falls back to the 2 s poll and
   the SSE listener is closed.
8. `GET /api/events` continues to return the same JSON snapshot it returned in R2A; all
   pre-existing tests in `tests/unit/dashboard-server.test.ts`, `tests/unit/dashboard-html.test.ts`,
   and `tests/unit/event-source.test.ts` still pass without modification of their
   assertions (apart from new assertions added for R2B).
9. A new file `tests/unit/dashboard-server-sse.test.ts` exists and asserts, against a real
   server started on an ephemeral port with reduced timing (e.g. `ssePollMs: 30`,
   `sseHeartbeatMs: 80`):
   - the `hello` frame is received,
   - an event appended to `.agent/events.jsonl` after the connection is open is delivered
     as `data: { ...seq, ...kind, ... }\n\n`,
   - at least one `: heartbeat\n\n` line is received within ~500 ms,
   - tearing down the client request and calling `server.stop()` completes promptly
     (e.g. resolves within 1 second).
10. `npm run typecheck` and `npm test` both succeed.
11. No new runtime npm dependencies are introduced (no changes to `package.json`
    `dependencies`). Only `node:http`, `node:fs`, `fs-extra` (already a dependency), and
    existing modules may be used. The browser side may rely only on built-in
    `EventSource`.

# Non-Goals

- No WebSocket transport.
- No JSON-RPC layer.
- No action buttons (cancel / resume / retry). Those are R2C scope.
- No changes to event production: `src/runtime/event-store.ts`, `src/runtime/event-bus.ts`,
  the orchestrator, and `review-loop.yaml` are out of scope.
- No changes to `src/cli/status.ts`.
- No `fs.watch` based detection. Polling `readSince` is the required mechanism.
- No catch-up replay of historical events on connect. The stream starts at the current
  tail (`getLastSequence()`); historical events are still available via the existing
  `/api/events` snapshot.

# Constraints

- TypeScript only; reuse the existing `tsc` build.
- Bind the HTTP server to `127.0.0.1` exactly as R2A did.
- All SSE frames must end with `\n\n` so browsers flush them.
- Per-connection state must be encapsulated so a second client cannot see another
  client's `lastSeq` or interfere with its timers.
- The new SSE branch must execute **before** the existing 404 fallback in the handler and
  must not return JSON via `sendJson`.
- Allowed source paths: only `src/web/**`. Tests may be added/updated only in the four
  files listed under `allowed_changes`.
- Disallowed: any change to `src/runtime/event-store.ts`, `src/runtime/event-bus.ts`,
  `src/orchestrator/**`, `src/cli/status.ts`, `review-loop.yaml`, `.git/**`, or the
  protected `.agent/*` files.
- Tests must be deterministic on macOS and Linux CI; no real-time `sleep(15000)`.
