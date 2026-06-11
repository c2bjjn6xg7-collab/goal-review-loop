import { describe, it, expect } from 'vitest';
import {
  parsePlan,
  parseGoal,
  parseHandoff,
  parseAuditReport,
  parseFinalAudit,
  parseIterationLog,
  validateIterationLogEntry,
} from '../../src/artifacts/artifact-schemas.js';

const VALID_DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Artifact Schemas', () => {
  describe('parsePlan', () => {
    it('should parse valid plan.md', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: planner
---

# Plan`;

      const result = parsePlan(content);
      expect(result.frontMatter.schema_version).toBe(1);
      expect(result.frontMatter.run_id).toBe('20260610-test');
      expect(result.frontMatter.author_role).toBe('planner');
    });

    it('should reject plan with wrong author_role', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: developer
---

# Plan`;

      expect(() => parsePlan(content)).toThrow();
    });

    it('should reject plan with missing run_id', () => {
      const content = `---
schema_version: 1
author_role: planner
---

# Plan`;

      expect(() => parsePlan(content)).toThrow();
    });
  });

  describe('parseGoal', () => {
    const validGoal = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
title: "Test goal"
allowed_changes:
  - "src/**"
disallowed_changes:
  - ".git/**"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal`;

    it('should parse valid GOAL.md', () => {
      const result = parseGoal(validGoal);
      expect(result.frontMatter.goal_id).toBe('goal-001');
      expect(result.frontMatter.allowed_changes).toHaveLength(1);
      expect(result.frontMatter.verification_commands).toHaveLength(1);
    });

    it('should reject GOAL with empty allowed_changes', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
title: "Test"
allowed_changes: []
disallowed_changes: []
verification_commands:
  - id: "test"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal`;

      expect(() => parseGoal(content)).toThrow();
    });

    it('should reject GOAL with empty verification_commands', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
title: "Test"
allowed_changes:
  - "src/**"
disallowed_changes: []
verification_commands: []
---

# Goal`;

      expect(() => parseGoal(content)).toThrow();
    });

    it('should accept GOAL with empty disallowed_changes', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
title: "Test"
allowed_changes:
  - "src/**"
disallowed_changes: []
verification_commands:
  - id: "test"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal`;

      // Empty disallowed_changes is allowed (no explicit prohibition)
      const result = parseGoal(content);
      expect(result.frontMatter.disallowed_changes).toEqual([]);
    });

    it('should reject GOAL with missing title', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
allowed_changes:
  - "src/**"
disallowed_changes: []
verification_commands:
  - id: "test"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal`;

      expect(() => parseGoal(content)).toThrow();
    });

    it('should reject GOAL with invalid verification command (missing id)', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
title: "Test"
allowed_changes:
  - "src/**"
disallowed_changes: []
verification_commands:
  - command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal`;

      expect(() => parseGoal(content)).toThrow();
    });

    it('should reject GOAL with empty command array', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
title: "Test"
allowed_changes:
  - "src/**"
disallowed_changes: []
verification_commands:
  - id: "test"
    command: []
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal`;

      expect(() => parseGoal(content)).toThrow();
    });
  });

  describe('parseHandoff', () => {
    it('should parse valid handoff with COMPLETED status', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: developer
status: COMPLETED
---

# Handoff`;

      const result = parseHandoff(content);
      expect(result.frontMatter.status).toBe('COMPLETED');
    });

    it('should parse valid handoff with BLOCKED status', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: developer
status: BLOCKED
---

# Handoff`;

      const result = parseHandoff(content);
      expect(result.frontMatter.status).toBe('BLOCKED');
    });

    it('should reject handoff with invalid status', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: developer
status: PASS
---

# Handoff`;

      expect(() => parseHandoff(content)).toThrow();
    });

    it('should reject handoff with wrong author_role', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: auditor
status: COMPLETED
---

# Handoff`;

      expect(() => parseHandoff(content)).toThrow();
    });

    it('should reject handoff with fractional iteration', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1.5
author_role: developer
status: COMPLETED
---

# Handoff`;

      expect(() => parseHandoff(content)).toThrow();
    });

    it('should reject handoff with iteration < 1', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 0
author_role: developer
status: COMPLETED
---

# Handoff`;

      expect(() => parseHandoff(content)).toThrow();
    });
  });

  describe('parseAuditReport', () => {
    it('should parse valid audit report with FAIL', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: auditor
decision: FAIL
audited_goal_digest: "${VALID_DIGEST}"
audited_diff_digest: "${VALID_DIGEST}"
---

# Audit Report`;

      const result = parseAuditReport(content);
      expect(result.frontMatter.decision).toBe('FAIL');
    });

    it('should parse valid audit report with PASS', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: auditor
decision: PASS
audited_goal_digest: "${VALID_DIGEST}"
audited_diff_digest: "${VALID_DIGEST}"
---

# Audit Report`;

      const result = parseAuditReport(content);
      expect(result.frontMatter.decision).toBe('PASS');
    });

    it('should reject audit report with FAILED (not FAIL)', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: auditor
decision: FAILED
audited_goal_digest: "${VALID_DIGEST}"
audited_diff_digest: "${VALID_DIGEST}"
---

# Audit Report`;

      expect(() => parseAuditReport(content)).toThrow();
    });

    it('should reject audit report with invalid decision', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: auditor
decision: UNKNOWN
audited_goal_digest: "${VALID_DIGEST}"
audited_diff_digest: "${VALID_DIGEST}"
---

# Audit Report`;

      expect(() => parseAuditReport(content)).toThrow();
    });

    it('should reject audit report with wrong author_role', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: developer
decision: PASS
audited_goal_digest: "${VALID_DIGEST}"
audited_diff_digest: "${VALID_DIGEST}"
---

# Audit Report`;

      expect(() => parseAuditReport(content)).toThrow();
    });

    it('should reject audit report with pending digest', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1
author_role: auditor
decision: PASS
audited_goal_digest: "pending"
audited_diff_digest: "${VALID_DIGEST}"
---

# Audit Report`;

      expect(() => parseAuditReport(content)).toThrow();
    });

    it('should reject audit report with fractional iteration', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
iteration: 1.5
author_role: auditor
decision: PASS
audited_goal_digest: "${VALID_DIGEST}"
audited_diff_digest: "${VALID_DIGEST}"
---

# Audit Report`;

      expect(() => parseAuditReport(content)).toThrow();
    });
  });

  describe('parseFinalAudit', () => {
    it('should parse valid final audit with PASS', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: PASS
final_iteration: 2
goal_digest: "${VALID_DIGEST}"
diff_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      const result = parseFinalAudit(content);
      expect(result.frontMatter.decision).toBe('PASS');
      expect(result.frontMatter.final_iteration).toBe(2);
    });

    it('should parse valid final audit with FAILED', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: FAILED
final_iteration: 3
goal_digest: "${VALID_DIGEST}"
diff_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      const result = parseFinalAudit(content);
      expect(result.frontMatter.decision).toBe('FAILED');
    });

    it('should parse valid final audit with BLOCKED', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: BLOCKED
final_iteration: 1
goal_digest: "${VALID_DIGEST}"
diff_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      const result = parseFinalAudit(content);
      expect(result.frontMatter.decision).toBe('BLOCKED');
    });

    it('should reject final audit with FAIL (not FAILED)', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: FAIL
final_iteration: 2
goal_digest: "${VALID_DIGEST}"
diff_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      expect(() => parseFinalAudit(content)).toThrow();
    });

    it('should reject final audit with invalid decision', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: MAYBE
final_iteration: 2
goal_digest: "${VALID_DIGEST}"
diff_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      expect(() => parseFinalAudit(content)).toThrow();
    });

    it('should reject final audit with pending digest', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: PASS
final_iteration: 2
goal_digest: "pending"
diff_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      expect(() => parseFinalAudit(content)).toThrow();
    });

    it('should reject final audit with fractional final_iteration', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: PASS
final_iteration: 1.5
goal_digest: "${VALID_DIGEST}"
diff_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      expect(() => parseFinalAudit(content)).toThrow();
    });

    it('should reject final audit with missing diff_digest', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: auditor
decision: PASS
final_iteration: 2
goal_digest: "${VALID_DIGEST}"
---

# Final Audit`;

      expect(() => parseFinalAudit(content)).toThrow();
    });
  });

  describe('parseIterationLog', () => {
    it('should parse valid iteration log table', () => {
      const content = `## 2026-06-10T22:30:12Z | Run 20260610-test

| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING | preflight | PASS |
| 22:31:01Z | 0 | PLANNING | planner completed | PASS |
| 22:40:13Z | 1 | VERIFYING | unit-tests | FAIL |`;

      const entries = parseIterationLog(content);
      expect(entries).toHaveLength(3);
      expect(entries[0].phase).toBe('INITIALIZING');
      expect(entries[0].event).toBe('preflight');
      expect(entries[0].result).toBe('PASS');
      expect(entries[2].result).toBe('FAIL');
    });

    it('should return empty array for empty log', () => {
      const entries = parseIterationLog('');
      expect(entries).toHaveLength(0);
    });

    it('should return empty array for whitespace-only log', () => {
      const entries = parseIterationLog('   \n\n  ');
      expect(entries).toHaveLength(0);
    });

    it('should skip header and separator lines', () => {
      const content = `## 2026-06-10T22:30:12Z | Run 20260610-test

| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING | preflight | PASS |`;

      const entries = parseIterationLog(content);
      expect(entries).toHaveLength(1);
    });

    it('should parse design doc example with FAIL (exit 1)', () => {
      // Design doc §8.6 original example
      const content = `## 2026-06-10T22:30:12Z | Run 20260610-153012-a1b2c3

| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING | preflight | PASS |
| 22:31:01Z | 0 | PLANNING | planner completed | PASS |
| 22:40:13Z | 1 | VERIFYING | unit-tests | FAIL (exit 1) |`;

      const entries = parseIterationLog(content);
      expect(entries).toHaveLength(3);
      expect(entries[2].result).toBe('FAIL');
      expect(entries[2].detail).toBe('exit 1');
    });

    it('should reject invalid phase in log entry', () => {
      const content = `## 2026-06-10T22:30:12Z | Run test
| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INVALID_PHASE | preflight | PASS |`;

      expect(() => parseIterationLog(content)).toThrow();
    });

    it('should reject invalid result in log entry', () => {
      const content = `## 2026-06-10T22:30:12Z | Run test
| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING | preflight | INVALID |`;

      expect(() => parseIterationLog(content)).toThrow();
    });

    it('should reject garbage text without header', () => {
      const content = 'This is just garbage text, not a valid log';
      expect(() => parseIterationLog(content)).toThrow(/missing run header/);
    });

    it('should reject malformed table rows', () => {
      const content = `## 2026-06-10T22:30:12Z | Run test
| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING |`;

      expect(() => parseIterationLog(content)).toThrow(/expected 5-6 columns/);
    });

    it('should reject invalid time format', () => {
      const content = `## 2026-06-10T22:30:12Z | Run test
| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| also-nope | 0 | INITIALIZING | preflight | PASS |`;

      expect(() => parseIterationLog(content)).toThrow(/invalid time format/);
    });

    it('should reject non-empty content without valid header', () => {
      const content = `| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING | preflight | PASS |`;

      expect(() => parseIterationLog(content)).toThrow(/missing run header/);
    });

    it('should reject header with empty run_id', () => {
      const content = `## 2026-06-10T22:30:12Z | Run ${''}
| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 0 | INITIALIZING | preflight | PASS |`;

      expect(() => parseIterationLog(content)).toThrow();
    });

    it('should reject negative iteration number', () => {
      const content = `## 2026-06-10T22:30:12Z | Run test
| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | -1 | INITIALIZING | preflight | PASS |`;

      expect(() => parseIterationLog(content)).toThrow(/invalid iteration/);
    });

    it('should reject non-integer iteration number', () => {
      const content = `## 2026-06-10T22:30:12Z | Run test
| Time | Iteration | Phase | Event | Result |
|---|---:|---|---|---|
| 22:30:12Z | 1.5 | INITIALIZING | preflight | PASS |`;

      expect(() => parseIterationLog(content)).toThrow(/invalid iteration/);
    });
  });

  describe('validateIterationLogEntry', () => {
    it('should validate a correct entry', () => {
      const entry = {
        timestamp: '2026-06-10T22:30:12Z',
        run_id: 'test',
        iteration: 1,
        phase: 'VERIFYING',
        event: 'unit-tests',
        result: 'PASS',
      };
      expect(validateIterationLogEntry(entry)).toBe(true);
    });

    it('should reject entry with missing required field', () => {
      const entry = {
        timestamp: '2026-06-10T22:30:12Z',
        run_id: 'test',
        iteration: 1,
        phase: 'VERIFYING',
        // missing event and result
      };
      expect(validateIterationLogEntry(entry)).toBe(false);
    });
  });
});
