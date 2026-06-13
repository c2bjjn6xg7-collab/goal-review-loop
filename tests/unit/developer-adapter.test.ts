/**
 * Unit tests for src/agents/developer-adapter.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildDeveloperInput, validateDeveloperOutput } from '../../src/agents/developer-adapter.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeDigest } from '../../src/runtime/digest.js';

describe('developer-adapter', () => {
  const testDir = join(tmpdir(), `developer-test-${Date.now()}`);
  const agentDir = join(testDir, '.agent');

  beforeEach(() => {
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  describe('buildDeveloperInput', () => {
    it('builds correct AgentRunInput for developer', () => {
      const input = buildDeveloperInput({
        run_id: 'run-001',
        iteration: 1,
        project_root: testDir,
        command_template: ['claude', '-p', '{prompt}'],
        timeout_seconds: 3600,
        prompt: 'Test prompt',
      });

      expect(input.role).toBe('developer');
      expect(input.run_id).toBe('run-001');
      expect(input.iteration).toBe(1);
      expect(input.expected_artifacts).toHaveLength(1);
      expect(input.expected_artifacts[0]).toContain('developer-handoff.md');
    });
  });

  describe('validateDeveloperOutput', () => {
    it('validates COMPLETED handoff', () => {
      writeFileSync(join(agentDir, 'developer-handoff.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---

# Handoff

Done.
`);

      const result = validateDeveloperOutput(testDir, 'run-001', 1, null, null);
      expect(result.valid).toBe(true);
      expect(result.handoffStatus).toBe('COMPLETED');
      expect(result.isBlocked).toBe(false);
    });

    it('validates BLOCKED handoff', () => {
      writeFileSync(join(agentDir, 'developer-handoff.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "developer"
status: "BLOCKED"
---

# Handoff

Blocked.
`);

      const result = validateDeveloperOutput(testDir, 'run-001', 1, null, null);
      expect(result.valid).toBe(true);
      expect(result.handoffStatus).toBe('BLOCKED');
      expect(result.isBlocked).toBe(true);
    });

    it('rejects missing handoff', () => {
      const result = validateDeveloperOutput(testDir, 'run-001', 1, null, null);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not found'))).toBe(true);
    });

    it('rejects run_id mismatch', () => {
      writeFileSync(join(agentDir, 'developer-handoff.md'), `---
schema_version: 1
run_id: "wrong-id"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---
`);
      const result = validateDeveloperOutput(testDir, 'run-001', 1, null, null);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('run_id'))).toBe(true);
    });

    it('rejects iteration mismatch', () => {
      writeFileSync(join(agentDir, 'developer-handoff.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 2
author_role: "developer"
status: "COMPLETED"
---
`);
      const result = validateDeveloperOutput(testDir, 'run-001', 1, null, null);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('iteration'))).toBe(true);
    });

    it('detects plan.md modification', () => {
      const planContent = '---\nschema_version: 1\nrun_id: "run-001"\nauthor_role: "planner"\n---\nPlan';
      writeFileSync(join(agentDir, 'plan.md'), planContent);
      const planDigest = computeDigest(planContent);

      writeFileSync(join(agentDir, 'developer-handoff.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---
`);

      // Simulate Developer modifying plan.md
      writeFileSync(join(agentDir, 'plan.md'), planContent + '\n// Modified');

      const result = validateDeveloperOutput(testDir, 'run-001', 1, planDigest, null);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('plan.md'))).toBe(true);
    });

    it('detects GOAL.md modification', () => {
      const goalContent = '---\nschema_version: 1\nrun_id: "run-001"\ngoal_id: "g-1"\ntitle: "T"\nallowed_changes: ["src/**"]\ndisallowed_changes: [".git/**"]\nverification_commands:\n  - id: "t"\n    command: ["npm", "test"]\n    cwd: "."\n    required: true\n    timeout_seconds: 900\n---\n';
      writeFileSync(join(agentDir, 'GOAL.md'), goalContent);
      const goalDigest = computeDigest(goalContent);

      writeFileSync(join(agentDir, 'developer-handoff.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---
`);

      // Simulate Developer modifying GOAL.md
      writeFileSync(join(agentDir, 'GOAL.md'), goalContent + '\n// Modified');

      const result = validateDeveloperOutput(testDir, 'run-001', 1, null, goalDigest);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('GOAL.md'))).toBe(true);
    });
  });
});
