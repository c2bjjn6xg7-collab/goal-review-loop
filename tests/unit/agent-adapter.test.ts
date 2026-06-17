/**
 * Unit tests for src/agents/agent-adapter.ts
 */
import { describe, it, expect } from 'vitest';
import { recordPreCallState, verifyArtifactFreshness, buildAgentLogPaths } from '../../src/agents/agent-adapter.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('agent-adapter', () => {
  describe('recordPreCallState', () => {
    const testDir = join(tmpdir(), `agent-adapter-test-${Date.now()}`);

    afterAll(() => {
      try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    });

    it('records state for existing and missing files', async () => {
      mkdirSync(testDir, { recursive: true });
      const existingPath = join(testDir, 'exists.txt');
      writeFileSync(existingPath, 'content');
      const missingPath = join(testDir, 'missing.txt');

      const state = await recordPreCallState([existingPath, missingPath]);
      expect(state.records).toHaveLength(2);
      expect(state.records[0].exists).toBe(true);
      expect(state.records[1].exists).toBe(false);
    });
  });

  describe('verifyArtifactFreshness', () => {
    const testDir = join(tmpdir(), `agent-freshness-test-${Date.now()}`);

    afterAll(() => {
      try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    });

    it('reports missing artifacts', async () => {
      mkdirSync(testDir, { recursive: true });
      const missingPath = join(testDir, 'missing.txt');
      const state = await recordPreCallState([missingPath]);

      const violations = await verifyArtifactFreshness([missingPath], state);
      expect(violations.some(v => v.violation === 'missing')).toBe(true);
    });

    it('reports stale artifacts with wrong run_id', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'stale.md');
      writeFileSync(filePath, '---\nrun_id: "old-run"\n---\nContent');

      const state = await recordPreCallState([filePath]);
      const violations = await verifyArtifactFreshness([filePath], state);
      expect(violations.some(v => v.violation === 'stale')).toBe(true);
    });

    it('accepts fresh artifacts with correct run_id', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'fresh.md');
      writeFileSync(filePath, '---\nrun_id: "run-1"\n---\nOld');

      const state = await recordPreCallState([filePath]);
      // Simulate agent modifying the file
      writeFileSync(filePath, '---\nrun_id: "run-1"\n---\nNew content');

      const violations = await verifyArtifactFreshness([filePath], state);
      // Modified file is expected — no stale violation
      expect(violations.some(v => v.violation === 'stale')).toBe(false);
    });
  });

  describe('buildAgentLogPaths (F-8D-T-001)', () => {
    const debugDir = '/tmp/dbg';
    const runId = '20260617-abc';

    it('omits attempt suffix when attempt is undefined (back-compat)', () => {
      const r = buildAgentLogPaths(debugDir, runId, 'developer', 3);
      expect(r.stdoutPath).toBe('/tmp/dbg/20260617-abc-developer-iter3.stdout.log');
      expect(r.stderrPath).toBe('/tmp/dbg/20260617-abc-developer-iter3.stderr.log');
    });

    it('omits attempt suffix when attempt === 1 (back-compat)', () => {
      const r = buildAgentLogPaths(debugDir, runId, 'developer', 3, 1);
      expect(r.stdoutPath).toBe('/tmp/dbg/20260617-abc-developer-iter3.stdout.log');
    });

    it('appends -attempt${N} when attempt >= 2', () => {
      const r2 = buildAgentLogPaths(debugDir, runId, 'developer', 3, 2);
      const r5 = buildAgentLogPaths(debugDir, runId, 'developer', 3, 5);
      expect(r2.stdoutPath).toBe('/tmp/dbg/20260617-abc-developer-iter3-attempt2.stdout.log');
      expect(r2.stderrPath).toBe('/tmp/dbg/20260617-abc-developer-iter3-attempt2.stderr.log');
      expect(r5.stdoutPath).toBe('/tmp/dbg/20260617-abc-developer-iter3-attempt5.stdout.log');
    });

    it('produces distinct paths across attempts within the same iteration', () => {
      const a1 = buildAgentLogPaths(debugDir, runId, 'developer', 3);
      const a2 = buildAgentLogPaths(debugDir, runId, 'developer', 3, 2);
      const a3 = buildAgentLogPaths(debugDir, runId, 'developer', 3, 3);
      const set = new Set([a1.stdoutPath, a2.stdoutPath, a3.stdoutPath]);
      expect(set.size).toBe(3);
    });

    it('applies the same rule to other roles (auditor)', () => {
      const r = buildAgentLogPaths(debugDir, runId, 'auditor', 1, 2);
      expect(r.stdoutPath).toBe('/tmp/dbg/20260617-abc-auditor-iter1-attempt2.stdout.log');
    });
  });
});
