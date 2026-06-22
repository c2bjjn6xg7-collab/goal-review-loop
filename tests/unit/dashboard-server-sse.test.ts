import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { createDashboardServer, type DashboardServer } from '../../src/web/dashboard-server.js';
import { EventStore } from '../../src/runtime/event-store.js';

interface SseClient {
  req: http.ClientRequest;
  res: http.IncomingMessage;
  buffer: () => string;
  close: () => void;
}

function openSseClient(port: number): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    let chunks = '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/events/stream',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks += c;
        });
        // 'end' / 'error' can happen on teardown; ignore silently.
        res.on('error', () => { /* ignore */ });
        res.on('end', () => { /* ignore */ });
        resolve({
          req,
          res,
          buffer: () => chunks,
          close: () => {
            try { req.destroy(); } catch { /* ignore */ }
            try { res.destroy(); } catch { /* ignore */ }
          },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return check();
}

describe('dashboard server SSE', () => {
  let tmpDir: string;
  let agentDir: string;
  let server: DashboardServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-sse-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
    await fs.writeFile(path.join(agentDir, 'state.json'), JSON.stringify({ run_id: 'run-sse' }));
    server = createDashboardServer({
      projectRoot: tmpDir,
      ssePollMs: 30,
      sseHeartbeatMs: 80,
    });
    port = await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    await fs.remove(tmpDir);
  });

  it('sends hello, delivers appended events, emits heartbeat, and stops promptly', async () => {
    const client = await openSseClient(port);

    // 1) hello frame arrives with the run id.
    const helloOk = await waitFor(
      () => client.buffer().includes('event: hello') && client.buffer().includes('"run_id":"run-sse"'),
      2000,
    );
    expect(helloOk).toBe(true);

    // 2) appending an event delivers a `data:` line containing the seq+kind.
    const store = new EventStore(agentDir, 'run-sse');
    const ev = await store.append({
      kind: 'phase.changed',
      phase: 'PLANNING',
      level: 'info',
      message: 'plan',
    });
    const dataOk = await waitFor(() => {
      const buf = client.buffer();
      return buf.includes(`"seq":${ev.seq}`) && buf.includes('"kind":"phase.changed"');
    }, 2000);
    expect(dataOk).toBe(true);

    // 3) at least one heartbeat arrives within ~500 ms (heartbeat interval is 80 ms).
    const hbOk = await waitFor(() => client.buffer().includes(': heartbeat\n\n'), 500);
    expect(hbOk).toBe(true);

    // 4) tearing down the client and stopping the server completes promptly.
    client.close();
    const stopStarted = Date.now();
    await server.stop();
    expect(Date.now() - stopStarted).toBeLessThan(1000);
  });

  it('sets text/event-stream headers and no-cache, keep-alive flags', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path: '/api/events/stream' },
        (res) => {
          try {
            expect(res.statusCode).toBe(200);
            expect(String(res.headers['content-type'])).toContain('text/event-stream');
            expect(String(res.headers['cache-control'])).toContain('no-cache');
            expect(String(res.headers['connection'])).toBe('keep-alive');
            req.destroy();
            resolve();
          } catch (e) {
            req.destroy();
            reject(e);
          }
        },
      );
      req.on('error', () => { /* destroy() triggers an error; ignore */ });
      req.end();
    });
  });

  it('uses run_id "unknown" when state.json is missing', async () => {
    await fs.remove(path.join(agentDir, 'state.json'));
    const client = await openSseClient(port);
    const ok = await waitFor(
      () => client.buffer().includes('event: hello') && client.buffer().includes('"run_id":"unknown"'),
      2000,
    );
    expect(ok).toBe(true);
    client.close();
  });

  it('stop() ends active SSE responses without blocking on lingering sockets', async () => {
    const c1 = await openSseClient(port);
    const c2 = await openSseClient(port);
    await waitFor(() => c1.buffer().includes('event: hello') && c2.buffer().includes('event: hello'), 2000);
    const stopStarted = Date.now();
    await server.stop();
    expect(Date.now() - stopStarted).toBeLessThan(1000);
    c1.close();
    c2.close();
  });

  it('GET /api/events still returns the JSON snapshot unchanged', async () => {
    const store = new EventStore(agentDir, 'run-sse');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'hi' });

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path: '/api/events' },
        (res) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        },
      );
      req.on('error', reject);
      req.end();
    });
    const snap = JSON.parse(body);
    expect(snap.run_id).toBe('run-sse');
    expect(Array.isArray(snap.latest_events)).toBe(true);
    expect(snap.latest_events[0].kind).toBe('run.started');
  });
});
