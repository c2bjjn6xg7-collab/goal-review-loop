---
schema_version: 1
run_id: "20260622043223-giis2q"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---

# Phase 9 R2B — SSE Realtime Bridge

## Summary

Implemented the Server-Sent Events push channel for the read-only dashboard. The
JSON snapshot endpoint and 2 s polling path remain intact as a fallback; SSE
is preferred when `EventSource` is available client-side.

## Changes

- `src/web/event-source.ts`
  - Added exported `resolveRunIdFromAgentDir(agentDir)` helper that reads
    `state.json` and returns `run_id | null`. Used by both the snapshot path
    and the new SSE route.
  - `DashboardEventSource.readRunIdFromState` now delegates to the new helper.
  - Removed the unused `statePath` field (was only referenced by the inlined
    state read).

- `src/web/dashboard-server.ts`
  - Added `ssePollMs` (default 500 ms) and `sseHeartbeatMs` (default 15 000 ms)
    to `DashboardServerOptions`.
  - New `GET /api/events/stream` handler placed before the 404 fallback. It
    writes `Content-Type: text/event-stream`, `Cache-Control: no-cache,
    no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, flushes
    headers, then:
    1. Emits `event: hello\ndata: {"run_id":"<value>"}\n\n` where `<value>`
       comes from `resolveRunIdFromAgentDir` (falls back to `"unknown"`).
    2. Initializes `lastSeq` from `EventStore.getLastSequence()` so only
       *new* events are pushed (no historical replay; matches the GOAL
       non-goal of "no catch-up replay").
    3. Polls `EventStore.readSince(lastSeq)` every `ssePollMs`, writes
       `data: <json>\n\n` per new event in seq order, and advances
       `lastSeq`. Per-tick errors are swallowed so a mid-write JSONL line
       cannot kill the connection — `readAll()` already skips malformed lines.
    4. Writes `: heartbeat\n\n` on a separate interval every
       `sseHeartbeatMs`.
    5. Cleans up both intervals, removes the connection from the active set,
       and `res.end()`s on `req.close`, `req.error`, `res.close`, or
       `res.error`.
  - `DashboardServer.stop()` iterates the active-connections `Set` and
    proactively cleans up each open SSE response *before* awaiting
    `server.close()`, so lingering SSE sockets never hold the close open.

- `src/web/dashboard-html.ts`
  - Refactored the inline IIFE to encode the SSE↔polling exclusivity with a
    `mode` flag (`'idle' | 'sse' | 'poll'`).
  - On load: `tick()` for an initial paint, then `startSse()`.
  - `startSse()` guards on `typeof EventSource === 'function'`, opens
    `new EventSource('/api/events/stream')`, calls `tick()` on each `hello`
    or `message` event (the JSON snapshot remains the source of truth), and
    on `onerror` closes the SSE channel and starts the 2 s poll fallback.
  - When SSE is open, the 2 s `setInterval` is not running. Polling only
    starts on missing `EventSource` or on an SSE error. The `tick` symbol
    and `setInterval(tick, 2000)` remain reachable in the source so the
    existing `dashboard-html.test.ts` regex assertions still pass.

- `tests/unit/dashboard-server-sse.test.ts` (new)
  - Boots the real server on an ephemeral port with `ssePollMs: 30`,
    `sseHeartbeatMs: 80`.
  - Asserts hello frame with the resolved `run_id`, `data:` frame for an
    `events.jsonl` append (matched by `"seq":N` and `"kind"`), heartbeat
    line within ~500 ms, header content, `run_id: "unknown"` fallback when
    `state.json` is missing, prompt teardown via destroying the client and
    `server.stop()` (< 1 s) including with two open connections, and that
    `GET /api/events` still returns the R2A JSON snapshot.

- `tests/unit/dashboard-html.test.ts`
  - Added one new assertion block that the script contains
    `new EventSource('/api/events/stream')`, the `typeof EventSource` guard,
    `onerror`, and the polling fallback name.

## Verification

- `npm run typecheck`: **passes**.
- `npm test`: **passes** — 93 test files, 1262 tests.

## Constraints respected

- Only files under `src/web/**` and the four allowed test files were touched.
- No new runtime dependencies (no `package.json` change).
- Server still binds to `127.0.0.1`.
- `fs.watch` was not used; tail detection is via `EventStore.readSince`.
- `src/runtime/event-store.ts`, `src/runtime/event-bus.ts`,
  `src/orchestrator/**`, `src/cli/status.ts`, `review-loop.yaml`, and the
  protected `.agent/*` files were not modified.
