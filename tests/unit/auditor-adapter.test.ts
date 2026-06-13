/**
 * Unit tests for src/agents/auditor-adapter.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAuditorInput, validateAuditorOutput } from '../../src/agents/auditor-adapter.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeDigest } from '../../src/runtime/digest.js';

describe('auditor-adapter', () => {
  const testDir = join(tmpdir(), `auditor-test-${Date.now()}`);
  const agentDir = join(testDir, '.agent');

  beforeEach(() => {
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  describe('buildAuditorInput', () => {
    it('builds correct AgentRunInput for auditor', () => {
      const input = buildAuditorInput({
        run_id: 'run-001',
        iteration: 1,
        project_root: testDir,
        command_template: ['codex', 'exec', '{prompt}'],
        timeout_seconds: 1800,
        prompt: 'Test prompt',
      });

      expect(input.role).toBe('auditor');
      expect(input.run_id).toBe('run-001');
      expect(input.iteration).toBe(1);
      expect(input.expected_artifacts).toHaveLength(1);
      expect(input.expected_artifacts[0]).toContain('audit-report.md');
    });
  });

  describe('validateAuditorOutput', () => {
    const goalDigest = 'sha256:' + 'a'.repeat(64);
    const diffDigest = 'sha256:' + 'b'.repeat(64);

    it('validates PASS audit report with matching digests', async () => {
      writeFileSync(join(agentDir, 'audit-report.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "auditor"
decision: "PASS"
audited_goal_digest: "${goalDigest}"
audited_diff_digest: "${diffDigest}"
---

# Audit Report

PASS.
`);

      const result = await validateAuditorOutput(testDir, 'run-001', 1, goalDigest, diffDigest, new Map());
      expect(result.valid).toBe(true);
      expect(result.decision).toBe('PASS');
      expect(result.effectiveDecision).toBe('PASS');
    });

    it('validates FAIL audit report', async () => {
      writeFileSync(join(agentDir, 'audit-report.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "auditor"
decision: "FAIL"
audited_goal_digest: "${goalDigest}"
audited_diff_digest: "${diffDigest}"
---

# Audit Report

FAIL.
`);

      const result = await validateAuditorOutput(testDir, 'run-001', 1, goalDigest, diffDigest, new Map());
      expect(result.valid).toBe(true);
      expect(result.decision).toBe('FAIL');
    });

    it('validates BLOCKED audit report', async () => {
      writeFileSync(join(agentDir, 'audit-report.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "auditor"
decision: "BLOCKED"
audited_goal_digest: "${goalDigest}"
audited_diff_digest: "${diffDigest}"
---

# Audit Report

BLOCKED.
`);

      const result = await validateAuditorOutput(testDir, 'run-001', 1, goalDigest, diffDigest, new Map());
      expect(result.valid).toBe(true);
      expect(result.decision).toBe('BLOCKED');
    });

    it('rejects missing audit report', async () => {
      const result = await validateAuditorOutput(testDir, 'run-001', 1, goalDigest, diffDigest, new Map());
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('not found'))).toBe(true);
    });

    it('rejects goal_digest mismatch', async () => {
      writeFileSync(join(agentDir, 'audit-report.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "auditor"
decision: "PASS"
audited_goal_digest: "sha256:${'0'.repeat(64)}"
audited_diff_digest: "${diffDigest}"
---
`);

      const result = await validateAuditorOutput(testDir, 'run-001', 1, goalDigest, diffDigest, new Map());
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('goal_digest'))).toBe(true);
    });

    it('rejects diff_digest mismatch', async () => {
      writeFileSync(join(agentDir, 'audit-report.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "auditor"
decision: "PASS"
audited_goal_digest: "${goalDigest}"
audited_diff_digest: "sha256:${'0'.repeat(64)}"
---
`);

      const result = await validateAuditorOutput(testDir, 'run-001', 1, goalDigest, diffDigest, new Map());
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('diff_digest'))).toBe(true);
    });

    it('overrides PASS with FAIL when mechanical checks fail', async () => {
      writeFileSync(join(agentDir, 'audit-report.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "auditor"
decision: "PASS"
audited_goal_digest: "${goalDigest}"
audited_diff_digest: "${diffDigest}"
---
`);

      // Pass wrong goal digest to trigger mechanical failure
      const result = await validateAuditorOutput(testDir, 'run-001', 1, 'sha256:' + 'x'.repeat(64), diffDigest, new Map());
      expect(result.valid).toBe(false);
      expect(result.effectiveDecision).toBe('FAIL');
    });

    it('detects Auditor modification of business files', async () => {
      writeFileSync(join(agentDir, 'audit-report.md'), `---
schema_version: 1
run_id: "run-001"
iteration: 1
author_role: "auditor"
decision: "PASS"
audited_goal_digest: "${goalDigest}"
audited_diff_digest: "${diffDigest}"
---
`);

      // Set up a business file with pre-audit digest
      const businessPath = join(testDir, 'src', 'index.ts');
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(businessPath, 'original content');

      const preAuditDigests = new Map<string, string>();
      preAuditDigests.set(businessPath, computeDigest('original content'));

      // Simulate Auditor modifying the business file
      writeFileSync(businessPath, 'modified by auditor');

      const result = await validateAuditorOutput(testDir, 'run-001', 1, goalDigest, diffDigest, preAuditDigests);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('non-audit file'))).toBe(true);
    });
  });
});
