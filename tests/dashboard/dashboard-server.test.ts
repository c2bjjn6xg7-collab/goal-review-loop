/**
 * Tests for Dashboard Server
 * Phase 7 §5: Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'fs-extra';
import path from 'path';

describe('Dashboard Server', () => {
  const testDir = path.join(process.cwd(), '.test-dashboard-server');
  const agentDir = path.join(testDir, '.agent');
  const testPort = 14317;
  let serverProcess: ChildProcess | null = null;

  beforeAll(async () => {
    await fs.ensureDir(agentDir);
    await fs.writeJson(path.join(agentDir, 'state.json'), {
      schema_version: 1,
      run_id: 'test-run-server',
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
    });
  });

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await fs.remove(testDir);
  });

  describe('localhost binding', () => {
    it('should bind to 127.0.0.1 by default', async () => {
      // This is tested implicitly by starting the server
      // The actual test is that the server starts without error
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort,
        noOpen: true,
      });

      expect(server.url).toBe(`http://127.0.0.1:${testPort}`);

      // Make a request to verify it's working
      const response = await fetch(`http://127.0.0.1:${testPort}/api/status`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.run_summary).not.toBeNull();
      expect(data.run_summary.run_id).toBe('test-run-server');

      await server.close();
    });
  });

  describe('network binding rejection', () => {
    it('should reject binding to 0.0.0.0', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      await expect(
        startDashboardServer({
          projectRoot: testDir,
          host: '0.0.0.0',
          port: testPort,
          noOpen: true,
        })
      ).rejects.toThrow('Network binding rejected');
    });

    it('should reject binding to non-local addresses', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      await expect(
        startDashboardServer({
          projectRoot: testDir,
          host: '192.168.1.1',
          port: testPort,
          noOpen: true,
        })
      ).rejects.toThrow('Network binding rejected');
    });
  });

  describe('API endpoints', () => {
    it('should serve /api/status', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 1,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/api/status`);
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('application/json');

      const data = await response.json();
      expect(data).toHaveProperty('run_summary');

      await server.close();
    });

    it('should serve /api/verification', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 2,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/api/verification`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data).toHaveProperty('available');
      expect(data).toHaveProperty('commands');

      await server.close();
    });

    it('should serve /api/audit', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 3,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/api/audit`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data).toHaveProperty('available');
      expect(data).toHaveProperty('findings');

      await server.close();
    });

    it('should serve /api/transcripts', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 4,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/api/transcripts`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data).toHaveProperty('available');
      expect(data).toHaveProperty('files');

      await server.close();
    });

    it('should serve / (dashboard UI)', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 5,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/`);
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('text/html');

      const html = await response.text();
      expect(html).toContain('Goal Review Loop Dashboard');

      await server.close();
    });

    it('should return 404 for unknown paths', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 6,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/unknown`);
      expect(response.status).toBe(404);

      await server.close();
    });
  });

  describe('read-only behavior', () => {
    it('should reject POST requests to API endpoints', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 7,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/api/status`, {
        method: 'POST',
        body: JSON.stringify({ test: 'data' }),
      });

      expect(response.status).toBe(404);

      await server.close();
    });

    it('should reject PUT requests to API endpoints', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 8,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/api/status`, {
        method: 'PUT',
        body: JSON.stringify({ test: 'data' }),
      });

      expect(response.status).toBe(404);

      await server.close();
    });

    it('should reject DELETE requests to API endpoints', async () => {
      const { startDashboardServer } = await import('../../src/dashboard/dashboard-server.js');

      const server = await startDashboardServer({
        projectRoot: testDir,
        port: testPort + 9,
        noOpen: true,
      });

      const response = await fetch(`${server.url}/api/status`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);

      await server.close();
    });
  });
});
