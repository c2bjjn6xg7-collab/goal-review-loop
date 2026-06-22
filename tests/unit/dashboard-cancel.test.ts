import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { createDashboardServer, type DashboardServer } from '../../src/web/dashboard-server.js';
import { StateStore } from '../../src/orchestrator/state-store.js';
import { Phase } from '../../src/types.js';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, method: string, urlPath: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function writeStateAt(agentDir: string, phase: Phase): Promise<string> {
  const store = new StateStore(agentDir);
  const initial = store.buildInitialState({
    run_id: 'run-cancel-test',
    task_slug: 'cancel-test',
    project_root: agentDir,
    base_commit: 'abc1234',
    branch: 'main',
    max_iterations: 3,
  });
  const withPhase = { ...initial, phase };
  await fs.writeJSON(path.join(agentDir, 'state.json'), withPhase, { spaces: 2 });
  return withPhase.run_id;
}

describe('dashboard server — POST /api/cancel', () => {
  let tmpDir: string;
  let agentDir: string;
  let server: DashboardServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-cancel-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
    server = createDashboardServer({ projectRoot: tmpDir });
    port = await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    await fs.remove(tmpDir);
  });

  it('200 happy path writes cancel-request.json with dashboard:<pid>', async () => {
    const runId = await writeStateAt(agentDir, Phase.DEVELOPING);
    // Intentionally do NOT write run.lock — skips the SIGTERM branch.

    const res = await request(port, 'POST', '/api/cancel');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.message).toBe('cancel requested');
    expect(body.run_id).toBe(runId);
    expect(typeof body.requested_at).toBe('string');
    expect(body.requested_at.length).toBeGreaterThan(0);

    const cancelPath = path.join(agentDir, 'cancel-request.json');
    expect(await fs.pathExists(cancelPath)).toBe(true);
    const written = await fs.readJSON(cancelPath);
    expect(written.schema_version).toBe(1);
    expect(written.run_id).toBe(runId);
    expect(written.requested_by).toBe(`dashboard:${process.pid}`);
    expect(typeof written.requested_at).toBe('string');
  });

  it('returns 409 when state.json is in a terminal phase', async () => {
    await writeStateAt(agentDir, Phase.FAILED);

    const res = await request(port, 'POST', '/api/cancel');
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.error).toBe('run_terminal');
    expect(body.phase).toBe('FAILED');

    const cancelPath = path.join(agentDir, 'cancel-request.json');
    expect(await fs.pathExists(cancelPath)).toBe(false);
  });

  it('returns 409 when state.json is missing', async () => {
    // Fresh .agent directory — no state.json present.
    const res = await request(port, 'POST', '/api/cancel');
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.error).toBe('no_active_run');

    const cancelPath = path.join(agentDir, 'cancel-request.json');
    expect(await fs.pathExists(cancelPath)).toBe(false);
  });

  it('GET /api/cancel returns 405', async () => {
    await writeStateAt(agentDir, Phase.DEVELOPING);
    const res = await request(port, 'GET', '/api/cancel');
    expect(res.status).toBe(405);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.error).toBe('method_not_allowed');

    const cancelPath = path.join(agentDir, 'cancel-request.json');
    expect(await fs.pathExists(cancelPath)).toBe(false);
  });
});
