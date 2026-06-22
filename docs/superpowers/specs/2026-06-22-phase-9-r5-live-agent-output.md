# Phase 9 R5-Live: Real-Time Agent Output Streaming

> Date: 2026-06-22
> Status: Spec — ready for review-loop implementation
> Parent: `2026-06-21-phase-9-review-loop-observability-requirements.md`
> Satisfies: R3 items "a role emits heartbeat" + "a role writes visible output" (lines 163-164), Goal #3 (line 102), UI item "live agent output" (line 37) + "visible agent stdout/stderr" (line 86)

## Problem

Phase 9 R1-R4 emit boundary events (role.started, role.exited) but **no in-progress output events**. While an agent (claude/codex) runs for 3-10 minutes, the event stream is silent. The dashboard shows "Developer is running iteration 1/3" but the operator cannot see what the agent is actually doing until it finishes and a transcript file is written.

The requirements document explicitly asks for this (lines 37, 86, 102, 163-164). The event types `role.output` and `role.heartbeat` are already defined in `ReviewLoopEventKind` (`src/runtime/event-store.ts`) but have zero emit points.

## Constraint: No Raw Chain-of-Thought

Requirements line 96: "The UI must not require or expose raw private chain-of-thought."

Claude and Codex stdout contains `<thinking>` blocks, internal reasoning, and tool-call JSON. These must be **filtered** before emitting as `role.output`. The operator should see:
- ✅ Progress messages ("Editing src/foo.ts", "Running tests")
- ✅ Tool call summaries (file paths, command names — not full arguments)
- ✅ Short text output (agent's visible response, capped at ~500 chars per chunk)
- ❌ `<thinking>` / `<antThinking>` blocks
- ❌ Full tool-call JSON payloads
- ❌ API keys / secrets (already handled by StreamRedactor)

## Implementation

### 1. process-runner.ts: emit role.output on stdout chunks

**File**: `src/runtime/process-runner.ts`

The `onData` callback (line ~397) currently writes stdout to a file and returns. Add an optional `onOutput` callback parameter to `runProcess` that receives filtered, throttled text chunks.

```ts
interface RunProcessOptions {
  // ... existing fields ...
  onOutput?: (params: { stream: 'stdout' | 'stderr'; text: string }) => void;
}
```

In `onData`, after writing to file, if `input.onOutput` is set:
1. Decode the chunk to UTF-8
2. Pass through `filterAgentOutput()` (new function, see below)
3. If non-empty after filtering, call `onOutput({ stream, text: filtered })`

**Throttling**: accumulate chunks, flush every 500ms or when buffer exceeds 2000 chars. Do not emit more than 1 event per 500ms per role. This prevents flooding events.jsonl with thousands of tiny chunks.

### 2. New module: src/runtime/output-filter.ts

Pure function that strips chain-of-thought and extracts visible output.

```ts
export function filterAgentOutput(rawChunk: string): string {
  // 1. Remove <thinking>...</thinking> and <antThinking>...</antThinking> blocks
  // 2. Remove raw JSON tool-call lines (lines starting with {"type":"tool_use" or {"type":"tool_result")
  // 3. Cap remaining text at 500 chars per chunk
  // 4. Return empty string if nothing visible remains
}
```

Unit tests must cover:
- Plain text passes through
- `<thinking>` block stripped
- `<antThinking>` block stripped
- JSON tool-call line stripped
- Mixed content (thinking + visible text) → only visible text
- Over 500 chars → truncated with "…" suffix
- Empty after filtering → returns ""

### 3. agent-adapter.ts: wire onOutput to EventBus

**File**: `src/agents/agent-adapter.ts`

`runAgent()` calls `runProcess()`. Pass an `onOutput` callback that emits `role.output` events through the EventBus.

The EventBus must be passed into `runAgent()` as an optional parameter. The orchestrator already creates the EventBus — thread it through `buildPlannerInput` / `buildDeveloperInput` / `buildAuditorInput` / `buildFinalAuditorInput` and into `runAgent`.

```ts
await eventBus.emit({
  kind: 'role.output',
  phase: currentPhase,
  level: 'info',
  message: filteredText.slice(0, 120),  // short preview
  role: role,
  provider: provider,
  payload: { text: filteredText, stream: 'stdout' },
});
```

### 4. role.heartbeat: periodic "still alive" signal

While an agent runs, emit a `role.heartbeat` event every 30 seconds. This tells the operator the agent hasn't hung.

In `runAgent()`, start a `setInterval(30000)` after spawning the process. Each tick emits:
```ts
{ kind: 'role.heartbeat', phase, level: 'debug', message: `${role} still running (${elapsed}s)`, role, payload: { elapsed_ms } }
```

Clear the interval when the process exits.

### 5. Dashboard: live output panel

**File**: `src/web/dashboard-html.ts`

Add a "Live Output" section below the events table. When a `role.output` SSE event arrives:
- Append the text to a scrolling `<pre>` element (max 500 lines, FIFO)
- Show the role name and timestamp as a prefix
- Auto-scroll to bottom unless the user has scrolled up (detect with scrollTop)

When a `role.heartbeat` arrives, update a "last heartbeat: 32s ago" indicator next to the active role.

### 6. status --watch text mode: show latest output

**File**: `src/cli/status.ts`

In `renderTextSummary`, if the last few events include `role.output`, show the most recent one as a preview line:
```
Active: developer  Provider: anthropic  Heartbeat: 32s ago
Output: Editing src/foo.ts...
```

## What NOT to do

- Do NOT emit raw stdout without filtering (chain-of-thought constraint).
- Do NOT emit more than 1 role.output per 500ms per role (events.jsonl would bloat).
- Do NOT change the process-runner's file-writing behavior (transcripts must still be complete).
- Do NOT add role.output to task-graph worker runs in this phase (wave-mode workers run in worktrees; their stdout is captured per-worker). Serial + single-task-graph only.
- Do NOT change review-loop.yaml.
- Do NOT modify the scope guard, diff digest, or audit gates.

## Testing

1. `tests/unit/output-filter.test.ts` — filterAgentOutput pure function tests (thinking stripped, JSON stripped, truncation, empty).
2. `tests/unit/process-runner-output.test.ts` — onOutput callback fires with filtered text, throttling works.
3. `tests/integration/agent-output-events.test.ts` — run a fake-agent that writes stdout, assert events.jsonl contains role.output events with filtered text (no thinking blocks).
4. `tests/unit/dashboard-html.test.ts` — assert live output panel renders role.output text.

## Files to touch

| File | Change |
|---|---|
| `src/runtime/output-filter.ts` | NEW — filterAgentOutput pure function |
| `src/runtime/process-runner.ts` | Add onOutput callback param + throttling |
| `src/agents/agent-adapter.ts` | Wire onOutput → EventBus role.output emit + heartbeat interval |
| `src/orchestrator/run-orchestrator.ts` | Pass eventBus into buildXxxInput → runAgent |
| `src/web/dashboard-html.ts` | Add live output panel |
| `src/cli/status.ts` | Show latest role.output in text summary |
| `tests/unit/output-filter.test.ts` | NEW |
| `tests/unit/process-runner-output.test.ts` | NEW |
| `tests/integration/agent-output-events.test.ts` | NEW |
