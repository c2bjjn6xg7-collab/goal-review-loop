/**
 * Tests for Dashboard Artifact Reader
 * Phase 7 §5: Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { readDashboardSnapshot } from '../../src/dashboard/artifact-reader.js';

describe('Dashboard Artifact Reader', () => {
  const testDir = path.join(process.cwd(), '.test-artifact-reader');
  const agentDir = path.join(testDir, '.agent');

  beforeEach(async () => {
    await fs.ensureDir(agentDir);
    await fs.ensureDir(path.join(agentDir, 'transcripts'));
    await fs.ensureDir(path.join(agentDir, 'verification'));
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  describe('with empty .agent/ directory', () => {
    it('should return null values without crashing', async () => {
      const snapshot = await readDashboardSnapshot(testDir);

      expect(snapshot.run_summary).toBeNull();
      expect(snapshot.timeline).toBeNull();
      expect(snapshot.verification.available).toBe(false);
      expect(snapshot.audit.available).toBe(false);
      expect(snapshot.transcripts.available).toBe(false);
      expect(snapshot.artifacts_available).toEqual([]);
      // No error because .agent directory exists (just empty)
    });
  });

  describe('with valid state.json', () => {
    it('should read run summary from state', async () => {
      const state = {
        schema_version: 1,
        run_id: 'test-run-001',
        task_slug: 'test-task',
        phase: 'DEVELOPING',
        iteration: 1,
        max_iterations: 5,
        project_root: testDir,
        base_commit: 'abc123',
        branch: 'feature/test',
        goal_digest: 'sha256:test',
        audited_diff_digest: null,
        started_at: '2026-06-15T10:00:00Z',
        updated_at: '2026-06-15T10:30:00Z',
        last_error: null,
        cancel_requested_at: null,
        final_commit_sha: null,
        final_commit_message: null,
        finalized_at: null,
        commit_skipped: false,
        skip_reason: null,
        tag_name: null,
        tag_created: false,
        stages: {
          planning: { status: 'completed', attempts: 1 },
          developing: { status: 'running', attempts: 1 },
          verifying: { status: 'pending', attempts: 0 },
          auditing: { status: 'pending', attempts: 0 },
          finalizing: { status: 'pending', attempts: 0 },
        },
      };

      await fs.writeJson(path.join(agentDir, 'state.json'), state);

      const snapshot = await readDashboardSnapshot(testDir);

      expect(snapshot.run_summary).not.toBeNull();
      expect(snapshot.run_summary?.run_id).toBe('test-run-001');
      expect(snapshot.run_summary?.phase).toBe('DEVELOPING');
      expect(snapshot.run_summary?.iteration).toBe(1);
      expect(snapshot.run_summary?.terminal_status).toBeNull();
      expect(snapshot.timeline).not.toBeNull();
      expect(snapshot.timeline?.stages.planning).toBe('passed');
      expect(snapshot.timeline?.stages.developing).toBe('running');
    });
  });

  describe('with terminal state', () => {
    it('should indicate terminal status', async () => {
      const state = {
        schema_version: 1,
        run_id: 'test-run-002',
        task_slug: 'test-task',
        phase: 'PASSED',
        iteration: 2,
        max_iterations: 5,
        project_root: testDir,
        base_commit: 'abc123',
        branch: 'feature/test',
        goal_digest: 'sha256:test',
        audited_diff_digest: 'sha256:diff',
        started_at: '2026-06-15T10:00:00Z',
        updated_at: '2026-06-15T12:00:00Z',
        last_error: null,
        cancel_requested_at: null,
        final_commit_sha: 'def456',
        final_commit_message: 'Test commit',
        finalized_at: '2026-06-15T12:00:00Z',
        commit_skipped: false,
        skip_reason: null,
        tag_name: null,
        tag_created: false,
        stages: {
          planning: { status: 'completed', attempts: 1 },
          developing: { status: 'completed', attempts: 2 },
          verifying: { status: 'completed', attempts: 2 },
          auditing: { status: 'completed', attempts: 2 },
          finalizing: { status: 'completed', attempts: 1 },
        },
      };

      await fs.writeJson(path.join(agentDir, 'state.json'), state);

      const snapshot = await readDashboardSnapshot(testDir);

      expect(snapshot.run_summary?.terminal_status).toBe('PASSED');
      expect(snapshot.run_summary?.final_commit_sha).toBe('def456');
    });
  });

  describe('with verification manifest', () => {
    it('should read verification results', async () => {
      const verificationDir = path.join(agentDir, 'verification', 'iteration-01');
      await fs.ensureDir(verificationDir);

      const manifest = {
        schema_version: 1,
        run_id: 'test-run-001',
        iteration: 1,
        passed: true,
        started_at: '2026-06-15T10:00:00Z',
        finished_at: '2026-06-15T10:05:00Z',
        commands: [
          {
            id: 'unit-tests',
            argv: ['npm', 'test'],
            cwd: '.',
            required: true,
            status: 'success',
            exit_code: 0,
            timed_out: false,
            duration_ms: 30000,
            stdout_path: '.agent/verification/iteration-01/unit-tests.stdout',
            stderr_path: '.agent/verification/iteration-01/unit-tests.stderr',
          },
        ],
      };

      await fs.writeJson(path.join(verificationDir, 'manifest.json'), manifest);

      const snapshot = await readDashboardSnapshot(testDir);

      expect(snapshot.verification.available).toBe(true);
      expect(snapshot.verification.passed).toBe(true);
      expect(snapshot.verification.commands).toHaveLength(1);
      expect(snapshot.verification.commands[0].id).toBe('unit-tests');
      expect(snapshot.verification.commands[0].exit_code).toBe(0);
    });
  });

  describe('with transcripts', () => {
    it('should read transcript files', async () => {
      const transcript = `---
role: developer
iteration: 1
run_id: "test-run-001"
started_at: "2026-06-15T10:00:00Z"
finished_at: "2026-06-15T10:30:00Z"
duration_ms: 1800000
status: "success"
exit_code: 0
---

# developer — Iteration 1

## Status

- **Result**: success
- **Exit code**: 0
- **Duration**: 1800000ms

## stdout (last 4KB)

\`\`\`
Starting developer agent...
Planning changes...
All tasks completed successfully
\`\`\`
`;

      await fs.writeFile(path.join(agentDir, 'transcripts', 'iteration-01-developer.md'), transcript);

      const snapshot = await readDashboardSnapshot(testDir);

      expect(snapshot.transcripts.available).toBe(true);
      expect(snapshot.transcripts.files).toHaveLength(1);
      expect(snapshot.transcripts.files[0].role).toBe('developer');
      expect(snapshot.transcripts.files[0].iteration).toBe(1);
      expect(snapshot.transcripts.files[0].preview).toContain('Starting developer');
    });
  });

  describe('with malformed files', () => {
    it('should handle malformed state.json gracefully', async () => {
      await fs.writeFile(path.join(agentDir, 'state.json'), 'not valid json');

      const snapshot = await readDashboardSnapshot(testDir);

      expect(snapshot.run_summary).toBeNull();
      expect(snapshot.read_errors.length).toBeGreaterThan(0);
    });

    it('should handle malformed transcript gracefully', async () => {
      await fs.writeFile(path.join(agentDir, 'transcripts', 'bad.md'), 'no front matter here');

      const snapshot = await readDashboardSnapshot(testDir);

      expect(snapshot.read_errors.length).toBeGreaterThan(0);
    });
  });
});
