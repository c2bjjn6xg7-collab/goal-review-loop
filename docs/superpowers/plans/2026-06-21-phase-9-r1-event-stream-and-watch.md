# Phase 9 R1 Event Stream And Watch Implementation Plan

> **For agentic workers:** Follow `docs/superpowers/agent-task-planning-guidelines.md`. This is an observability slice. Do not change scheduling, provider routing, audit policy, or finalization semantics.

**Goal:** Add a durable `review-loop` event stream and a watch command so the user can see live pipeline progress, visible agent output, verification status, audit decisions, task/wave progress, and quota/provider blockers.

**Source Specs:**

- `docs/superpowers/specs/2026-06-21-phase-9-review-loop-observability-requirements.md`
- `docs/superpowers/specs/2026-06-21-phase-9-review-loop-observability-design.md`

**Critical Invariants:**

- The state machine remains authoritative.
- Event emission must not weaken scope guard, diff digest, verification, audit, or final audit gates.
- The UI must not depend on raw private chain-of-thought.
- Provider quota failures must be visible and should discourage repeated wasteful resume attempts.
- Existing runs without events must still resume.

---

## Files

Expected files for R1:

- Create: `src/runtime/event-store.ts`
- Create: `src/runtime/event-bus.ts`
- Create: `tests/unit/event-store.test.ts`
- Create: `tests/unit/event-bus.test.ts`
- Modify: CLI command registration for `review-loop status --watch`
- Modify: orchestrator lifecycle emission points
- Modify: agent subprocess runner emission points
- Modify: verification command emission points
- Modify: task-graph wave emission points
- Create or modify: `tests/integration/status-watch.test.ts`

Optional, only if the current codebase structure requires it:

- Create: `src/cli/status-watch.ts`
- Modify: transcript/debug log writer helpers

Do not modify:

- provider/model routing
- Planner/Developer/Auditor command templates
- task graph scheduling rules
- integration merge/cherry-pick policy
- final audit prompt semantics
- commit/tag policy

---

## Task 1: Event Store

**Files:**

- Create: `src/runtime/event-store.ts`
- Create: `tests/unit/event-store.test.ts`

### Step 1: Add tests first

Cover:

1. creating `.agent/events.jsonl` when missing;
2. appending events with sequence numbers;
3. continuing sequence after resume;
4. reading existing events in order;
5. ignoring or reporting a trailing partial JSONL line without crashing;
6. preserving artifact refs and payloads.

### Step 2: Implement event store

Implement a small append-only store with:

- constructor receiving `agentDir` and `runId`;
- `append(eventDraft)`;
- `readAll()`;
- `readSince(seq)`;
- `getLastSequence()`.

The store assigns `seq`, `event_id`, and `ts`.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/unit/event-store.test.ts
```

---

## Task 2: Event Bus

**Files:**

- Create: `src/runtime/event-bus.ts`
- Create: `tests/unit/event-bus.test.ts`

### Step 1: Add tests first

Cover:

1. required fields are normalized;
2. events include run id and phase;
3. provider quota stderr can be emitted as `provider.failure`;
4. event emission failure is surfaced as a warning path without changing orchestration state;
5. subscribers receive appended events in order.

### Step 2: Implement event bus

The bus should wrap `EventStore` and expose:

```ts
emit(eventDraft)
subscribe(listener)
```

Keep the API small. The bus is for observability, not scheduling.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/unit/event-bus.test.ts tests/unit/event-store.test.ts
```

---

## Task 3: Orchestrator Lifecycle Events

**Files:**

- Modify: `src/orchestrator/run-orchestrator.ts`
- Modify related state transition tests if present

### Step 1: Add coverage

Cover a fake run that emits:

1. `run.started`;
2. `phase.changed`;
3. role start/exit events;
4. `run.completed` or `run.blocked`.

### Step 2: Wire event bus

Create the event bus during run initialization and pass it to the high-signal orchestration helpers. Emit on legal phase transitions and terminal states.

Do not make event writes a hard dependency for state writes unless the event file itself is corrupted in a way that prevents safe append.

### Step 3: Verify

Run the smallest orchestrator integration tests that exercise a successful fake-agent run.

---

## Task 4: Agent And Verification Events

**Files:**

- Modify agent subprocess runner module
- Modify verification command runner module
- Modify tests for fake-agent and verification flows

### Step 1: Agent events

Emit:

- `role.started` with role, provider, model, prompt artifact;
- `role.heartbeat` when heartbeat is observed or synthesized;
- `role.output` for visible output chunks or summarized lines;
- `role.error` for stderr highlights;
- `provider.failure` for classified quota/provider failures;
- `role.exited` with exit code and transcript refs.

### Step 2: Verification events

Emit:

- `verification.started`;
- `verification.completed`;
- `verification.failed`;
- artifact refs for stdout/stderr logs;
- duration and exit code.

### Step 3: Verify

Run targeted tests for fake agent, verification, and provider failure classification.

---

## Task 5: Task Graph And Integration Events

**Files:**

- Modify: `src/orchestrator/task-graph-wave-loop.ts`
- Modify: `src/orchestrator/integration-audit.ts`
- Modify: `src/orchestrator/integration-finalizer.ts`
- Modify task-graph integration tests

### Step 1: Emit task/wave events

Emit:

- `wave.started`;
- `task.started`;
- `task.completed`;
- `task.blocked`;
- `wave.completed`;
- worker branch/worktree refs.

### Step 2: Emit integration events

Emit:

- `integration.started`;
- integration merge result;
- integrated audit decision;
- finalization commit/tag result;
- integration blockers.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/integration/task-graph-parallel-wave.test.ts
```

---

## Task 6: Status Watch CLI

**Files:**

- Create or modify: CLI status/watch module
- Create: `tests/integration/status-watch.test.ts`

### Step 1: JSON watch

Implement:

```bash
review-loop status --watch --json
```

Behavior:

- replay existing events by default;
- follow appended events;
- exit cleanly when the run reaches a terminal event;
- support a test-friendly timeout or abort signal.

### Step 2: Text watch

Implement:

```bash
review-loop status --watch
```

Text mode should show:

- run id;
- phase;
- active role;
- latest event;
- task/wave counts;
- blocker or provider failure;
- key artifact refs.

### Step 3: Verify

Run:

```bash
npm test -- --run tests/integration/status-watch.test.ts tests/unit/event-store.test.ts tests/unit/event-bus.test.ts
```

---

## Task 7: Full Validation

Run:

```bash
npm test -- --run
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

The final result should include a short manual smoke:

```bash
review-loop status --watch --json
```

against a fake-agent run, showing live event output.

---

## R2 Follow-Up

After R1 passes, implement a richer dashboard slice:

- terminal timeline view;
- Web dashboard or desktop panel;
- artifact viewer;
- diff/audit viewer;
- pause/cancel/resume controls;
- optional JSON-RPC over stdio bridge.

That follow-up must consume the R1 event stream rather than reading ad hoc files.

