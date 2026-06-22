---
schema_version: 1
run_id: "20260622043223-giis2q"
author_role: "planner"
---

# Phase 9 R2B — Dashboard Realtime via Server-Sent Events

## Requirement Understanding

R2A delivered a read-only dashboard that polls `/api/events` every 2 seconds. R2B layers a
push channel on top **without** disturbing the polling path. The Developer must:

1. Add a `GET /api/events/stream` route to `src/web/dashboard-server.ts` that responds with
   `Content-Type: text/event-stream` and never closes from the server side unless the
   client disconnects.
2. On connect, send an `event: hello\ndata: {"run_id": "..."}\n\n` frame so the client can
   confirm the channel is live before any events arrive.
3. Tail `.agent/events.jsonl` by re-using `EventStore.readSince(lastSeq)` on a 500 ms
   interval. For each new event, push `data: <json>\n\n`. Do **not** use `fs.watch`.
4. Emit a heartbeat comment line `: heartbeat\n\n` every 15 seconds to keep proxies and
   browser timeouts from killing the connection.
5. Clean up timers and listeners on client `close` so server shutdown is clean and no
   timers leak between connections.
6. Update `src/web/dashboard-html.ts` so the client prefers `EventSource('/api/events/stream')`
   when available and falls back to the existing 2-second poll only when `EventSource` is
   missing or its `onerror` fires. The two paths are mutually exclusive — when SSE is
   active, polling must be stopped.
7. Cover the new behavior with a unit test that opens a real HTTP request against the
   ephemeral server, reads the response stream, and asserts: a `hello` frame, a delivered
   data event after an `events.jsonl` append, and a heartbeat comment within the test
   window (the heartbeat interval is configurable so tests don't wait 15 s).

## Current Project Status

- `src/web/dashboard-server.ts`: created in R2A; only `GET /` and `GET /api/events` exist.
  The handler uses an in-scope `DashboardEventSource` and binds to `127.0.0.1`. The server
  must continue to bind locally for R2B.
- `src/web/event-source.ts`: `DashboardEventSource.getSnapshot()` reads the full log and is
  unsuited for streaming. R2B will use `EventStore.readSince()` directly (re-using the
  same `EVENTS_FILENAME` / `agentDir` resolution) rather than extending the snapshot
  source.
- `src/runtime/event-store.ts`: already exposes `readSince(afterSeq)` (line 223) and
  `getLastSequence()` (line 229). R2B will compose them, not change them.
- `src/web/dashboard-html.ts`: hosts the inline page with the 2 s `tick()` poller.
- Tests: `tests/unit/dashboard-server.test.ts` and `tests/unit/dashboard-html.test.ts`
  already validate the R2A surface and provide the testing pattern (start the server on a
  random port, hit it with `node:http`).

## Technical Approach

**Server (`dashboard-server.ts`)**

- Add a `pathOnly === '/api/events/stream'` branch before the 404 fallback. It must not
  call `sendJson`; it writes SSE headers manually:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache, no-transform`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no` (defensive against reverse proxies that buffer)
- Resolve `run_id` once at connect time by re-using the existing run-id-from-state logic.
  To avoid widening `DashboardEventSource`'s public API, factor a tiny pure helper
  `resolveRunIdFromAgentDir(agentDir)` in `event-source.ts` and reuse it from both the
  snapshot path and the SSE path.
- Track `lastSeq` per connection, initialized via `EventStore.getLastSequence()` so the
  stream starts at the **current tail** (it pushes new events only, not history; the JSON
  snapshot endpoint remains the canonical "catch-up" source).
- Tail with `setInterval(..., pollMs)` (default 500 ms). On each tick:
  - `await store.readSince(lastSeq)`
  - For each event, write `data: ${JSON.stringify(event)}\n\n` and update `lastSeq`.
  - Swallow per-tick read errors (the file may be mid-write); never crash the connection.
- Heartbeat with a second `setInterval(..., heartbeatMs)` (default 15 000 ms) that writes
  `: heartbeat\n\n`.
- On `req.close` (client disconnect): clear both intervals, set them to `null`, end the
  response.
- On server `stop()`: also clear any registered active connections so `server.close()`
  isn't blocked by lingering SSE sockets. Track them in a `Set<{ cleanup(): void }>`.
- Expose internal pacing knobs on `DashboardServerOptions` (`ssePollMs`, `sseHeartbeatMs`)
  defaulting to 500 / 15 000 so unit tests can drop them to ~50 / 80 ms without sleeping
  for 15 s.

**Client (`dashboard-html.ts`)**

- Refactor `tick()` into a `pollOnce()` helper that does a single fetch+render, and a
  `startPolling()` / `stopPolling()` pair that owns the `setInterval` handle.
- Add `startSse()`:
  - Guard `typeof EventSource === 'function'`.
  - `var es = new EventSource('/api/events/stream')`.
  - On `hello`: update `updatedEl` (channel confirmed).
  - On generic `message`: parse the event JSON, then trigger a one-shot `pollOnce()` so
    artifacts and `current_phase` stay accurate. SSE here acts as a **freshness signal**;
    the JSON snapshot remains the source of truth and shares the existing render code.
  - On `error`: close `es`, fall back to `startPolling()`.
- Call sequence on load: `pollOnce()` for initial paint, then attempt `startSse()`; if not
  available, `startPolling()`.
- Two paths must not run concurrently. Encode this with a single mutable mode flag
  (`'sse' | 'poll' | 'idle'`) and guard the start functions.
- Preserve `tick` and `setInterval(tick, 2000)` symbol presence in the source so the
  existing `dashboard-html.test.ts` regex assertions keep passing (verify by reading that
  test first).

**Tests (`tests/unit/dashboard-server-sse.test.ts`, new file)**

- Create a temp project root with `.agent/events.jsonl` and a minimal `state.json`.
- Start the server with `ssePollMs: 30`, `sseHeartbeatMs: 80`.
- Open a manual `http.request` to `/api/events/stream`, consume the response as a stream,
  accumulate the raw text into a buffer.
- Assertions (within a single test, with a per-assertion poll-the-buffer helper):
  1. Buffer contains `event: hello\n` and a `data: {"run_id":` line.
  2. After appending a JSON event line to `events.jsonl`, the buffer eventually contains a
     `data:` line whose JSON includes that event's `seq` and `kind`.
  3. After waiting > one heartbeat interval, the buffer contains `: heartbeat\n\n`.
- Tear down: destroy the request (triggers `req.close` on the server) and then
  `server.stop()`. Assert `stop()` resolves promptly to prove the per-connection cleanup
  ran.
- Add one additional smaller test confirming `GET /api/events` (polling) still returns
  JSON unchanged, so the R2A path isn't accidentally broken.

## Work Breakdown

This is a single atomic feature: the server route, the HTML wiring, and the unit test
must land together for the build to typecheck and tests to pass. Per
`docs/superpowers/agent-task-planning-guidelines.md`, it stays as one task.

1. Extend `DashboardServerOptions` with optional `ssePollMs` and `sseHeartbeatMs`.
2. Factor `resolveRunIdFromAgentDir` in `event-source.ts`; re-use it from the snapshot
   path.
3. Implement `/api/events/stream` in `dashboard-server.ts`, with per-connection state,
   timers, heartbeat, and a `Set` of active connections cleaned up by `stop()`.
4. Refactor `dashboard-html.ts` client script: split poll/SSE, mode flag, fallback on
   `error`, initial paint via `pollOnce()`.
5. Add `tests/unit/dashboard-server-sse.test.ts` covering hello / event push / heartbeat /
   cleanup.
6. Ensure existing tests still pass (`dashboard-server.test.ts`, `dashboard-html.test.ts`,
   `event-source.test.ts`).

## Risks

- **Timer leaks**: forgetting to clear either interval on `req.close` will leak across
  reconnects. Mitigation: collect both into the same per-connection cleanup function,
  registered in the connections `Set`, and call it from both `req.close` and `stop()`.
- **`server.close()` blocking**: Node's `server.close()` waits for all sockets. SSE
  sockets stay open until the client disconnects. Mitigation: in `stop()`, iterate the
  connections set and end each response before awaiting `server.close()`.
- **Test flakiness on heartbeat**: a hard-coded 15 s heartbeat would force a 15 s sleep.
  Mitigation: expose `sseHeartbeatMs` as an option, default 15 000 in production, override
  to ~80 ms in tests.
- **HTML script regression**: refactoring the IIFE could break the existing
  `dashboard-html.test.ts` (which likely greps for `tick`/`setInterval`). Mitigation:
  retain `tick` as the poll function name and keep `setInterval(tick, 2000)` reachable in
  the source so any structural assertions still pass; check that test file early.
- **SSE message framing**: missing the trailing blank line causes clients to never flush a
  frame. Mitigation: every payload write ends with `\n\n`; covered by the buffer-content
  assertions in the new test.
- **Mid-write JSONL line**: a partial trailing line could be re-read on the next tick.
  `EventStore.readAll()` already skips malformed lines (line 215), and `lastSeq` only
  advances on parsed events, so the next tick picks the line up once complete.
