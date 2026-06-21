# Phase 9 Review Loop Observability And Interactive UI Requirements

> Scope: event stream, live progress, and interactive operator visibility for `review-loop`
> Builds on: Phase 8D parallel worktrees and Phase 8E integration/finalization
> Design input: Hermes Deck comparison supplied by the user on 2026-06-21

## Problem

`review-loop` is a strict multi-role pipeline:

```text
Planner -> Developer -> Verify -> Auditor -> Final Auditor -> Finalize
```

That makes it strong for production code changes, but weak for operator visibility. Today the user sees the run mostly through terminal output, `.agent/state.json`, final transcript snapshots, and post-run artifacts. During a long run, the user cannot easily answer:

- which role is active;
- which task or wave is active;
- what the active agent has already said;
- which verification command is running;
- whether a subprocess is alive, idle, blocked, or waiting for model quota;
- which audit finding caused a rework loop;
- which artifact contains the evidence for the current decision;
- how much progress was already completed before a resume.

The Hermes Deck comparison highlights the missing product experience: Hermes Deck uses a chat/session metaphor and a real-time transport, while `review-loop` uses a fixed, auditable state machine and subprocess stdout snapshots. `review-loop` should not become a chat-style scheduler, but it should borrow Hermes Deck's live event and session visibility.

## Product Direction

Keep the `review-loop` pipeline as the source of truth. Add a visibility layer on top of it.

The UI should show a live shared workspace for the run:

- phase timeline;
- role cards for Planner, Developer, Verify, Auditor, Final Auditor, and Finalize;
- wave/task progress for task-graph runs;
- live agent output and heartbeat summaries;
- verification logs and exit codes;
- audit decisions and rework reasons;
- artifacts, diffs, and evidence links;
- quota/provider failures as first-class status events;
- resume history across process restarts.

## Hermes Deck Lessons To Adopt

### Adopt: Real-Time Event Transport

Hermes Deck's useful lesson is that the frontend should not poll scattered snapshot files. `review-loop` should emit structured events while the pipeline is running.

Phase 9 must introduce a durable event stream and a live stream surface. The durable stream is required for resume and postmortem. The live stream is required for UI.

### Adopt: Session/Profile Visibility

Hermes Deck has a session model. `review-loop` already has `run_id`; Phase 9 should make run identity visible and navigable:

- current run;
- prior runs;
- role transcripts;
- task runs;
- resume attempts;
- provider/model profile used by each role.

This is observability only. It does not change scheduling ownership.

### Consider Later: Toolized Delegation

Hermes Deck can delegate to dynamic subagents. That is not Phase 9 R1 scope.

Phase 9 should leave room for a later internal API such as:

```ts
requestSecondOpinion({ to: 'codex', prompt, context })
```

That future API may help Planner or Auditor ask for a second opinion inside a phase, but it must not replace the fixed pipeline or weaken audit gates.

### Do Not Adopt: Chat-Driven Scheduling

Do not convert `review-loop` into a freeform chat agent. The state machine, legal transitions, scope guard, diff digest, verification gates, Auditor, and Final Auditor remain the core value of this project.

## Visibility Boundary

The UI may display:

- prompts and prompt file paths;
- visible agent stdout/stderr;
- final agent responses;
- heartbeat messages;
- tool and command status;
- verification logs;
- audit findings;
- structured decision summaries;
- artifact metadata and links;
- provider/model names and quota failures.

The UI must not require or expose raw private chain-of-thought. When the user asks to see "thinking", Phase 9 should show shareable reasoning summaries, decisions, assumptions, progress notes, and evidence. This keeps the UI useful without depending on private model internals.

## Goals

1. Add a durable structured run event stream.
2. Emit events for all major state transitions and role lifecycle changes.
3. Emit live events for agent output, heartbeat, subprocess start, subprocess exit, and provider failures.
4. Emit verification command events, including command, status, exit code, duration, and log artifact paths.
5. Emit task-graph events for waves, tasks, worker worktrees, and integration phases.
6. Provide a terminal watch UI that reads the same event stream.
7. Design the event model so a later Web UI can reuse it without changing orchestrator semantics.
8. Preserve resume behavior and make resumed history visible.
9. Keep all audit and finalization invariants unchanged.

## Non-Goals

1. Do not implement dynamic chat-driven scheduling.
2. Do not remove Planner, Developer, Auditor, or Final Auditor roles.
3. Do not weaken scope guard, diff digest, verification, or final audit gates.
4. Do not expose raw private chain-of-thought.
5. Do not require a web server for the first slice.
6. Do not replace existing transcripts or evidence files.
7. Do not make provider routing decisions in Phase 9 R1.

## Functional Requirements

### R1. Durable Event Stream

Each run must write a durable event log:

```text
.agent/events.jsonl
```

For task-graph worker runs, each worker may also write a local event log, but the parent run must ingest or reference worker progress so the top-level UI can render the whole pipeline.

The event stream must be append-only for a run. Resume must continue the sequence without destroying prior history.

### R2. Event Schema

Each event must include:

- schema version;
- run id;
- monotonically increasing sequence number within the run;
- event id;
- timestamp;
- event kind;
- phase;
- optional role;
- optional task id;
- optional wave index;
- status or level;
- short human-readable message;
- optional structured payload;
- optional artifact references.

The schema must be stable enough for CLI watch and Web UI consumers.

### R3. Phase And Role Lifecycle Events

The orchestrator must emit events when:

- a run starts;
- a run resumes;
- phase changes;
- a role starts;
- a role emits heartbeat;
- a role writes visible output;
- a role exits;
- a role fails;
- a run becomes PASSED, BLOCKED, or FAILED.

### R4. Verification Events

Verification commands must emit events for:

- command start;
- command stdout/stderr log artifact paths;
- command success;
- command failure;
- duration;
- exit code.

The event should link to existing verification log files instead of duplicating large logs into every event.

### R5. Audit And Rework Events

Auditor and Final Auditor decisions must be visible as structured events:

- decision;
- finding count;
- severity;
- rework reason;
- artifact path for the full audit report;
- diff digest that was audited.

When the run loops back to Developer, the event stream must make the cause obvious.

### R6. Task Graph And Wave Events

For task-graph runs, Phase 9 must render:

- task graph summary;
- wave start and completion;
- per-task status;
- worker branch and worktree path;
- worker provider/model profile;
- blocked tasks;
- excluded tasks;
- integration branch;
- integration audit status;
- finalization status.

### R7. Live Watch CLI

Add a terminal UI or watch command that reads the event stream and updates live:

```bash
review-loop status --watch
```

The first implementation may be simple text output, but it must show:

- current phase;
- active role;
- elapsed time;
- latest event;
- task/wave progress;
- last failure or blocker;
- artifact paths for details.

### R8. JSON Output For UI

The watch command must support machine-readable output:

```bash
review-loop status --watch --json
```

The JSON stream should be line-delimited events so a Web UI, desktop UI, or external bridge can consume it.

### R9. Future JSON-RPC Transport Compatibility

The event schema must be compatible with a future JSON-RPC over stdio transport. Phase 9 R1 does not have to implement a full JSON-RPC server, but it must not bake in assumptions that make JSON-RPC difficult later.

### R10. Quota And Provider Failure Visibility

Provider failures such as "out of credits" must be emitted as explicit events with:

- role;
- provider;
- model if known;
- error classification;
- stderr artifact path;
- suggested next step.

This requirement exists because repeated `resume` attempts can otherwise waste operator time and possibly quota.

### R11. Resume Visibility

On resume, the UI must show:

- previous completed phases;
- prior attempts per phase;
- current state loaded from `.agent/state.json`;
- latest event sequence;
- whether the next action will start a model call, local verification, audit, or finalization.

### R12. Artifact Links

Events should reference artifacts by path and type:

- transcript;
- stdout/stderr log;
- verification log;
- diff;
- scope report;
- audit report;
- final audit report;
- integration metadata;
- state snapshot.

The UI should open or display these artifacts without guessing file names.

### R13. Backward Compatibility

Existing runs without `.agent/events.jsonl` must still be readable by current status commands where possible. The event UI may show "no event stream available" for older runs, but `review-loop resume` must continue to work.

### R14. Tests

Phase 9 must include tests for:

- event append and sequence stability;
- resume after existing event log;
- role lifecycle event emission;
- verification event emission;
- provider failure event emission;
- task-graph wave event emission;
- `status --watch --json` reading existing and appended events.

## Acceptance Criteria

Phase 9 R1 is acceptable when:

1. a normal serial run produces `.agent/events.jsonl`;
2. a task-graph run produces top-level task/wave events;
3. a provider failure is visible as a structured event;
4. `review-loop status --watch --json` streams new events while a run is active;
5. the event stream survives resume;
6. existing audit and verification gates behave unchanged;
7. tests cover the new event model and watch behavior.

