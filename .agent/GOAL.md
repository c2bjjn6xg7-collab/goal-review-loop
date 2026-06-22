---
schema_version: 1
run_id: "20260622140859-x6oc72"
goal_id: "phase-9-r5-live-agent-output"
title: "Phase 9 R5-Live: Real-Time Agent Output Streaming"
allowed_changes:
  - "src/runtime/output-filter.ts"
  - "src/runtime/process-runner.ts"
  - "src/runtime/event-bus.ts"
  - "src/agents/agent-adapter.ts"
  - "src/agents/planner-adapter.ts"
  - "src/agents/developer-adapter.ts"
  - "src/agents/auditor-adapter.ts"
  - "src/agents/final-auditor-adapter.ts"
  - "src/orchestrator/run-orchestrator.ts"
  - "src/web/dashboard-html.ts"
  - "src/cli/status.ts"
  - "src/types.ts"
  - "tests/unit/output-filter.test.ts"
  - "tests/unit/process-runner-output.test.ts"
  - "tests/unit/dashboard-html.test.ts"
  - "tests/integration/agent-output-events.test.ts"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
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
  - id: "lint"
    command: ["npm", "run", "lint"]
    cwd: "."
    required: false
    timeout_seconds: 300
---

# Objective

Implement Phase 9 R5-Live so that while an agent (planner/developer/auditor/final-auditor) is running, the dashboard and `status --watch` display filtered, throttled agent stdout in real time, instead of waiting for the agent to exit and a transcript to be written. Emit two new event kinds — `role.output` (filtered stdout chunks) and `role.heartbeat` (30 s liveness tick) — through the existing EventBus, render them in the dashboard's new Live Output panel, and surface the most recent `role.output` preview in the text-mode status summary.

Chain-of-thought (`<thinking>`, `<antThinking>`) and raw tool-call JSON must never reach the UI. Transcript files on disk must remain complete and unfiltered.

# Success Criteria

1. `src/runtime/output-filter.ts` exports a pure `filterAgentOutput(rawChunk: string): string` that strips `<thinking>…</thinking>` and `<antThinking>…</antThinking>` blocks (including across newlines), strips any line whose leading non-whitespace starts with `{"type":"tool_use"` or `{"type":"tool_result"`, truncates the result to 500 characters with a trailing `…` suffix when truncated, and returns `""` when nothing visible remains. Unit tests in `tests/unit/output-filter.test.ts` cover: plain text passthrough, single thinking block stripped, antThinking block stripped, JSON tool-call line stripped, mixed thinking + visible text, >500 char truncation with `…`, empty after filtering → `""`.

2. `src/runtime/process-runner.ts` `runProcess` accepts an optional `onOutput?: (params: { stream: 'stdout' | 'stderr'; text: string }) => void` on `ProcessRunnerInput` (or on the `runProcess` options). Inside the existing `onData` callback, after the file write, when `onOutput` is set the chunk is UTF-8 decoded, passed through `filterAgentOutput`, and — if non-empty — delivered to `onOutput`. Chunks are accumulated and flushed at most once per 500 ms, or immediately when the accumulated buffer exceeds 2000 characters. The existing file-write path (including `StreamRedactor`, truncation marker, byte accounting) is unchanged. `tests/unit/process-runner-output.test.ts` proves the callback fires with filtered text, that thinking blocks do not reach the callback, and that the 500 ms / 2000 char throttle coalesces bursts.

3. `src/agents/agent-adapter.ts` `runAgent` accepts an optional `eventBus?: IEventBus` (threaded through `AgentRunInput` and the four `build*Input` helpers — `planner-adapter.ts`, `developer-adapter.ts`, `auditor-adapter.ts`, `final-auditor-adapter.ts`). When `eventBus` is present, `runAgent` passes an `onOutput` callback to `runProcess` that emits a `role.output` event (`level: 'info'`, `message: filteredText.slice(0, 120)`, `payload: { text: filteredText, stream }`) and starts a `setInterval(30_000)` that emits `role.heartbeat` events (`level: 'debug'`, `message: '${role} still running (${elapsed}s)'`, `payload: { elapsed_ms }`). Both the interval and any pending throttle timer are cleared when the child process exits (success, failure, timeout, cancel, or error). When `eventBus` is absent, behavior is identical to today (no events, no interval).

4. `src/orchestrator/run-orchestrator.ts` passes the run-scoped `eventBus` through `buildPlannerInput`, `buildDeveloperInput`, `buildAuditorInput`, and `buildFinalAuditorInput` at the four existing call sites (lines ~741, ~1314, ~1759, ~2661). No other orchestrator behavior changes. Serial + single-task-graph path only — wave-mode worker stdout is explicitly out of scope and must not emit `role.output`.

5. `src/web/dashboard-html.ts` renders a new "Live Output" section below the events table, containing a scrolling `<pre id="live-output">` element. The render loop appends a line `[ts] role: text` for each `role.output` event found in `snapshot.latest_events`, keeps at most the 500 most recent lines (FIFO), and auto-scrolls to the bottom unless the user has scrolled up (detected via `scrollTop + clientHeight < scrollHeight - threshold`). A "Last heartbeat: Ns ago" indicator is shown next to the active role when a recent `role.heartbeat` event is present. XSS-safe: `textContent` / `createTextNode` only, no `innerHTML`. `tests/unit/dashboard-html.test.ts` asserts the panel anchor exists, the render path filters `role.output` from `latest_events`, the 500-line FIFO cap is enforced, and the heartbeat indicator is present.

6. `src/cli/status.ts` `renderTextSummary` shows an `Output: <preview>` line containing the most recent `role.output` event's `message` (or `payload.text` sliced to 120 chars) when one of the last ~6 events is a `role.output`. When the most recent `role.heartbeat` is newer than the most recent `role.exited`, the existing `Active:` line includes `Heartbeat: Ns ago`. No changes to JSON mode or to `watchStatePoll`.

7. `tests/integration/agent-output-events.test.ts` runs a fake-agent (a small Node script spawned via `runAgent` / `runProcess` that writes a `<thinking>secret</thinking>` block followed by `Editing src/foo.ts` and a `{"type":"tool_use",...}` JSON line to stdout, then exits 0). The test asserts that `.agent/events.jsonl` contains at least one `role.output` event whose `payload.text` includes `Editing src/foo.ts`, does NOT contain the string `secret`, does NOT contain `tool_use`, and that a `role.heartbeat` event was emitted (the test may use a shortened interval via injection or fake timers). The on-disk stdout transcript at `input.stdout_path` still contains the raw `<thinking>` block and the JSON line (proving the filter is observer-only).

8. `npm test` passes (including all pre-existing tests). `npm run typecheck` passes. No changes to `review-loop.yaml`, the scope guard, the diff digest, or audit gates.

# Non-Goals

- Wave-mode / task-graph parallel worker stdout streaming. Wave workers run in per-worktree processes and their stdout capture is unchanged.
- Backfilling `role.output` events for runs that started before this feature shipped.
- Surfacing `role.output` in the JSON status output (`status --json`). JSON mode already emits each event inline; no extra aggregation is added.
- Changing the on-disk transcript format or location. Transcripts remain complete and unfiltered.
- Changing the SSE protocol. The dashboard's existing snapshot-pull on SSE signal continues; the Live Output panel reads from `snapshot.latest_events`.
- Filtering stderr. Only stdout is emitted as `role.output` in this phase (stderr continues to flow through the existing redactor → file path only). The `onOutput` callback signature accepts `stream` so a future phase can extend without re-threading.
- Modifying the scope guard, diff digest, audit gates, or `review-loop.yaml`.

# Constraints

- **No raw chain-of-thought in events.** `<thinking>` / `<antThinking>` blocks must be stripped before any `role.output` event is emitted. The integration test must assert the string `secret` (used inside a thinking block in the fake agent) never appears in `events.jsonl`.
- **Throttle: at most 1 `role.output` event per 500 ms per role.** The throttle is per-role (the `runAgent` call owns its own throttle state). Accumulated chunks flush on the 500 ms tick OR when the accumulated buffer exceeds 2000 characters, whichever fires first.
- **Transcript integrity.** The `onData` file-write path must remain first and unchanged. The `onOutput` callback is a side-channel observer; it must never suppress or alter bytes written to `stdout_path` / `stderr_path`.
- **Backward compatibility.** `onOutput` on `ProcessRunnerInput` and `eventBus` on `AgentRunInput` are both optional. Existing callers (including `runProcessRaw`, which is not modified, and any test that calls `runAgent` without an event bus) continue to compile and behave identically.
- **Serial + single-task-graph only.** Do not wire `onOutput` into the task-graph / wave worker execution path. Wave-mode worker stdout continues to be captured per-worker into worktree-local files only.
- **No new dependencies.** Use `setInterval` / `clearInterval` and the existing `IEventBus` / `EventStore` machinery. No new npm packages.
- **XSS-safe dashboard.** The Live Output panel must use `textContent` / `createTextNode` exclusively. No `innerHTML`, no `insertAdjacentHTML`, no templating that interpolates raw event text into HTML.
- **Fail-soft observability.** A persistence failure inside `eventBus.emit` (already handled by `EventBus.emit`) must not crash the agent run. `runAgent` must not await or inspect the emit result for control flow.
