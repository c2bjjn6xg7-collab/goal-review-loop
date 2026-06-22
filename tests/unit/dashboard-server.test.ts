import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { createDashboardServer, type DashboardServer } from '../../src/web/dashboard-server.js';
import { EventStore } from '../../src/runtime/event-store.js';

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

describe('dashboard server', () => {
  let tmpDir: string;
  let agentDir: string;
  let server: DashboardServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-srv-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
    server = createDashboardServer({ projectRoot: tmpDir });
    port = await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    await fs.remove(tmpDir);
  });

  it('binds to 127.0.0.1 with a non-zero port', () => {
    expect(port).toBeGreaterThan(0);
    expect(server.port()).toBe(port);
  });

  it('GET / returns the HTML dashboard', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-type']).toContain('utf-8');
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain("fetch('/api/events'");
  });

  it('GET /api/events returns a JSON snapshot when events exist', async () => {
    const store = new EventStore(agentDir, 'run-srv');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'hi' });
    await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'plan' });

    const res = await request(port, 'GET', '/api/events');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const snap = JSON.parse(res.body);
    expect(snap.run_id).toBe('run-srv');
    expect(snap.current_phase).toBe('PLANNING');
    expect(snap.latest_events).toHaveLength(2);
    expect(snap.latest_events[0].seq).toBe(1);
    expect(snap.latest_events[1].seq).toBe(2);
    expect(Array.isArray(snap.artifacts)).toBe(true);
  });

  it('GET /api/events degrades gracefully when events.jsonl is missing', async () => {
    const res = await request(port, 'GET', '/api/events');
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body);
    expect(snap.run_id).toBe('unknown');
    expect(snap.current_phase).toBe('unknown');
    expect(snap.latest_events).toEqual([]);
    expect(snap.artifacts).toEqual([]);
  });

  it('GET /api/events degrades gracefully when .agent does not exist', async () => {
    await fs.remove(agentDir);
    const res = await request(port, 'GET', '/api/events');
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body);
    expect(snap.run_id).toBe('unknown');
    expect(snap.latest_events).toEqual([]);
  });

  it('unknown paths return 404 JSON', async () => {
    const res = await request(port, 'GET', '/no/such/path');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.error).toBe('not_found');
    expect(body.path).toBe('/no/such/path');
  });

  it('non-GET methods return 405 JSON', async () => {
    const res = await request(port, 'POST', '/api/events');
    expect(res.status).toBe(405);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.error).toBe('method_not_allowed');
  });

  it('stop() closes the listener so further requests fail', async () => {
    await server.stop();
    expect(server.port()).toBeNull();
    await expect(request(port, 'GET', '/')).rejects.toThrow();
  });
});
