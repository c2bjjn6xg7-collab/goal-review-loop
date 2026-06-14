#!/usr/bin/env node
/* global process:readonly, console:readonly */
/**
 * Fake Agent fixture for testing the review-loop orchestration.
 * Phase 3 §16.2: Configurable test double that can simulate various agent behaviors.
 *
 * Usage: node fake-agent.mjs --role <role> --run-id <id> --iteration <n> [options]
 *
 * Options:
 *   --role <planner|developer|auditor>   Agent role to simulate
 *   --run-id <id>                        Run ID for artifacts
 *   --iteration <n>                      Iteration number
 *   --project-root <path>                Project root directory
 *   --behavior <behavior>                Behavior to simulate (default: success)
 *
 * Behaviors:
 *   success          - Write valid artifacts (default)
 *   invalid-goal     - Planner: write GOAL with invalid paths
 *   modify-business  - Planner: modify a business file
 *   blocked-handoff  - Developer: write BLOCKED handoff
 *   modify-goal      - Developer: modify GOAL.md
 *   scope-violation  - Developer: modify a disallowed file
 *   forge-evidence   - Developer: forge a file in .agent/evidence/
 *   break-prompt-cleanup - Developer: make debug dir read-only
 *   rework-success   - Developer: write valid handoff for rework (iteration > 1)
 *   rework-fail      - Developer: still fails after rework
 *   no-artifact      - Don't write any artifact
 *   timeout          - Sleep until timeout
 *   exit-error       - Exit with non-zero code
 *   audit-pass       - Auditor: write PASS
 *   audit-fail       - Auditor: write FAIL
 *   audit-blocked    - Auditor: write BLOCKED
 *   audit-bad-digest - Auditor: write PASS with wrong digest
 *   audit-tamper     - Auditor: modify a business file during audit
 *   audit-fail-then-pass - Auditor: FAIL on iteration 1, PASS on iteration 2+
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Parse arguments
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const role = getArg('role') || 'planner';
const runId = getArg('run-id') || 'test-run-001';
const iteration = parseInt(getArg('iteration') || '1', 10);
const projectRoot = resolve(getArg('project-root') || process.cwd());
const behavior = getArg('behavior') || 'success';
const agentDir = join(projectRoot, '.agent');

const goalDigest = getArg('goal-digest') || readDigestFromState('goal_digest') || 'sha256:' + 'a'.repeat(64);
const diffDigest = getArg('diff-digest') || readDigestFromState('audited_diff_digest') || 'sha256:' + 'b'.repeat(64);

/** Read a digest value from state.json if it exists. */
function readDigestFromState(field) {
  try {
    const statePath = join(agentDir, 'state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      return state[field] || undefined;
    }
  } catch { /* ok */ }
  return undefined;
}

/** Read the current iteration number from state.json. */
function readIterationFromState() {
  try {
    const statePath = join(agentDir, 'state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      return state.iteration || 1;
    }
  } catch { /* ok */ }
  return 1;
}

// Ensure .agent directory exists
if (!existsSync(agentDir)) {
  mkdirSync(agentDir, { recursive: true });
}

// ─── Planner behaviors ────────────────────────────────────────

function writeValidPlan() {
  const plan = `---
schema_version: 1
run_id: "${runId}"
author_role: "planner"
---

# Plan

## Requirement Understanding

Test requirement for fake agent.

## Technical Approach

Simple implementation approach.

## Work Breakdown

1. Implement the feature
2. Add tests

## Risks

None for testing.
`;
  writeFileSync(join(agentDir, 'plan.md'), plan, 'utf8');
}

function writeValidGoal() {
  const goal = `---
schema_version: 1
run_id: "${runId}"
goal_id: "goal-001"
title: "Test goal"
allowed_changes:
  - "src/**"
  - "tests/**"
  - ".agent/developer-handoff.md"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal

## Objective

Implement the test feature.

## Success Criteria

1. All tests pass.

## Non-Goals

None.

## Constraints

None.
`;
  writeFileSync(join(agentDir, 'GOAL.md'), goal, 'utf8');
}

function writeInvalidGoal() {
  const goal = `---
schema_version: 1
run_id: "${runId}"
goal_id: "goal-001"
title: "Test goal"
allowed_changes:
  - "/absolute/path"
  - "../escape"
disallowed_changes:
  - ".git/**"
verification_commands:
  - id: "destructive"
    command: ["rm", "-rf", "/"]
    cwd: ".."
    required: true
    timeout_seconds: 900
---

# Goal

Invalid goal for testing.
`;
  writeFileSync(join(agentDir, 'GOAL.md'), goal, 'utf8');
}

// ─── Developer behaviors ──────────────────────────────────────

function writeCompletedHandoff() {
  const handoff = `---
schema_version: 1
run_id: "${runId}"
iteration: ${iteration}
author_role: "developer"
status: "COMPLETED"
---

# Developer Handoff

## Summary

Implemented the test feature.

## Files Changed

- \`src/test.ts\`: Added test implementation

## Verification Performed

- \`npm test\`: claimed passed

## Risks

None.

## Unresolved Issues

None.
`;
  writeFileSync(join(agentDir, 'developer-handoff.md'), handoff, 'utf8');
}

function writeBlockedHandoff() {
  const handoff = `---
schema_version: 1
run_id: "${runId}"
iteration: ${iteration}
author_role: "developer"
status: "BLOCKED"
---

# Developer Handoff

## Summary

Cannot complete the task.

## Unresolved Issues

Missing dependencies.
`;
  writeFileSync(join(agentDir, 'developer-handoff.md'), handoff, 'utf8');
}

// ─── Auditor behaviors ────────────────────────────────────────

function writeAuditReport(decision, goalDig, diffDig) {
  const report = `---
schema_version: 1
run_id: "${runId}"
iteration: ${iteration}
author_role: "auditor"
decision: "${decision}"
audited_goal_digest: "${goalDig}"
audited_diff_digest: "${diffDig}"
---

# Audit Report

## Decision

${decision}

## Success Criteria Review

| Criterion | Result | Evidence |
|---|---|---|
| SC-1 | ${decision === 'PASS' ? 'PASS' : 'FAIL'} | All tests pass |

## Findings

${decision === 'FAIL' ? '### F-001 - High - Test failure\n\n- Evidence: test output\n- Impact: Tests do not pass\n- Required fix: Fix the test' : 'None.'}

## Scope Review

No violations.
`;
  writeFileSync(join(agentDir, 'audit-report.md'), report, 'utf8');
}

// ─── Behavior dispatch ────────────────────────────────────────

try {
  switch (role) {
    case 'planner': {
      switch (behavior) {
        case 'success':
          writeValidPlan();
          writeValidGoal();
          break;
        case 'invalid-goal':
          writeValidPlan();
          writeInvalidGoal();
          break;
        case 'modify-business':
          writeValidPlan();
          writeValidGoal();
          // Simulate Planner modifying a business file (violation)
          appendFileSync(join(projectRoot, 'src', 'index.ts'), '\n// Planner violation\n', 'utf8');
          break;
        case 'no-artifact':
          // Don't write anything
          break;
        case 'timeout':
          // F-311R1 fix: Use active timer to keep event loop alive.
          // `await new Promise(() => {})` causes Node to exit immediately with
          // code 13 (unsettled top-level await) instead of actually timing out.
          await new Promise((resolve) => {
            setTimeout(resolve, 300000); // 5 minutes — will be killed by Process Runner timeout
          });
          break;
        case 'exit-error':
          process.exit(1);
          break;
        default:
          writeValidPlan();
          writeValidGoal();
      }
      break;
    }

    case 'developer': {
      switch (behavior) {
        case 'success':
          writeCompletedHandoff();
          // Create a simple test file to simulate development
          if (!existsSync(join(projectRoot, 'src'))) {
            mkdirSync(join(projectRoot, 'src'), { recursive: true });
          }
          writeFileSync(join(projectRoot, 'src', 'test-impl.ts'), '// Test implementation\nexport const testFn = () => true;\n', 'utf8');
          break;
        case 'blocked-handoff':
          writeBlockedHandoff();
          break;
        case 'modify-goal':
          writeCompletedHandoff();
          // Modify GOAL.md (violation)
          if (existsSync(join(agentDir, 'GOAL.md'))) {
            const goalContent = readFileSync(join(agentDir, 'GOAL.md'), 'utf8');
            writeFileSync(join(agentDir, 'GOAL.md'), goalContent + '\n// Modified by developer\n', 'utf8');
          }
          break;
        case 'scope-violation':
          writeCompletedHandoff();
          // Modify a disallowed file
          writeFileSync(join(agentDir, 'state.json'), '{"tampered": true}', 'utf8');
          break;
        case 'forge-evidence':
          writeCompletedHandoff();
          // Create a simple test file to simulate development
          if (!existsSync(join(projectRoot, 'src'))) {
            mkdirSync(join(projectRoot, 'src'), { recursive: true });
          }
          writeFileSync(join(projectRoot, 'src', 'test-impl.ts'), '// Test implementation\nexport const testFn = () => true;\n', 'utf8');
          // F-307R2 probe: Forge a file in .agent/evidence/ that the orchestrator
          // did not register. This should be detected as an unregistered_new violation.
          mkdirSync(join(agentDir, 'evidence'), { recursive: true });
          writeFileSync(join(agentDir, 'evidence', 'forged.json'), '{"forged": true}', 'utf8');
          break;
        case 'break-prompt-cleanup':
          writeCompletedHandoff();
          if (!existsSync(join(projectRoot, 'src'))) {
            mkdirSync(join(projectRoot, 'src'), { recursive: true });
          }
          writeFileSync(join(projectRoot, 'src', 'test-impl.ts'), '// Test implementation\nexport const testFn = () => true;\n', 'utf8');
          // F-306R2 probe: Make the debug directory read-only so the orchestrator's
          // deletePromptFile() call fails. The prompt file lives in .agent/debug/.
          // This must cause the orchestrator to enter BLOCKED, not continue silently.
          const debugDir = join(agentDir, 'debug');
          if (existsSync(debugDir)) {
            try { chmodSync(debugDir, 0o555); } catch { /* ok */ }
          }
          break;
        case 'rework-success':
          // Phase 4: Developer in rework mode — write valid handoff
          writeCompletedHandoff();
          // Fix the issue by creating/updating the test file
          if (!existsSync(join(projectRoot, 'src'))) {
            mkdirSync(join(projectRoot, 'src'), { recursive: true });
          }
          writeFileSync(join(projectRoot, 'src', 'test-impl.ts'), '// Fixed implementation\nexport const testFn = () => true;\n', 'utf8');
          break;
        case 'rework-fail':
          // Phase 4: Developer in rework mode — still can't fix the issue
          writeBlockedHandoff();
          break;
        case 'no-artifact':
          break;
        case 'timeout':
          await new Promise((resolve) => {
            setTimeout(resolve, 300000);
          });
          break;
        case 'exit-error':
          process.exit(1);
          break;
        default:
          writeCompletedHandoff();
      }
      break;
    }

    case 'auditor': {
      switch (behavior) {
        case 'success':
        case 'audit-pass':
          writeAuditReport('PASS', goalDigest, diffDigest);
          break;
        case 'audit-fail':
          writeAuditReport('FAIL', goalDigest, diffDigest);
          break;
        case 'audit-blocked':
          writeAuditReport('BLOCKED', goalDigest, diffDigest);
          break;
        case 'audit-bad-digest':
          writeAuditReport('PASS', 'sha256:' + '0'.repeat(64), 'sha256:' + '0'.repeat(64));
          break;
        case 'audit-tamper':
          writeAuditReport('PASS', goalDigest, diffDigest);
          // Modify a business file during audit (violation)
          if (existsSync(join(projectRoot, 'src', 'test-impl.ts'))) {
            appendFileSync(join(projectRoot, 'src', 'test-impl.ts'), '\n// Auditor tampered\n', 'utf8');
          }
          break;
        case 'audit-fail-then-pass':
          // Phase 4: FAIL on iteration 1, PASS on iteration 2+
          // Read iteration from state.json to determine behavior
          const currentIteration = readIterationFromState();
          if (currentIteration <= 1) {
            writeAuditReport('FAIL', goalDigest, diffDigest);
          } else {
            writeAuditReport('PASS', goalDigest, diffDigest);
          }
          break;
        case 'no-artifact':
          break;
        case 'timeout':
          await new Promise((resolve) => {
            setTimeout(resolve, 300000);
          });
          break;
        case 'exit-error':
          process.exit(1);
          break;
        default:
          writeAuditReport('PASS', goalDigest, diffDigest);
      }
      break;
    }

    default:
      console.error(`Unknown role: ${role}`);
      process.exit(1);
  }
} catch (err) {
  console.error(`Fake agent error: ${err.message}`);
  process.exit(1);
}

process.exit(0);
