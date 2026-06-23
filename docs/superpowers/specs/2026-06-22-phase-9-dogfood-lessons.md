# Phase 9 Dogfood Lessons and Milestone Record

> Date: 2026-06-22 (updated)
> Status: Milestone — Phase 9 R1/R2/R3/R4 complete; R9 (JSON-RPC) deferred
> Anchor: `main@b7d5ec4`, 1304 tests, 7 review tags
> Specs: `2026-06-21-phase-9-review-loop-observability-design.md`, `-requirements.md`

## What shipped

Phase 9 added a structured event layer and an interactive dashboard to `review-loop`. The scheduler remains a strict pipeline; the UI reads events and triggers the existing cancel mechanism — it does not own scheduling.

### Tags

| Tag | Scope | Implemented by |
|---|---|---|
| `phase-9-r1-reviewed` | EventStore, EventBus, orchestrator lifecycle events, `status --watch` (text + json), provider.failure classifier | hand-written + 2 review passes |
| `phase-9-r2a-reviewed` | Read-only web dashboard (HTML + 2s polling) | review-loop (claude planner/developer + codex auditor) |
| `phase-9-r2b-reviewed` | SSE real-time push (`GET /api/events/stream`, hello + heartbeat + polling) | review-loop |
| `phase-9-r2c-reviewed` | Cancel action button (`POST /api/cancel`, reuses `cancel-request.json` + SIGTERM) | review-loop |
| `phase-9-r3-reviewed` | Historical run browser (`GET /api/runs`, run switcher, `GET /api/events?run_id=`) | review-loop |
| `phase-9-r4a-reviewed` | R11 next-action hint + R5 finding_count/rework_reason + R12 transcript/final-audit artifact_refs | review-loop + manual final-audit fix |
| `phase-9-r4b-reviewed` | R6 integration.started/completed/blocked (dead code activated) + task event-level provider/model + worktree_path | review-loop + manual final-audit fix |

R2A through R4B were each produced end-to-end by review-loop driving real `claude` and `codex` agents — the system dogfooding itself. The human role was: write the request, observe via the just-built event stream, do independent verification, and run review passes per slice.

### Test scale

- Baseline before Phase 9: ~1193 tests.
- After R1 merge: 1233.
- After R2C merge: 1269.
- After R3 merge: 1289.
- After R4 merge: **1304 tests, all passing.** Zero regressions at each merge.

## Spec coverage

| Requirement | Status | Notes |
|---|---|---|
| R1 durable event stream | ✅ | `.agent/events.jsonl`, append-only, per-run isolated |
| R2 event schema | ✅ | schema_version, run_id, seq, event_id, ts, kind, phase, level, message, role, task_id, wave_index, status, provider, model, duration_ms, exit_code, artifact_refs, payload |
| R3 phase/role lifecycle events | ✅ | run.started/resumed/completed/blocked/failed, role.started/exited, phase transitions |
| R4 verification events | ✅ | verification.started/completed/failed with duration_ms, exit_code, log artifact_refs |
| R5 audit rich events | ✅ | audit.decision with decision, finding_count, conditional rework_reason, diff_digest, audit-report ref |
| R6 task-graph rich events | ✅ | wave.started/completed, task.started/completed/blocked, integration.started/completed/blocked, worker branch, worktree_path, provider/model |
| R7 live watch CLI | ✅ | `status --watch` text mode |
| R8 JSON output | ✅ | `status --watch --json` line-delimited events |
| R9 JSON-RPC transport | ⏳ deferred | Schema is compatible; implementation is a later phase |
| R10 provider failure | ✅ | provider.failure with classification, retry_recommended, stderr ref |
| R11 resume visibility | ✅ | next-action hint in watch + dashboard, derived from state.json |
| R12 artifact links | ✅ | transcript, stderr, verification-log, diff, audit-report, final-audit, state, prompt |
| R13 backward compat | ✅ | CLI falls back to state polling; dashboard degrades gracefully |
| R14 tests | ✅ | 1304 tests covering all event types, watch, dashboard, isolation, provider failure |

## Dogfood bugs found and fixed

These bugs were invisible in unit/integration tests and only surfaced when review-loop ran against itself with real agents.

### 1. Cross-run event stream contamination (R1)

**Symptom:** A fresh run after a previous run showed two `run.started` events with different `run_id` values.

**Root cause:** `EventStore` writes to a fixed path `.agent/events.jsonl` regardless of `run_id`. A previous run's events persisted; the new run appended to the same file.

**Fix:** `EventStore.archivePreviousRun()` moves any existing `events.jsonl` belonging to a different `run_id` to `.agent/history/events-<runId>.jsonl` before a fresh run emits its first event.

### 2. Task-graph integration auditor missing events (R1)

**Symptom:** Task-graph runs only showed 3 roles in the event stream. The integration Auditor (codex) ran and produced `audit-report.md`, but no `role.started` / `role.exited` / `audit.decision` events were emitted.

**Root cause:** R1 event wiring covered the serial iteration-loop auditor but missed the task-graph integration auditor.

### 3. Stale-terminal-event selection (R1 watch + R2A dashboard)

**Symptom:** A resumed run's append-only history (`run.blocked → run.resumed → run.completed`) caused both `status --watch` and the dashboard to report `BLOCKED` instead of `PASSED`.

**Root cause:** Both consumers used `find()` (first match) instead of `reverse().find()` (last match).

**Note:** This bug appeared independently in hand-written `status.ts` and review-loop-written `event-source.ts` — a recurring pattern trap.

### 4. Concurrency seq duplication (R1)

**Symptom:** Wave-mode concurrent `Promise.all` appends could assign duplicate `seq` values (all `seq=1`).

**Root cause:** `EventStore.append()` computed `seq = getLastSequence() + 1` with no serialization.

**Fix:** In-process promise-chain mutex in `EventStore`.

### 5. FAILED paths missing run.failed event (R1)

**Symptom:** `status --watch` could hang forever on a real FAILED run because no `run.failed` terminal event was emitted.

**Root cause:** 7 FAILED `makeResult` return paths had no `emitRunTerminal` call.

### 6. Wave task events emitted twice (R1)

**Symptom:** Task events double-counted because both the executor `onEvent` bridge and the runner emitted `task.started`/`task.completed`.

**Fix:** onEvent bridge forwards wave-level events only; the runner is the single source for task events.

### 7. integration.* events defined but never emitted (R4b)

**Symptom:** `integration.started`/`integration.completed`/`integration.blocked` were declared in the event schema but had zero emit points — dead code.

**Root cause:** The integration phase in `task-graph-wave-loop.ts` was never wired to the event bus.

### 8. provider/model placed in payload instead of event-level fields (R4b)

**Symptom:** Final auditor rejected because `task.started` events put `provider`/`model` inside `payload` rather than the event-level fields defined by `EventDraft`.

**Root cause:** Developer (claude) followed the payload pattern for task events, but the schema and serial `role.started` events use event-level `provider`/`model` fields.

### 9. opencode planner failures — two distinct root causes (R6)

**Symptom A:** Planner ran for 9-16 minutes (heartbeat persisting) then exit 1 with opencode `--help` output in stderr. stdout empty.

**Root cause A:** review-loop used `npx opencode-ai` which resolves to the npm package `opencode-ai` — this package only ships a Windows launcher script (`opencode.exe`, a 479-byte ASCII text file), not a macOS binary. The real opencode binary is at `~/.opencode/bin/opencode` (native Mach-O arm64), installed by opencode's own installer, not via npm.

**Fix A:** Changed planner command from `npx opencode-ai run` to `~/.opencode/bin/opencode run`. Uninstalled the npm package (`npm uninstall -g opencode-ai`).

**Symptom B:** Planner immediately printed `--help` and exit 1 (0 heartbeat, instant failure).

**Root cause B:** opencode's `run` command uses yargs for argument parsing. The planner prompt (10KB markdown) contains `---` separators and `--flag-like` text. Without a `--` separator before the prompt argument, yargs parsed these as CLI flags, failed, and printed help.

**Fix B:** Added `--` before `"$P"` in the command: `opencode run --model ... --no-replay -- "$P"`. The `--` tells yargs everything after is positional, not flags.

**Lesson:** When integrating any CLI agent that uses yargs (opencode, and potentially others), always add `--` before the prompt argument to prevent the prompt content from being parsed as CLI flags. This is now enforced in `src/cli/config.ts` `buildCommand()` for the opencode provider.

## The value of dual auditors

Phase 9's dogfood runs revealed a clear division of labor between the two auditor passes:

| Auditor | What it catches | Example from dogfood |
|---|---|---|
| **Integration Auditor** (codex, per-iteration) | Functional correctness: does the code do what the task asked? Does it pass tests? | "task passed — the feature works" |
| **Final Auditor** (codex, pre-commit) | Contract correctness: does the code follow the schema, event contract, and design guardrails? | "provider is in payload not event-level", "integration.blocked missing payload.error", "iteration/max hardcoded to 0" |

Both R4 runs passed the integration auditor but were **rejected by the final auditor** for contract violations. This is not a weakness of review-loop — it's the design working as intended. The integration auditor validates behavior; the final auditor validates the contract that downstream consumers (dashboard, watch, future JSON-RPC) depend on.

**Lesson for future phases:** when adding event-emitting code, the final auditor's contract checks are where schema-level bugs get caught. Don't skip or weaken the final audit gate when touching the event layer.

## Event contract guardrails

These rules are derived from the dogfood bugs above. Future Phase 9+ work (R9 JSON-RPC, Phase 10) must follow them.

### 1. Per-run isolation is mandatory

Never read or write `events.jsonl` without respecting `run_id`. The active file belongs to the current run; archived files in `.agent/history/` are historical. Any consumer that ignores `run_id` will mix runs.

### 2. Use the last terminal event, not the first

Any code that derives "current phase" from the event stream must pick the last event whose kind is in `{run.completed, run.blocked, run.failed}`. A resumed history legitimately contains superseded terminal events.

### 3. Event-level fields must not be hidden in payload

Fields defined on `EventDraft` / `ReviewLoopEvent` (`provider`, `model`, `status`, `exit_code`, `duration_ms`, `role`, `task_id`, `wave_index`) must be emitted at the event level, not buried in `payload`. Downstream consumers (watch, dashboard, future JSON-RPC) read event-level fields; `payload` is for kind-specific extras only.

### 4. Blocked/failed events must carry structured error info

`run.blocked`, `run.failed`, `integration.blocked`, `task.blocked`, and `provider.failure` events must include a structured error field (`error` string in payload, or `code`/`message` for provider failures). A blocked event without an error reason is useless to an operator trying to diagnose why.

### 5. Keep serial and task-graph event wiring equivalent

Every role invocation — planner, developer, auditor, final-auditor — must emit the same set of events regardless of which orchestrator path invokes it. When adding a new emit point, grep for all call sites of that role across both `run-orchestrator.ts` and `task-graph-*.ts`.

### 6. Dashboard/transport consumers must not create parallel state

The UI and any future transport (SSE, JSON-RPC) read events; they do not own scheduling. Action buttons reuse existing mechanisms (e.g., `cancel-request.json`), they do not create new control paths.

### 7. Concurrent appends must be serialized

`EventStore.append()` uses an in-process promise-chain mutex. Any new code that appends events concurrently (e.g., wave-mode `Promise.all`) is safe under this mutex. Do not bypass it with direct `fs.appendFile` calls.

### 8. CLI agent commands must use `--` before prompt arguments

Any CLI agent that uses yargs for argument parsing (opencode, and potentially others) will misinterpret `--foo` patterns inside the prompt text as CLI flags. This causes immediate help output + exit 1. Always add `--` before the prompt argument in agent command templates:

```
# WRONG — prompt content parsed as flags:
opencode run --model X --no-replay "$P"

# RIGHT — -- tells yargs everything after is positional:
opencode run --model X --no-replay -- "$P"
```

This is enforced in `src/cli/config.ts` `buildCommand()` for the opencode provider. If adding a new CLI agent provider, apply the same pattern.

### 9. Use the correct binary path, not npx

opencode's native binary is at `~/.opencode/bin/opencode` (installed by opencode's own installer). Do NOT use `npx opencode-ai` — the npm package ships only a Windows launcher, not a macOS binary. The `claude` and `codex` CLIs are installed globally and work via `npx` or direct path. Always verify the binary exists with `which` or `file` before adding it to an agent command template.

## What's next: R9 JSON-RPC (deferred)

The event schema is already compatible with a future JSON-RPC over stdio transport. R9 should:
- Expose the event stream as a JSON-RPC method (e.g., `events/subscribe`, `events/since`, `runs/list`).
- Reuse `EventStore` / `RunLister` / `DashboardEventSource` — do not re-implement.
- Keep the dashboard as a separate consumer; JSON-RPC is for editor/IDE integrations.

R9 is not blocking any current functionality. The dashboard + SSE + cancel + run browser cover the operator visibility use case fully.
