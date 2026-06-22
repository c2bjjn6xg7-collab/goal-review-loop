---
schema_version: 1
run_id: "20260622140859-x6oc72"
author_role: "planner"
---

# Phase 9 R5-Live — Real-Time Agent Output Streaming

## Requirement Understanding

While a planner / developer / auditor / final-auditor agent runs (3–10 minutes typical), the review-loop event stream is silent. The operator sees `role.started` and then nothing until `role.exited`. The dashboard shows "Developer is running iteration 1/3" but cannot show *what* the developer is doing. Phase 9 R1–R4 already defined the event kinds `role.output` and `role.heartbeat` in `ReviewLoopEventKind` (`src/runtime/event-store.ts:27`) but emit points are zero.

R5-Live adds the emit points and the UI consumption:

1. **Filter** — a pure `filterAgentOutput(raw)` strips chain-of-thought (`<thinking>`, `<antThinking>` blocks), raw tool-call JSON lines (`{"type":"tool_use"…` / `{"type":"tool_result"…`), and truncates to 500 chars. Hard constraint: spec line 96 — the UI must not expose raw chain-of-thought.
2. **Plumb** — `runProcess` gains an optional `onOutput` callback that fires with filtered, throttled text. `runAgent` gains an optional `eventBus` and wires `onOutput` → `role.output` events, plus a 30 s `setInterval` → `role.heartbeat`. The orchestrator threads its existing `eventBus` into the four `build*Input` → `runAgent` call sites.
3. **Render** — dashboard gets a Live Output `<pre>` panel (500-line FIFO, auto-scroll, XSS-safe). `status --watch` text mode shows the latest `role.output` preview and a heartbeat age indicator.

Transcripts on disk remain complete and unfiltered — the filter is observer-only.

## Current Project Status

- Branch `main`, clean tree, base commit `c9952d41c71e03b0bd50e8a06184972ef675e4a3`.
- `EventBus` / `EventStore` / `IEventBus` already exist (`src/runtime/event-bus.ts`, `src/runtime/event-store.ts`). `role.output` and `role.heartbeat` are already in `ReviewLoopEventKind` but never emitted.
- `runProcess` (`src/runtime/process-runner.ts:269`) writes stdout/stderr through `StreamRedactor` to file via the `onData` closure at line 397. No callback surface today.
- `runAgent` (`src/agents/agent-adapter.ts:118`) calls `runProcess` at line 270 with no event hook. Signature: `runAgent(input, projectRoot)`.
- `AgentRunInput` (`src/types.ts:144`) has no `eventBus` field. Four `build*Input` helpers (`planner-adapter.ts:25`, `developer-adapter.ts:29`, `auditor-adapter.ts:31`, `final-auditor-adapter.ts:33`) construct it.
- Orchestrator creates `eventBus` at `run-orchestrator.ts:249` (resume) and `:627` (fresh), then calls `runAgent` at lines `:751`, `:1328`, `:1770`, `:2672` without passing it.
- Dashboard (`src/web/dashboard-html.ts`) polls `/api/events` on SSE signal and renders `snapshot.latest_events` as a table. No live-output panel. XSS-safe (`textContent` / `createTextNode` only).
- `renderTextSummary` (`src/cli/status.ts:183`) prints run / phase / active role / latest 6 events / artifacts. No `Output:` preview line, no heartbeat age.
- Tests use `vitest`. Existing `tests/unit/dashboard-html.test.ts` asserts structural anchors and XSS safety — the new panel must keep those assertions green.

## Technical Approach

**Filtering.** A single pure function `filterAgentOutput(raw: string): string` in a new `src/runtime/output-filter.ts`. Implementation: (1) regex-strip `<thinking>[\s\S]*?</thinking>` and `<antThinking>[\s\S]*?</antThinking>` non-greedily across newlines; (2) split on `\n`, drop lines whose trimmed leading token starts with `{"type":"tool_use"` or `{"type":"tool_result"`, rejoin with `\n`; (3) if the result length > 500, slice to 500 and append `…`; (4) return `""` when empty. Pure, synchronous, no I/O — trivially testable.

**Throttled callback in process-runner.** Add `onOutput?: (p: { stream: 'stdout' | 'stderr'; text: string }) => void` to `ProcessRunnerInput`. Inside `onData` (line 397), after the existing file-write block, when `input.onOutput` is set: decode the sanitized `Buffer` to UTF-8, run `filterAgentOutput`, and if non-empty push into a per-stream accumulator. A `setInterval(500)` (created lazily on first chunk, cleared in `cleanup`) flushes the accumulator by calling `onOutput`. If the accumulator exceeds 2000 chars before the tick, flush immediately. The redactor-stripped bytes are what we decode, so secrets already redacted in the file are also redacted in events. `runProcessRaw` is not modified (it has no redactor and is used for non-agent subprocesses).

**eventBus on AgentRunInput.** Add `eventBus?: IEventBus` to `AgentRunInput` (`src/types.ts:144`) and to each of the four `build*Input` param shapes. `runAgent` reads `input.eventBus`. When present:
- Pass an `onOutput` callback to `runProcess` that emits `role.output` (`level: 'info'`, `message: text.slice(0, 120)`, `payload: { text, stream }`). The emit is fire-and-forget (fail-soft — `EventBus.emit` already swallows persistence errors).
- Before awaiting `runProcess`, start `setInterval(30_000)` that emits `role.heartbeat` (`level: 'debug'`, `message: '${role} still running (${elapsed}s)'`, `payload: { elapsed_ms }`).
- In a `finally` after `runProcess` returns (or throws), `clearInterval` both the heartbeat interval and any throttle timer still pending inside `runProcess` (the timer is owned by `runProcess` and cleared in its own `cleanup`; `runAgent` only needs to clear its own heartbeat interval).

The `phase` and `provider` fields for the emit come from existing context: `runAgent` knows `input.role` but not the phase or provider. Two options: (a) add `phase` and `provider` optional fields to `AgentRunInput` and have each `build*Input` set them, or (b) have `runAgent` derive phase from role (`planner` → `PLANNING`, `developer` → `DEVELOPING`, `auditor` → `AUDITING`, `final-auditor` → `FINALIZING`) and leave `provider` unset. Option (b) is less invasive and matches how `role.started` events already set phase explicitly at the orchestrator call site. The orchestrator already emits `role.started` with the correct phase and provider right before calling `runAgent` (lines `:731`, `:1295`, `:1750`, and the final-auditor equivalent), so the `role.output` events just need to carry the same `role` — downstream consumers can join on role + recency. Go with option (b): `runAgent` derives phase from role, `provider` is omitted on `role.output` / `role.heartbeat` (the preceding `role.started` carries it).

**Orchestrator threading.** Four call sites: pass `eventBus` into `buildPlannerInput({ …, eventBus })` etc. Each `build*Input` forwards it to the constructed `AgentRunInput`. No other orchestrator changes.

**Dashboard panel.** Add `<section><h2>Live Output</h2><pre id="live-output" aria-live="polite"></pre></section>` after the events table section. In `render(snapshot)`, filter `snapshot.latest_events` for `kind === 'role.output'`, slice the last 500, and for each append a child `<div>` with `[ts] role: text` via `createTextNode`. Track `liveOutputEl.scrollTop + liveOutputEl.clientHeight < liveOutputEl.scrollHeight - 32` before the append; if false (i.e., user is at the bottom), set `scrollTop = scrollHeight` after the append. For `role.heartbeat`, find the most recent one in `latest_events`; if it exists and no `role.exited` for the same role is newer, render `Last heartbeat: Ns ago` next to the active role in the header. The `N` is `Math.round((Date.now() - new Date(ev.ts).getTime()) / 1000)`. XSS safety is preserved because we only ever call `createTextNode` / `textContent`.

**status.ts.** In `renderTextSummary`, after the `Active:` line, scan `recent` (last 6 events) for the most recent `role.output`; if found, print `Output: <message or payload.text sliced to 120>`. For heartbeat: if the most recent `role.heartbeat` is newer than the most recent `role.exited` for the same role, append `Heartbeat: Ns ago` to the `Active:` line. No JSON-mode changes.

**Integration test.** A fake-agent Node script writes `<thinking>secret</thinking>\nEditing src/foo.ts\n{"type":"tool_use","name":"edit"}\n` to stdout over ~1.5 s (with small sleeps to exercise the throttle), then exits 0. Spawn via `runAgent` with a real `EventBus` pointed at a temp `.agent` dir. After exit, read `.agent/events.jsonl`, parse each line, assert: ≥1 `role.output` exists; its `payload.text` contains `Editing src/foo.ts`; no event payload or message contains the substring `secret`; no event payload or message contains `tool_use`; ≥1 `role.heartbeat` exists (use a 100 ms interval via an injected `heartbeatIntervalMs` option on `AgentRunInput`, or use vitest fake timers — the latter is cleaner because it avoids adding a production option solely for tests). The on-disk `stdout_path` file still contains `<thinking>secret</thinking>` and the JSON line (filter is observer-only).

## Work Breakdown

Three tasks. Per `docs/superpowers/agent-task-planning-guidelines.md`, the runtime + adapter + orchestrator chain is one atomic task — splitting it would leave the repo in a non-compiling state between tasks because `eventBus` flows through `AgentRunInput` → `build*Input` → `runAgent` → `runProcess` and the orchestrator call sites.

### Task 1 — `output-filter.ts` + unit tests (low risk, low difficulty)

- **Scope**: `src/runtime/output-filter.ts` (NEW), `tests/unit/output-filter.test.ts` (NEW).
- **Verify**: `npm test -- tests/unit/output-filter.test.ts` passes; `npm run typecheck` passes.
- **Independently buildable**: yes. No other source file imports the filter yet.

### Task 2 — Runtime + adapter + orchestrator wiring + integration test (high risk, high difficulty, atomic)

- **Scope**: `src/runtime/process-runner.ts`, `src/types.ts`, `src/agents/agent-adapter.ts`, `src/agents/planner-adapter.ts`, `src/agents/developer-adapter.ts`, `src/agents/auditor-adapter.ts`, `src/agents/final-auditor-adapter.ts`, `src/orchestrator/run-orchestrator.ts`, `tests/unit/process-runner-output.test.ts` (NEW), `tests/integration/agent-output-events.test.ts` (NEW).
- **Verify**: `npm test` passes (incl. pre-existing tests); `npm run typecheck` passes.
- **Depends on**: task-1 (imports `filterAgentOutput`).
- **Why atomic**: `eventBus` is added to `AgentRunInput`, consumed by `runAgent`, set by all four `build*Input`, and passed by the orchestrator. Any subset leaves either a type error (`build*Input` references a field that doesn't exist) or a dead code path (field exists, never populated). The integration test exercises the whole chain end-to-end.

### Task 3 — Dashboard Live Output panel + status text preview + unit test (medium risk, low difficulty)

- **Scope**: `src/web/dashboard-html.ts`, `src/cli/status.ts`, `tests/unit/dashboard-html.test.ts`.
- **Verify**: `npm test -- tests/unit/dashboard-html.test.ts` passes; `npm run typecheck` passes.
- **Depends on**: nothing hard. The panel reads `role.output` events from `snapshot.latest_events`; even with zero such events the dashboard renders normally. Can be developed in parallel with task-2.
- **Why split**: the dashboard and status CLI are pure consumers of the event kind string. They compile and test independently of the runtime wiring. Keeping them in a separate task keeps each Developer context short.

## Risks

1. **Thinking-block regex across chunk boundaries.** `filterAgentOutput` is called per-chunk inside `onData`. A `<thinking>` block split across two `onData` chunks would not be matched by the per-chunk regex. **Mitigation**: the throttle in `runProcess` accumulates chunks for 500 ms before flushing, so `filterAgentOutput` runs on the *accumulated* buffer, not on each raw chunk. This dramatically reduces (but does not eliminate) the split-block risk. A truly robust solution would carry a `pending` buffer in the filter itself and only emit text once any open `<thinking>` is closed. **Recommendation**: make `filterAgentOutput` stateless per the spec (pure function), but document in code that callers should pass accumulated buffers, not raw chunks. The integration test writes the whole thinking block in one `process.stdout.write` call to avoid flakiness. If a split-block leak is observed in dogfooding, follow-up task adds stateful filtering.
2. **Throttle timer lifecycle.** The 500 ms `setInterval` inside `runProcess` must be `clearInterval`-ed in *every* exit path: success, failure, timeout, cancel, child error, cleanup. The existing `cleanup` closure is the right place. Forgetting one path leaks a timer that fires after the process is gone, calling `onOutput` with stale data. **Mitigation**: clear the timer at the top of `cleanup` (which is already idempotent via `cleanupDone`).
3. **`role.output` event volume.** Even at 1 event / 500 ms / role, a 10-minute developer run emits 1200 events. `events.jsonl` grows fast. **Mitigation**: spec accepts this (events are observability-only and archived per run). Operator can truncate archived runs. Follow-up: consider a "summary" mode that drops `role.output` from the persisted stream after N minutes.
4. **Heartbeat interval leak on forced kill.** If the orchestrator's `AbortSignal` fires and `runProcess` resolves as `CANCELLED`, the `finally` in `runAgent` must still `clearInterval` the heartbeat. **Mitigation**: wrap the `runProcess` await in `try { … } finally { clearInterval(heartbeatTimer); }`. Verified by a unit test path that cancels mid-run.
5. **Dashboard XSS via role.output text.** Agent stdout may contain `<script>` or other HTML. **Mitigation**: the panel uses `createTextNode` exclusively. The existing `dashboard-html.test.ts` assertion `expect(html).not.toContain('innerHTML')` guards regression. Add a new assertion that the live-output render path uses `createTextNode`.
6. **SSE snapshot staleness.** The dashboard pulls a fresh snapshot on SSE signal, but `latest_events` may be capped (e.g., last 50). If `role.output` events flood the stream, the panel may miss older lines. **Mitigation**: the panel is a FIFO of the last 500 *role.output* lines, not the last 500 events. If `latest_events` itself is capped below 500, the panel shows whatever is available. Follow-up: raise the `latest_events` cap or add a dedicated `latest_output` field to the snapshot. Out of scope for R5-Live.
7. **Fake-agent test flakiness on CI.** The integration test uses real `setInterval` and `setTimeout` for the throttle. Under load, a 500 ms tick may fire at 600 ms and the test's assertion "exactly 1 event per 500 ms" becomes flaky. **Mitigation**: assert *at least 1* `role.output` event and *at most* `ceil(duration_ms / 500) + 1`, not exact counts. Use vitest fake timers for the heartbeat assertion (deterministic).
8. **`runProcessRaw` divergence.** `runProcessRaw` (line 538) duplicates much of `runProcess` but is not modified. If a future task adds `onOutput` to `runProcessRaw`, the throttle logic must be duplicated or extracted. **Mitigation**: leave a `// TODO: extract throttle when runProcessRaw needs onOutput` comment is *not* added (per the no-comments rule). Instead, the throttle helper is a private function inside `process-runner.ts` that both could call later. For R5-Live, only `runProcess` uses it.
