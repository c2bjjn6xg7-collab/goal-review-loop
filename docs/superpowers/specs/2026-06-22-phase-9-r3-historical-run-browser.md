# R3 Spec: Historical Run Browser

> Date: 2026-06-22
> Status: Draft — awaiting human approval before implementation
> Base: `main@2e11ee7` (1269 tests passing)
> Depends on: R1 (EventStore, EventBus), R2A (dashboard server + HTML), R2B (SSE), R2C (cancel)

## Goal

Let a dashboard operator browse past runs archived in `.agent/history/events-*.jsonl`, not just the current live run. The dashboard today only shows the active `events.jsonl`; R3 adds run enumeration and a run switcher.

## Non-Goals (explicit out-of-scope)

- JSON-RPC or multi-run orchestration API
- Replaying / re-running past runs from the dashboard
- Deleting or pruning archived runs
- Remote / multi-user access (dashboard remains 127.0.0.1 only)
- Modifying scheduler semantics or `state.json`

## API Changes

### 1. `GET /api/runs` — Run listing

Returns all known runs: archived files from `.agent/history/events-*.jsonl` plus the active `events.jsonl`.

**Response shape:**

```jsonc
{
  "runs": [
    {
      "run_id": "20260622020317-dticln",
      "phase": "PASSED",            // last terminal event's phase, or last event's phase
      "started_at": "2026-06-22T02:03:17.392Z",  // first event's ts
      "event_count": 9,
      "is_active": false,           // true only for the current live run
      "source": "history"           // "history" | "active"
    },
    {
      "run_id": "20260622043223-giis2q",
      "phase": "PASSED",
      "started_at": "2026-06-22T04:32:23.000Z",
      "event_count": 42,
      "is_active": false,
      "source": "history"
    }
    // ... current active run (if events.jsonl exists) listed last
  ],
  "active_run_id": "20260622060000-abc123"  // from state.json, or null
}
```

**Implementation notes:**
- For each `events-*.jsonl` in `.agent/history/`: instantiate a read-only `EventStore` pointed at the history dir, call `readAll()`, extract `run_id` from first event, `phase` from last terminal event (guardrail #2: use last, not first), `started_at` from first event's `ts`, `event_count` from array length.
- For the active `events.jsonl`: same extraction, mark `is_active: true`, `source: "active"`.
- Sort: archived runs by `started_at` ascending, active run last.
- Fail-soft: if one archive file is unreadable/malformed, skip it with a warning, don't fail the whole listing.
- The filename encodes the run_id (`events-<runId>.jsonl`), but prefer reading the file's events for metadata — don't trust the filename alone (guardrail #1: respect `run_id` from events).

### 2. `GET /api/events?run_id=<id>` — Per-run event snapshot

The existing `/api/events` endpoint is extended with an optional `run_id` query parameter.

- **No `run_id`** (or `run_id` matches active run): behave exactly as today — read from active `events.jsonl`.
- **`run_id` matches an archived run**: read from `.agent/history/events-<run_id>.jsonl` using EventStore.
- **`run_id` not found**: return `404 { error: "run_not_found", run_id: "..." }`.

**Response shape**: same `DashboardSnapshot` as today, but with the requested run's data.

**Implementation notes:**
- Reuse `DashboardEventSource.getSnapshot()` but parameterize it with an optional `runId` override.
- When reading an archived run, construct `EventStore` with `agentDir` pointing to `.agent/history/` and the correct `runId`. Alternatively, add a method that reads from an explicit file path.
- The `current_phase` derivation must use `reverse().find()` for terminal events (guardrail #2).

### 3. SSE: no change for archived runs

SSE remains tied to the active run only. When the user switches to an archived run in the UI, the client stops the EventSource and falls back to polling `/api/events?run_id=<id>`. This avoids the complexity of SSE for static archives.

## UI Changes

### Run Switcher

Add a dropdown/select in the dashboard header, between the run ID display and the phase pill.

```
Run: [▼ 20260622020317-dticln (PASSED)     ] Phase: [PASSED]
```

**Behavior:**
1. On page load, fetch `/api/runs` to populate the dropdown. Default selection: the active run (if any), otherwise the most recent archived run.
2. Each option shows: `run_id` (truncated to last 12 chars for readability) + phase badge.
3. On selection change:
   - If selected run is active: reconnect SSE to `/api/events/stream`, fetch `/api/events` (no `run_id` param).
   - If selected run is archived: close SSE, fetch `/api/events?run_id=<id>`, set up a slow poll (every 10s) in case the listing changes.
4. The cancel button is **hidden** for archived runs (only the active, non-terminal run can be cancelled).
5. Refresh the run list every 30 seconds to pick up newly archived runs.

**Security:**
- Continue using `textContent` only — no `innerHTML` interpolation of run IDs or phases.
- The `run_id` in the query string is validated server-side (alphanumeric + dash only) before use as a filename component, preventing path traversal.

## File Changes Summary

| File | Change |
|------|--------|
| `src/web/run-lister.ts` | **NEW** — `RunLister` class: enumerates runs from history dir + active events.jsonl |
| `src/web/dashboard-server.ts` | Add `GET /api/runs` route; extend `GET /api/events` with `run_id` query param; validate `run_id` format |
| `src/web/event-source.ts` | Extend `getSnapshot()` to accept optional `runId` override that reads from archive |
| `src/web/dashboard-html.ts` | Add run switcher `<select>` element and JS logic in the header; hide cancel btn for archived runs |
| `tests/unit/run-lister.test.ts` | **NEW** — Unit tests for run enumeration, malformed file tolerance, sorting |
| `tests/unit/dashboard-server-runs.test.ts` | **NEW** — Tests for `/api/runs` endpoint, `/api/events?run_id=...`, path traversal rejection |
| `tests/unit/dashboard-html.test.ts` | Extend existing tests for run switcher rendering |

## Design Guardrail Compliance

1. **Per-run isolation**: `RunLister` reads each archive file with its own `EventStore(runId)` instance. No cross-run contamination.
2. **Last terminal event**: `RunLister` and extended `getSnapshot()` both use `[...events].reverse().find()` for phase derivation.
3. **Serial/task-graph equivalence**: R3 only reads events — it does not emit any. No wiring changes needed.
4. **UI consumes via EventStore**: `RunLister` uses `EventStore.readAll()` pointed at the history directory. No raw file reads.
5. **Action buttons reuse mechanisms**: No new action buttons in R3. Cancel remains unchanged for active runs only.

## Boundaries Respected

- `state.json` is read-only (used to determine `active_run_id` for the listing).
- Event emission is not modified (R3 is read-only on the event layer).
- No changes to auditor/final-auditor configuration.
- No chain-of-thought exposure (events don't contain it; R3 doesn't add it).
- No scheduler changes.
- `src/cli/status.ts` is untouched.

## Testing Strategy

### Unit tests (`run-lister.test.ts`)
- Empty history dir → returns only active run (or empty list)
- Single archived run + active run → correct listing with `is_active` flags
- Multiple archived runs → sorted by `started_at`
- Malformed JSONL file → skipped with warning, other runs still listed
- Archive with mixed run_ids (shouldn't happen but defensive) → uses first event's run_id
- Active run with terminal event → correct phase via last-terminal-event rule

### API tests (`dashboard-server-runs.test.ts`)
- `GET /api/runs` returns expected shape
- `GET /api/events?run_id=<valid>` returns archived run's snapshot
- `GET /api/events?run_id=<invalid>` returns 404
- `GET /api/events?run_id=../../etc/passwd` → rejected (path traversal)
- `GET /api/events` (no param) → unchanged behavior
- `GET /api/events?run_id=<active>` → same as no param

### Integration test
- Start dashboard, verify run switcher populates with archived runs
- Switch to archived run, verify events table updates
- Switch back to active run, verify SSE reconnects

## Estimated Scope

~300-400 lines of new production code (RunLister + server route changes + HTML/JS updates).
~300-400 lines of new tests.
No new dependencies.

## Resolved Design Decisions

1. **Run ID: full display, no truncation.** Run ID format is `YYYYMMDDHHMMSS-xxxxxx` (timestamp + 6-char random suffix). Truncating to 12 chars would cut off the random suffix — same-day runs would be indistinguishable in the switcher. Use `font-family: monospace` + CSS `overflow: hidden` for layout, but always show the complete ID. Each dropdown option also shows a friendly time label (e.g. `6/22 04:32`) for quick visual scanning.

2. **Run list auto-refresh: 15 seconds.** Run list changes are low-frequency (new runs appear only at `start`), but users typically open the run browser around the time they start or are about to start a run — 30s is too slow. 15s balances responsiveness and overhead. The page loads the run list immediately on first render (does not wait for the first 15s tick).

3. **Archived runs: NO polling.** Archive files (`.agent/history/events-<runId>.jsonl`) are write-once and immutable after creation. Fetch once via `GET /api/events?run_id=<id>`, render, done. Polling an immutable file is pure waste. Only the active run uses SSE/polling. This also aligns with the dogfood guardrail: don't do unnecessary work.
