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
 *   slow-developer   - Developer: sleep 30s (for mid-run cancel testing)
 *   hang-silent      - Developer: write nothing and sleep 5min; for idle-watchdog tests
 *                       (the idle watchdog must abort this before the agent timeout)
 *   developer-fail-three-then-success - Developer: fail 3x with AGENT_ERROR (exit 1), then succeed
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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

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

function writeTaskGraphPlan() {
  writeValidPlan();
  writeValidGoal();

  // Compute GOAL.md digest so task-graph.json goal_digest matches.
  const goalPath = join(agentDir, 'GOAL.md');
  const goalContent = readFileSync(goalPath, 'utf8');
  const goalDigest = computeDigest(goalContent);

  const taskGraph = {
    schema_version: 1,
    run_id: runId,
    goal_digest: goalDigest,
    created_at: new Date().toISOString(),
    tasks: [
      {
        id: 'task-1',
        title: 'Implement feature part A',
        description: 'Add the first part of the feature under src/part-a/.',
        difficulty: 'low',
        risk: 'low',
        parallelizable: false,
        depends_on: [],
        allowed_changes: ['src/part-a/**'],
        disallowed_changes: ['.git/**', '.agent/state.json'],
        verification_commands: [
          { id: 'task-1-verify', command: ['node', '-e', 'process.exit(0)'], cwd: '.', required: true, timeout_seconds: 30 },
        ],
        status: 'pending',
      },
      {
        id: 'task-2',
        title: 'Implement feature part B',
        description: 'Add the second part of the feature under src/part-b/.',
        difficulty: 'low',
        risk: 'low',
        parallelizable: false,
        depends_on: ['task-1'],
        allowed_changes: ['src/part-b/**'],
        disallowed_changes: ['.git/**', '.agent/state.json'],
        verification_commands: [
          { id: 'task-2-verify', command: ['node', '-e', 'process.exit(0)'], cwd: '.', required: true, timeout_seconds: 30 },
        ],
        status: 'pending',
      },
      {
        id: 'task-3',
        title: 'Integration verification',
        description: 'Final integration task that depends on all prior tasks.',
        difficulty: 'low',
        risk: 'low',
        parallelizable: false,
        depends_on: ['task-1', 'task-2'],
        allowed_changes: ['src/integration/**'],
        disallowed_changes: ['.git/**', '.agent/state.json'],
        verification_commands: [
          { id: 'task-3-verify', command: ['node', '-e', 'process.exit(0)'], cwd: '.', required: true, timeout_seconds: 30 },
        ],
        status: 'pending',
      },
    ],
  };
  writeFileSync(join(agentDir, 'task-graph.json'), JSON.stringify(taskGraph, null, 2), 'utf8');
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

/** Compute SHA-256 digest of a string, returning sha256:hex format. */
function computeDigest(content) {
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}`;
}

/** Read a file and compute its digest, or return fallback if file doesn't exist. */
function computeFileDigest(filePath, fallback) {
  try {
    if (existsSync(filePath)) {
      return computeDigest(readFileSync(filePath, 'utf8'));
    }
  } catch { /* ok */ }
  return fallback;
}

/** Extract digest values from the prompt file content. */
function extractDigestsFromPrompt() {
  const digests = {};
  const promptFile = getArg('prompt-file');
  if (promptFile && existsSync(promptFile)) {
    try {
      const content = readFileSync(promptFile, 'utf8');
      // Match digests in both YAML format (goal_digest: "sha256:...") and
      // markdown format (GOAL digest: `sha256:...`)
      const patterns = [
        ['goal_digest', /goal_digest[^a-z]*?(sha256:[a-f0-9]+)/i],
        ['diff_digest', /diff_digest[^a-z]*?(sha256:[a-f0-9]+)/i],
        ['audit_report_digest', /audit_report_digest[^a-z]*?(sha256:[a-f0-9]+)/i],
        ['verification_manifest_digest', /verification_manifest_digest[^a-z]*?(sha256:[a-f0-9]+)/i],
      ];
      for (const [key, regex] of patterns) {
        const match = content.match(regex);
        if (match) digests[key] = match[1];
      }
    } catch { /* ok */ }
  }
  return digests;
}

function writeFinalAuditReport(decision, goalDig, diffDig, forcePassedDigests = false) {
  // For final-auditor, compute actual digests from files on disk
  // and from the prompt file (which contains the orchestrator-computed digests).
  // When forcePassedDigests is true (e.g., audit-bad-digest behavior),
  // use the explicitly passed goalDig/diffDig instead of computing correct ones.
  let actualGoalDigest = goalDig;
  let actualDiffDigest = diffDig;
  let actualAuditReportDigest = 'sha256:' + 'c'.repeat(64);
  let actualManifestDigest = 'sha256:' + 'd'.repeat(64);

  if (!forcePassedDigests) {
    const promptDigests = extractDigestsFromPrompt();

    // Use digests from prompt file first, then from files on disk, then fallback
    actualGoalDigest = promptDigests.goal_digest
      || computeFileDigest(join(agentDir, 'GOAL.md'), goalDig);
    actualDiffDigest = promptDigests.diff_digest || diffDig;
    actualAuditReportDigest = promptDigests.audit_report_digest
      || computeFileDigest(join(agentDir, 'audit-report.md'), 'sha256:' + 'c'.repeat(64));
    actualManifestDigest = promptDigests.verification_manifest_digest
      || computeFileDigest(join(agentDir, 'verification', 'manifest.json'), 'sha256:' + 'd'.repeat(64));
  }

  const auditReportDigest = getArg('audit-report-digest') || actualAuditReportDigest;
  const verificationManifestDigest = getArg('verification-manifest-digest') || actualManifestDigest;
  const report = `---
schema_version: 1
run_id: "${runId}"
author_role: "auditor"
decision: "${decision}"
final_iteration: ${iteration}
goal_digest: "${actualGoalDigest}"
diff_digest: "${actualDiffDigest}"
audit_report_digest: "${auditReportDigest}"
verification_manifest_digest: "${verificationManifestDigest}"
created_at: "${new Date().toISOString()}"
---

# Final Audit Report

## Final Decision

${decision}

## Success Criteria Review

| Criterion | Result | Evidence |
|---|---|---|
| SC-1 | ${decision === 'PASS' ? 'PASS' : 'FAIL'} | All checks passed |

## Verification Summary

All required verification commands passed.

## Scope Summary

No scope violations detected.

## Change Summary

Changes are within allowed scope.

## Files To Commit

- .agent/plan.md
- .agent/GOAL.md
- .agent/developer-handoff.md
- .agent/audit-report.md
- .agent/final-audit.md

## Versioned Artifacts

All versioned artifacts are present and valid.

## Local-only Artifacts Excluded

- .agent/state.json
- .agent/run.lock
- .agent/iteration-log.md
- .agent/verification/
- .agent/evidence/

## Accepted Residual Risks

None.

## Commit Recommendation

${decision === 'PASS' ? 'Safe to commit.' : 'Do not commit.'}
`;
  writeFileSync(join(agentDir, 'final-audit.md'), report, 'utf8');
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
        case 'task-graph':
          writeTaskGraphPlan();
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
        case 'task-success':
          writeCompletedHandoff();
          // Phase 8B: create a file within the current task's allowed_changes,
          // parsed from the prompt file. Falls back to src/task-impl.ts.
          {
            let taskDir = join(projectRoot, 'src');
            const promptFile = getArg('prompt-file');
            if (promptFile && existsSync(promptFile)) {
              try {
                const content = readFileSync(promptFile, 'utf8');
                // First allowed_changes glob like "src/part-a/**"
                const m = content.match(/- `((?:src|tests)[^`]*?)\*\*`/);
                if (m) {
                  const glob = m[1];
                  taskDir = join(projectRoot, glob.replace(/\/+$/, '').replace(/\/\*\*$/, ''));
                }
              } catch { /* ignore */ }
            }
            mkdirSync(taskDir, { recursive: true });
            writeFileSync(join(taskDir, 'impl.ts'), '// Task implementation\nexport const taskFn = () => true;\n', 'utf8');
          }
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
        case 'task-block-once':
          // Phase 8B: block on the first attempt, then succeed on resume.
          // Uses a sentinel file in .agent/ (orchestrator-owned) to track state.
          {
            const debugDir = join(agentDir, 'debug');
            if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
            const sentinel = join(debugDir, 'task-block-sentinel');
            if (existsSync(sentinel)) {
              // Subsequent run (resume): succeed.
              writeCompletedHandoff();
              const promptFile = getArg('prompt-file');
              let taskDir = join(projectRoot, 'src');
              if (promptFile && existsSync(promptFile)) {
                try {
                  const content = readFileSync(promptFile, 'utf8');
                  const m = content.match(/- `((?:src|tests)[^`]*?)\*\*`/);
                  if (m) {
                    taskDir = join(projectRoot, m[1].replace(/\/+$/, '').replace(/\/\*\*$/, ''));
                  }
                } catch { /* ignore */ }
              }
              mkdirSync(taskDir, { recursive: true });
              writeFileSync(join(taskDir, 'impl.ts'), '// Task implementation\nexport const taskFn = () => true;\n', 'utf8');
            } else {
              // First run: block.
              writeFileSync(sentinel, '1', 'utf8');
              writeBlockedHandoff();
            }
          }
          break;
        case 'rework-fail':
          // Phase 4: Developer in rework mode — still can't fix the issue
          writeBlockedHandoff();
          break;
        case 'developer-fail-three-then-success':
          // Phase 8D P6: fail the first three Developer invocations with
          // AGENT_ERROR (exit non-zero, no handoff artifact), then succeed on
          // the fourth. Exercises the orchestrator's same-provider retry loop.
          // A counter file in /tmp tracks invocations without touching
          // orchestrator-protected .agent paths during Developer execution.
          {
            const counterDir = join(tmpdir(), 'review-loop-fake-agent-counters', runId);
            if (!existsSync(counterDir)) mkdirSync(counterDir, { recursive: true });
            const counterPath = join(counterDir, 'developer-fail-three-then-success-count');
            let count = 0;
            if (existsSync(counterPath)) {
              count = parseInt(readFileSync(counterPath, 'utf8').trim() || '0', 10) || 0;
            }
            count += 1;
            writeFileSync(counterPath, String(count), 'utf8');
            if (count <= 3) {
              // Fail with AGENT_ERROR: exit non-zero without writing a handoff.
              process.exit(1);
            }
            writeCompletedHandoff();
            if (!existsSync(join(projectRoot, 'src'))) {
              mkdirSync(join(projectRoot, 'src'), { recursive: true });
            }
            writeFileSync(join(projectRoot, 'src', 'test-impl.ts'), '// Test implementation\nexport const testFn = () => true;\n', 'utf8');
          }
          break;
        case 'slow-developer':
          // Phase 4: Sleep for 30 seconds to allow mid-run cancel testing.
          // Write handoff first so if the process is killed before completing,
          // the orchestrator can detect the cancellation.
          writeCompletedHandoff();
          if (!existsSync(join(projectRoot, 'src'))) {
            mkdirSync(join(projectRoot, 'src'), { recursive: true });
          }
          writeFileSync(join(projectRoot, 'src', 'test-impl.ts'), '// Test implementation\nexport const testFn = () => true;\n', 'utf8');
          await new Promise((resolve) => {
            setTimeout(resolve, 30000);
          });
          break;
        case 'hang-silent':
          // Phase 8D P6.5: Simulate a silently hanging Developer — write no
          // handoff and no stdout/stderr output, then sleep well past the agent
          // timeout. The idle watchdog should abort this attempt within the
          // configured idle window (well before this sleep resolves) via the
          // per-attempt AbortController. Uses an active timer to keep the event
          // loop alive so the process actually hangs instead of exiting.
          await new Promise((resolve) => {
            setTimeout(resolve, 300000); // 5 minutes — watchdog must abort first
          });
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

    case 'final-auditor': {
      switch (behavior) {
        case 'success':
        case 'audit-pass':
          writeFinalAuditReport('PASS', goalDigest, diffDigest);
          break;
        case 'audit-fail':
          writeFinalAuditReport('FAILED', goalDigest, diffDigest);
          break;
        case 'audit-blocked':
          writeFinalAuditReport('BLOCKED', goalDigest, diffDigest);
          break;
        case 'audit-bad-digest':
          writeFinalAuditReport('PASS', 'sha256:' + '0'.repeat(64), 'sha256:' + '0'.repeat(64), true);
          break;
        case 'audit-tamper-final':
          // Write a valid PASS report, then tamper with a business file.
          // The orchestrator's F-501R1 digest snapshot should detect this.
          writeFinalAuditReport('PASS', goalDigest, diffDigest);
          if (existsSync(join(projectRoot, 'src', 'test-impl.ts'))) {
            appendFileSync(join(projectRoot, 'src', 'test-impl.ts'), '\n// Final Auditor tampered\n', 'utf8');
          } else if (existsSync(join(projectRoot, 'src', 'index.ts'))) {
            appendFileSync(join(projectRoot, 'src', 'index.ts'), '\n// Final Auditor tampered\n', 'utf8');
          }
          break;
        case 'audit-revert-final':
          // Write a valid PASS report, then delete a Developer-created business file.
          // This simulates the revert-to-base scenario: the file disappears from
          // git diff but the pre-snapshot still recorded it. F-501R2 should catch this.
          writeFinalAuditReport('PASS', goalDigest, diffDigest);
          try {
            const { unlinkSync } = await import('node:fs');
            if (existsSync(join(projectRoot, 'src', 'test-impl.ts'))) {
              unlinkSync(join(projectRoot, 'src', 'test-impl.ts'));
            }
          } catch { /* best effort */ }
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
          writeFinalAuditReport('PASS', goalDigest, diffDigest);
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
