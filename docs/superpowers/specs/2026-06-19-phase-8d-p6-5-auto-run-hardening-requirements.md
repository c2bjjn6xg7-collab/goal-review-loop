# Phase 8D P6.5 Auto-run Hardening Requirements

## Problem

During the Phase 8D P6 Round 3 plugin run, review-loop reached task-graph task 3 and stayed in `DEVELOPING` with no terminal task result. The saved runtime evidence showed:

- `state.json` phase remained `DEVELOPING`.
- `progress.json` last event was `Running Developer for task 3 (attempt 1)`.
- `task-results.json` only contained results for tasks 1 and 2.
- Task 3 stdout/stderr logs were empty.
- The task prompt only allowed test files, while the eventual working fix also needed orchestrator code.

The system should not silently hang in this state. A plugin-driven run must either complete or transition to a clear `BLOCKED` result with enough evidence for a human to continue.

## Goals

1. Detect Developer stalls during task-graph execution before the full agent timeout elapses.
2. Convert stalled Developer execution into a structured `BLOCKED` result with `AGENT_TIMEOUT`/stall details and log paths.
3. Prevent future task-scope dead ends by validating task graphs before execution.
4. Teach Developer prompts to report scope gaps explicitly instead of silently attempting impossible work.
5. Avoid broad rewrites: keep this as an auto-run reliability hardening layer, not a scheduling redesign.

## Definitions

### Developer Stall

A Developer run is considered stalled when all of these are true for a configured idle window:

- The child process has not exited.
- No stdout/stderr bytes were written.
- The expected handoff file was not updated.
- The run has not been cancelled by the user.

The first implementation may monitor stdout/stderr activity only if handoff mtime monitoring is too invasive, but it must still surface the result as a Developer timeout/stall instead of waiting for the full 30-minute agent timeout.

### Scope Gap

A task has a potential scope gap when its allowed files cannot plausibly satisfy its own verification command or description. The hard requirement for this phase is narrower: flag high-risk task graphs where a task with integration-test verification only allows test files and no source files.

### Scope Expansion Protocol

When a Developer determines it needs to modify a file outside `allowed_changes`, it must write a `BLOCKED` handoff that names the requested file(s) and explains why they are required. It must not modify out-of-scope files.

## Requirements

### R1. Idle Watchdog

- Add a configurable Developer idle watchdog for task-graph Developer execution.
- Default should be conservative: `runtime.agent_idle_timeout_seconds = 480` (8 minutes).
- The watchdog must be shorter than the default Developer timeout (`1800s`) and longer than normal quick tasks.
- If the watchdog fires, the Developer process must be cancelled/killed using the existing process-runner cancellation path.
- The run must become `BLOCKED`, not remain `DEVELOPING`.
- The final error detail must include:
  - task id
  - attempt number
  - idle timeout seconds
  - stdout/stderr log paths
  - suggested action: inspect prompt/logs or widen allowed_changes if the task is scope-blocked

### R2. No Silent Hangs

- `progress.json` and `iteration-log.md` must show a stall/timeout event.
- `task-results.json` must contain a failed result for the stalled task when the task graph path reaches task-result recording.
- If the watchdog returns a terminal result before task-result recording, the terminal result must still contain enough detail for debugging.

### R3. Scope Preflight

- Before executing a task graph, run a lightweight preflight over task nodes.
- For this phase, implement one deterministic rule:
  - If a task has a required verification command referencing `tests/integration/` and `allowed_changes` contains only test paths (`tests/**`) with no source/docs/config path, emit a warning or block according to config.
- Default behavior should be `warn`, not fail, to avoid breaking existing task graphs.
- The warning must be written to `iteration-log.md` before task execution.
- The warning text must name the task id and explain the likely issue.

### R4. Developer Prompt Protocol

- Update task Developer prompt instructions to say:
  - If implementation requires files outside `allowed_changes`, do not modify them.
  - Write `developer-handoff.md` with `status: "BLOCKED"`.
  - Include a short `scope_expansion_request` section naming the needed paths and reason.
- This is prompt/protocol guidance only; do not add a new handoff schema field in this phase.

### R5. Protected Runtime Paths

- Tests and fake agents must not use `.agent/debug`, `.agent/evidence`, `.agent/verification`, or `.agent/history` for counters or sentinels created by Developer/fake Developer code.
- Use `/tmp/review-loop-*` paths for fake-agent counters.

### R6. Tests

Add tests proving:

1. A hanging task-graph Developer is cancelled by the idle watchdog and produces a `BLOCKED` result quickly.
2. The task graph preflight emits a warning for an integration-test-only task whose allowed changes are only `tests/**`.
3. The task Developer prompt includes the scope-expansion protocol text.
4. Existing default config loads `runtime.agent_idle_timeout_seconds === 480`.
5. Explicit config can override `runtime.agent_idle_timeout_seconds` with a small integer for tests.

### R7. Non-goals

- Do not implement automatic provider/model escalation.
- Do not implement automatic scope widening.
- Do not create new task graph scheduling semantics.
- Do not change P6 Round 3 same-provider retry behavior.
- Do not require all scope preflight warnings to block execution.
