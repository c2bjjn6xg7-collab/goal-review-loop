# Task-Graph Integration Audit Rework Loop

> Date: 2026-06-23
> Status: Spec — ready for implementation
> Priority: High — integration auditor REWORK causes immediate BLOCKED instead of auto-retry

## Problem

In **serial mode** (`run-orchestrator.ts`), when the auditor returns REWORK:
1. `validateAuditorOutput()` parses the auditor's output for PASS/REWORK decision
2. On REWORK: `writeReworkInstructions()` generates rework guidance, transition to REWORKING, `iteration++`, developer re-runs with rework instructions
3. This loops up to `max_iterations` times

In **task-graph mode** (`task-graph-loop.ts` line 690-810), the integration auditor:
1. Runs the auditor agent
2. If auditor agent **succeeds** (exit 0) → assumes PASS, goes straight to FINALIZING
3. **Never calls `validateAuditorOutput()`** — doesn't parse PASS vs REWORK
4. If auditor returns REWORK → treated as PASS (wrong!), goes to FINALIZING, then Final Auditor catches it → BLOCKED

**Result:** Integration auditor feedback is ignored. Developer never gets a chance to fix issues. Run BLOCKED instead of auto-retrying.

## Goal

Add rework loop to task-graph integration audit, mirroring serial mode:
1. Parse auditor output with `validateAuditorOutput()`
2. On REWORK: write rework instructions, re-run the **last failed task's developer** with rework feedback
3. Re-audit, loop up to `max_iterations` times
4. On PASS: proceed to FINALIZING (current behavior)
5. On max iterations exhausted: BLOCKED

## Implementation

### 1. Parse audit decision in task-graph-loop.ts

**File**: `src/orchestrator/task-graph-loop.ts` (line ~770-810)

After auditor agent succeeds, call `validateAuditorOutput()`:

```ts
import { validateAuditorOutput } from '../agents/auditor-adapter.js';

// After auditorResult.status === 'success':
const auditValidation = await validateAuditorOutput(
  projectRoot,
  auditorResult,
  auditIteration,
  runId,
  config,
);

const decision = auditValidation.effectiveDecision ?? auditValidation.decision;

if (decision === 'PASS') {
  // Current behavior: emit audit.decision PASS, proceed to FINALIZING
} else {
  // REWORK: write rework instructions, re-run developer on last task
}
```

### 2. Rework loop

Wrap the audit + developer re-run in a loop:

```ts
for (let integrationIteration = 1; integrationIteration <= maxIterations; integrationIteration++) {
  // ... existing auditor code ...

  const decision = auditValidation.effectiveDecision ?? auditValidation.decision;

  await eventBus.emit({
    kind: 'audit.decision',
    phase: 'AUDITING',
    level: decision === 'PASS' ? 'info' : 'warn',
    message: `Integration Auditor decision: ${decision} (iter ${integrationIteration})`,
    role: 'auditor',
    status: String(decision),
    artifact_refs: [{ type: 'audit-report', path: '.agent/audit-report.md' }],
    payload: { integration_audit: true, diff_digest: diffDigest, iteration: integrationIteration },
  });

  if (decision === 'PASS') break;

  // REWORK: write rework instructions, re-run developer on the last task
  if (integrationIteration >= maxIterations) {
    // Exhausted, BLOCKED
    await transitionToBlocked(stateStore, `Integration audit REWORK after ${maxIterations} iterations`, eventBus);
    return makeBlockedResult(runId, projectRoot, `Integration audit REWORK after ${maxIterations} iterations`, 'AUDIT_REWORK_EXHAUSTED', currentBranch);
  }

  // Write rework instructions (same as serial mode)
  const reworkContent = buildReworkFindingsFromAudit(auditValidation, ...);
  await writeReworkInstructions(projectRoot, reworkContent);

  // Re-run developer on the last task with rework instructions
  await stateStore.transition(PhaseEnum.REWORKING);
  // ... re-run developer on last task (similar to serial mode's rework path) ...
  // ... re-compute diffDigest ...
}
```

### 3. Which task to re-run on REWORK?

The integration auditor audits the **merged diff of all tasks**. On REWORK, we need to re-run a developer. The simplest approach: re-run the **last task** (task N) since it's the one most likely to have integration issues. The developer gets:
- The auditor's rework instructions (what's wrong)
- The current merged state (all tasks' changes)
- Its original task scope

This mirrors serial mode where developer re-runs with rework instructions on the same codebase.

### 4. Imports needed

```ts
import { validateAuditorOutput, buildAuditorInput } from '../agents/auditor-adapter.js';
import { buildReworkInstructions, writeReworkInstructions, buildReworkFindingsFromAudit } from './rework-instructions.js';
```

## Non-Goals

- Do not change serial mode (it already has rework loop)
- Do not change per-task developer rework (already works in task-graph)
- Do not change wave mode's integration audit (separate path in task-graph-wave-loop.ts)
- Only fix task-graph-loop.ts (serial task-graph mode)

## Testing

- Integration test: task-graph run where auditor returns REWORK on first pass, PASS on second → run reaches PASSED
- Integration test: task-graph run where auditor returns REWORK on all iterations → BLOCKED with AUDIT_REWORK_EXHAUSTED

## Files to Touch

| File | Change |
|---|---|
| `src/orchestrator/task-graph-loop.ts` | Add validateAuditorOutput + rework loop around integration audit |

## Context

- Serial rework: `src/orchestrator/run-orchestrator.ts` line 1084 (iteration loop) + line 1216 (writeReworkInstructions)
- validateAuditorOutput: `src/agents/auditor-adapter.ts`
- buildReworkFindingsFromAudit: `src/orchestrator/rework-instructions.ts`
- Task-graph integration audit: `src/orchestrator/task-graph-loop.ts` line 690-810
