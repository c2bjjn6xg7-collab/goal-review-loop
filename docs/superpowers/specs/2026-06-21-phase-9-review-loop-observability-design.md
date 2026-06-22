# Phase 9 Review Loop Observability And Interactive UI Design

> Requirements: `docs/superpowers/specs/2026-06-21-phase-9-review-loop-observability-requirements.md`
> Parent context: Phase 8D parallel execution, Phase 8E integration/finalization

## Decision Summary

Phase 9 adds a structured event layer around the existing `review-loop` state machine. The event layer records what the orchestrator is doing, what each role has emitted, what verification commands are running, why audits rework, and where artifacts live.

The scheduler remains a strict pipeline. The UI reads events; it does not own scheduling.

The first implementation should deliver:

1. a durable `.agent/events.jsonl`;
2. event emission from orchestrator state changes, agent subprocesses, verification commands, and task-graph waves;
3. `review-loop status --watch`;
4. `review-loop status --watch --json`.

A later slice can build a Web dashboard or JSON-RPC server on the same event model.

## Architecture

```text
orchestrator
  -> EventBus
    -> EventStore(.agent/events.jsonl)
    -> Live subscribers(status --watch, --json)

agent subprocesses
  -> stdout/stderr readers
    -> EventBus(role.output, role.error, role.heartbeat, role.exit)

verification commands
  -> command runner
    -> EventBus(verification.start, verification.pass, verification.fail)

task graph/wave executor
  -> EventBus(wave.start, task.start, task.pass, task.blocked, integration.*)
```

## Event Model

Suggested TypeScript shape:

```ts
export type ReviewLoopEventKind =
  | 'run.started'
  | 'run.resumed'
  | 'run.completed'
  | 'run.blocked'
  | 'phase.changed'
  | 'role.started'
  | 'role.heartbeat'
  | 'role.output'
  | 'role.error'
  | 'role.exited'
  | 'verification.started'
  | 'verification.completed'
  | 'verification.failed'
  | 'audit.decision'
  | 'rework.requested'
  | 'task.started'
  | 'task.completed'
  | 'task.blocked'
  | 'wave.started'
  | 'wave.completed'
  | 'integration.started'
  | 'integration.completed'
  | 'integration.blocked'
  | 'provider.failure'
  | 'artifact.created';

export interface ReviewLoopEvent {
  schema_version: 1;
  run_id: string;
  seq: number;
  event_id: string;
  ts: string;
  kind: ReviewLoopEventKind;
  phase: string;
  role?: 'planner' | 'developer' | 'auditor' | 'final-auditor' | 'verifier' | 'finalizer';
  task_id?: string;
  wave_index?: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  status?: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  exit_code?: number;
  artifact_refs?: ArtifactRef[];
  payload?: Record<string, unknown>;
}

export interface ArtifactRef {
  type:
    | 'prompt'
    | 'transcript'
    | 'stdout'
    | 'stderr'
    | 'verification-log'
    | 'diff'
    | 'scope-report'
    | 'audit-report'
    | 'final-audit'
    | 'integration-metadata'
    | 'state';
  path: string;
  label?: string;
}
```

Rules:

- `seq` is assigned by `EventStore`, not by callers.
- `event_id` is stable and unique inside a run.
- event payloads stay small.
- large text stays in artifacts and is linked by `artifact_refs`.
- visible agent output may be streamed as small chunks, but the full transcript remains in transcript files.

## Visibility Boundary

Phase 9 should display "thinking" as shareable operational reasoning:

- current assumption;
- chosen next action;
- audit finding summary;
- verification result;
- blocker explanation;
- suggested next step.

Phase 9 must not require raw private chain-of-thought. If a provider offers reasoning summaries, those may be displayed as summaries only when they are part of normal visible output or explicit metadata allowed by that provider.

## Event Store

Create a small append-only event store, likely under `src/runtime/event-store.ts`.

Responsibilities:

- create `.agent/events.jsonl` if missing;
- read last sequence on startup or resume;
- append events atomically enough for one orchestrator process;
- expose `readEvents()` for status commands;
- expose `followEvents()` for watch mode;
- tolerate a trailing partial line by ignoring it and reporting a warning event or status warning.

The initial implementation can assume one writer per run because `review-loop` already uses run locks. Task worker event logs can be ingested by the parent or referenced as artifacts.

## Event Bus

Create `src/runtime/event-bus.ts`.

Responsibilities:

- normalize caller events;
- attach run id, timestamp, sequence, and event id;
- write through `EventStore`;
- notify in-process subscribers used by watch mode where applicable;
- fail soft: event emission failure should warn and continue unless the failure corrupts required state.

The event bus must not become the state machine. `.agent/state.json` remains the authoritative state for resume.

## Orchestrator Integration Points

Emit events at these points:

1. initial run creation;
2. resume load;
3. legal phase transition;
4. agent subprocess spawn;
5. agent stdout/stderr line or summarized chunk;
6. heartbeat;
7. agent exit;
8. verification command start/end;
9. audit decision parse;
10. rework transition;
11. task graph wave start/end;
12. task worker start/end;
13. integration merge start/end;
14. integrated audit start/end;
15. finalization commit/tag start/end;
16. provider failure classification.

Keep existing transcript, debug, and verification files. The event stream references them.

## Provider Failure Classification

Provider errors should be converted into structured events. For example:

```json
{
  "kind": "provider.failure",
  "role": "auditor",
  "provider": "openai",
  "model": "gpt-5.5",
  "level": "error",
  "message": "Codex workspace is out of credits",
  "payload": {
    "classification": "quota_exhausted",
    "retry_recommended": false
  },
  "artifact_refs": [
    { "type": "stderr", "path": ".agent/debug/20260621080825-3ppz47-auditor-iter2.stderr.log" }
  ]
}
```

This directly addresses the recent repeated resume confusion: the UI should make it clear that another resume will retry the same quota-blocked model call.

## Watch CLI

Add:

```bash
review-loop status --watch
review-loop status --watch --json
```

Text mode should render a compact, updating view:

```text
Run: 20260621080825-3ppz47  Phase: AUDITING  Iteration: 2
Active: Auditor  Provider: openai/gpt-5.5
Wave: 1/1  Tasks: 1 passed, 0 blocked, 0 running

Latest:
10:38:41 verification.completed targeted/full/typecheck/lint/build passed
10:38:46 role.started auditor
10:39:01 provider.failure auditor quota_exhausted

Artifacts:
.agent/transcripts/iteration-02-auditor.md
.agent/debug/20260621080825-3ppz47-auditor-iter2.stderr.log
```

JSON mode should emit raw event JSONL in event order. It can start by replaying existing events and then following appended events.

## Future Web Dashboard

The Web dashboard should use the same event stream. Suggested layout:

- top status bar: run id, branch, phase, elapsed time, result;
- pipeline timeline: Planner, Developer, Verify, Auditor, Final Auditor, Finalize;
- task graph lane: waves and task cards for parallel runs;
- transcript panel: visible agent output and prompt links;
- verification panel: command logs and exit codes;
- audit panel: findings, decision, diff digest;
- artifact panel: files grouped by type;
- control panel: pause, cancel, resume, retry blocked phase.

The dashboard should be a consumer, not a second scheduler.

## JSON-RPC Compatibility

Hermes Deck uses JSON-RPC over stdio for real-time UI. Phase 9 R1 can start with JSONL because it is simpler and robust for resume. The schema should still map cleanly to future JSON-RPC notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "reviewLoop/event",
  "params": { "...ReviewLoopEvent": "..." }
}
```

Do not implement a JSON-RPC server in R1 unless the event store and watch command are already stable.

## File Plan

Likely new files:

- `src/runtime/event-store.ts`
- `src/runtime/event-bus.ts`
- `src/cli/status-watch.ts` or equivalent CLI module
- `tests/unit/event-store.test.ts`
- `tests/unit/event-bus.test.ts`
- `tests/integration/status-watch.test.ts`

Likely modified files:

- `src/orchestrator/run-orchestrator.ts`
- `src/orchestrator/task-graph-wave-loop.ts`
- `src/orchestrator/integration-audit.ts`
- `src/orchestrator/integration-finalizer.ts`
- verification command runner module if separated in the current codebase
- agent subprocess runner module if separated in the current codebase
- CLI command registration

Keep the first slice narrow. Prefer adding explicit `emitEvent(...)` calls at high-signal boundaries over trying to stream every byte from every command.

## Testing Strategy

Unit tests:

- append events with monotonically increasing sequence;
- resume appends after existing sequence;
- malformed trailing JSONL line is tolerated;
- event bus fills required metadata;
- provider quota stderr maps to `provider.failure`;
- artifact refs are preserved.

Integration tests:

- serial fake-agent run writes lifecycle events;
- verification command emits start and completed events;
- audit rework emits `audit.decision` and `rework.requested`;
- task-graph wave run emits wave and task events;
- `status --watch --json` replays existing events and follows appended events.

Regression tests:

- existing state resume still works without events;
- event write failure does not corrupt state;
- no broad scheduler behavior changes.

## Migration

Existing runs without `.agent/events.jsonl` remain valid. The status UI should show state and known artifacts from existing files, then explain that live event history is unavailable for that run.

New runs create `.agent/events.jsonl` at run start.

