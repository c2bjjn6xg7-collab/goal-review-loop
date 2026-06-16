/**
 * Unit tests for src/agents/agent-adapter.ts
 */
import { describe, it, expect } from 'vitest';
import { recordPreCallState, verifyArtifactFreshness } from '../../src/agents/agent-adapter.js';
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
});
