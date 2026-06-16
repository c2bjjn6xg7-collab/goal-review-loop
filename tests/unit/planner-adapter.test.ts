/**
 * Unit tests for src/agents/planner-adapter.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPlannerInput, validatePlannerOutput } from '../../src/agents/planner-adapter.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('planner-adapter', () => {
  const testDir = join(tmpdir(), `planner-test-${Date.now()}`);
  const agentDir = join(testDir, '.agent');

  beforeEach(() => {
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  describe('buildPlannerInput', () => {
    it('builds correct AgentRunInput for planner', () => {
      const input = buildPlannerInput({
        run_id: 'run-001',
        project_root: testDir,
        command_template: ['codex', 'exec', '{prompt}'],
        timeout_seconds: 1800,
        prompt: 'Test prompt',
      });

      expect(input.role).toBe('planner');
      expect(input.run_id).toBe('run-001');
      expect(input.iteration).toBe(0);
      expect(input.prompt).toBe('Test prompt');
      expect(input.expected_artifacts).toHaveLength(2);
      expect(input.expected_artifacts[0]).toContain('plan.md');
      expect(input.expected_artifacts[1]).toContain('GOAL.md');
    });
  });

  describe('validatePlannerOutput', () => {
    it('validates correct plan and GOAL', () => {
      writeFileSync(join(agentDir, 'plan.md'), `---
schema_version: 1
run_id: "run-001"
author_role: "planner"
---

# Plan

Test plan.
`);

      writeFileSync(join(agentDir, 'GOAL.md'), `---
schema_version: 1
run_id: "run-001"
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

# Goal

Test goal.
`);

      const result = validatePlannerOutput(testDir, 'run-001');
      expect(result.valid).toBe(true);
      expect(result.goalDigest).toBeTruthy();
      expect(result.verificationCommands).toHaveLength(1);
      expect(result.verificationCommands![0].argv).toEqual(['npm', 'test']);
    });

    it('rejects missing plan.md', () => {
      // Only write GOAL, no plan
      writeFileSync(join(agentDir, 'GOAL.md'), `---
schema_version: 1
run_id: "run-001"
goal_id: "goal-001"
title: "Test"
allowed_changes: ["src/**"]
disallowed_changes: [".git/**"]
verification_commands:
  - id: "test"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---
`);
      const result = validatePlannerOutput(testDir, 'run-001');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('plan.md'))).toBe(true);
    });

    it('rejects run_id mismatch', () => {
      writeFileSync(join(agentDir, 'plan.md'), `---
schema_version: 1
run_id: "wrong-id"
author_role: "planner"
---
`);
      writeFileSync(join(agentDir, 'GOAL.md'), `---
schema_version: 1
run_id: "wrong-id"
goal_id: "goal-001"
title: "Test"
allowed_changes: ["src/**"]
disallowed_changes: [".git/**"]
verification_commands:
  - id: "test"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---
`);
      const result = validatePlannerOutput(testDir, 'run-001');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('run_id'))).toBe(true);
    });

    it('rejects GOAL with unsafe paths', () => {
      writeFileSync(join(agentDir, 'plan.md'), `---
schema_version: 1
run_id: "run-001"
author_role: "planner"
---
`);
      writeFileSync(join(agentDir, 'GOAL.md'), `---
schema_version: 1
run_id: "run-001"
goal_id: "goal-001"
title: "Test"
allowed_changes:
  - "/absolute/path"
  - "../escape"
disallowed_changes: [".git/**"]
verification_commands:
  - id: "test"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---
`);
      const result = validatePlannerOutput(testDir, 'run-001');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('unsafe path'))).toBe(true);
    });

    it('rejects destructive verification commands', () => {
      writeFileSync(join(agentDir, 'plan.md'), `---
schema_version: 1
run_id: "run-001"
author_role: "planner"
---
`);
      writeFileSync(join(agentDir, 'GOAL.md'), `---
schema_version: 1
run_id: "run-001"
goal_id: "goal-001"
title: "Test"
allowed_changes: ["src/**"]
disallowed_changes: [".git/**"]
verification_commands:
  - id: "danger"
    command: ["rm", "-rf", "/"]
    cwd: "."
    required: true
    timeout_seconds: 900
---
`);
      const result = validatePlannerOutput(testDir, 'run-001');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('destructive') || e.includes('validation error'))).toBe(true);
    });
  });
});
