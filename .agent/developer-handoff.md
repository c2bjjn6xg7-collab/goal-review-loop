---
schema_version: 1
run_id: "20260622140859-x6oc72"
iteration: 3
author_role: "developer"
status: "COMPLETED"
---

# Developer Handoff — Phase 9 R5 Live Agent Output (task-2)

## Summary

Wired `onOutput` through `ProcessRunnerInput` and `eventBus` through
`AgentRunInput` so real-time agent stdout/stderr is filtered and streamed as
`role.output` events, with a 30 s `role.heartbeat` per running role. The
orchestrator passes the run-scoped `eventBus` into all four `build*Input`
helpers. Wave-mode / `runProcessRaw` paths are untouched.

## Files changed (all within `allowed_changes`)

- `src/types.ts` — added `onOutput?` to `ProcessRunnerInput`; added
  `eventBus?: IEventBus` to `AgentRunInput` (via inline import type to avoid
  a circular import at module load).
- `src/runtime/process-runner.ts` — imports `filterAgentOutput`; in `runProcess`
  `onData`, after the file write, decodes the sanitized buffer, runs it through
  `filterAgentOutput`, and accumulates per-stream. Flushes on a 500 ms
  `setInterval` OR when an accumulator exceeds 2000 chars. The interval is
  cleared and a final flush runs inside the existing `cleanup` closure.
  `runProcessRaw` is unchanged.
- `src/agents/agent-adapter.ts` — `runAgent` now reads `input.eventBus`; when
  present it passes an `onOutput` callback to `runProcess` that emits
  `role.output` (level `info`, `message = filteredText.slice(0,120)`,
  `payload {text, stream}`) and starts a `setInterval` emitting
  `role.heartbeat` (level `debug`, `message '${role} still running (${elapsed}s)'`,
  `payload {elapsed_ms}`). The interval is cleared in a `finally` after
  `runProcess` resolves or throws. Role→phase mapping: planner→PLANNING,
  developer→DEVELOPING, auditor→AUDITING, final-auditor→FINALIZING. A
  test-only `AGENT_HEARTBEAT_INTERVAL_MS` env var overrides the 30 s default.
- `src/agents/planner-adapter.ts`, `developer-adapter.ts`,
  `auditor-adapter.ts`, `final-auditor-adapter.ts` — each `build*Input` now
  accepts an optional `eventBus?: IEventBus` and forwards it on the returned
  `AgentRunInput`.
- `src/orchestrator/run-orchestrator.ts` — passes the run-scoped `eventBus`
  into `buildPlannerInput` (~line 741), `buildDeveloperInput` (~1314),
  `buildAuditorInput` (~1759), and `buildFinalAuditorInput` (~2661). No other
  orchestrator behavior changed; `runProcessRaw` and wave-mode workers are not
  wired.
- `tests/unit/process-runner-output.test.ts` — 6 tests: filtered stdout
  delivery, thinking blocks never reach the callback, JSON tool_use lines
  never reach the callback, on-disk transcript keeps raw content, 500 ms
  throttle coalesces back-to-back bursts into a single delivery, 2000-char
  threshold triggers an immediate flush.
- `tests/integration/agent-output-events.test.ts` — spawns a fake-agent that
  writes `<thinking>secret</thinking>`, `Editing src/foo.ts`, and a
  `{"type":"tool_use",...}` line to stdout, then sleeps until aborted.
  Asserts `events.jsonl` contains ≥1 `role.output` whose `payload.text`
  includes `Editing src/foo.ts`, does NOT contain `secret` or `tool_use`,
  contains ≥1 `role.heartbeat`, and that the on-disk stdout transcript still
  contains the raw thinking block and JSON line.

## Test injection point

`agent-adapter.ts` reads `process.env.AGENT_HEARTBEAT_INTERVAL_MS` (parsed as
int, falls back to 30 000). The integration test sets this to `50` so a
heartbeat fires within the test window without waiting 30 seconds. This is
the only test-only hook; all other behavior is production-default.

## Verification

- `npm test -- tests/unit/process-runner-output.test.ts tests/integration/agent-output-events.test.ts` — 7/7 pass.
- `npm test` — 1335/1335 pass (102 files).
- `npm run typecheck` — clean.

## Notes for the auditor

- The `eventBus` field on `AgentRunInput` uses an inline
  `import('./runtime/event-bus.js').IEventBus` type to avoid adding a runtime
  import to `src/types.ts` (which would create a circular dependency:
  `types.ts` → `event-bus.ts` → `event-store.ts` → `types.ts`). The adapter
  files import `IEventBus` directly.
- `onOutput` is fire-and-forget from `runProcess`'s perspective; observer
  exceptions are swallowed so they can never break a run.
- The heartbeat interval is `unref`'d so it does not keep the Node event loop
  alive on its own.
- The output flush interval is also `unref`'d and is cleared in `cleanup`,
  which runs on success, failure, timeout, cancel, and error paths.
