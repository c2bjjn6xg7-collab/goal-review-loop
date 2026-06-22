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

async function writeArchiveFile(
  historyDir: string,
  runId: string,
  events: Array<{ seq: number; ts: string; kind: string; phase: string; level?: string; message?: string }>,
): Promise<void> {
  await fs.ensureDir(historyDir);
  const lines = events
    .map((e) =>
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        event_id: `id-${runId}-${e.seq}`,
        level: e.level ?? 'info',
        message: e.message ?? 'x',
        ...e,
      }),
    )
    .join('\n') + '\n';
  await fs.writeFile(path.join(historyDir, `events-${runId}.jsonl`), lines);
}

describe('dashboard server — Phase 9 R3 runs API', () => {
  let tmpDir: string;
  let agentDir: string;
  let historyDir: string;
  let server: DashboardServer;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-runs-'));
    agentDir = path.join(tmpDir, '.agent');
    historyDir = path.join(agentDir, 'history');
    await fs.ensureDir(agentDir);
    server = createDashboardServer({ projectRoot: tmpDir });
    port = await server.start(0);
  });

  afterEach(async () => {
    await server.stop();
    await fs.remove(tmpDir);
  });

  it('GET /api/runs returns RunListing shape with archives + active', async () => {
    await writeArchiveFile(historyDir, '20260101010101-arc1', [
      { seq: 1, ts: '2026-01-01T01:01:01.000Z', kind: 'run.started', phase: 'INITIALIZING' },
      { seq: 2, ts: '2026-01-01T01:02:00.000Z', kind: 'run.completed', phase: 'PASSED' },
    ]);
    const store = new EventStore(agentDir, '20260102020202-act1');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });

    const res = await request(port, 'GET', '/api/runs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.active_run_id).toBe('20260102020202-act1');
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].run_id).toBe('20260101010101-arc1');
    expect(body.runs[0].is_active).toBe(false);
    expect(body.runs[0].source).toBe('history');
    expect(body.runs[0].phase).toBe('PASSED');
    expect(typeof body.runs[0].friendly_time).toBe('string');
    expect(typeof body.runs[0].started_at).toBe('string');
    expect(typeof body.runs[0].event_count).toBe('number');
    expect(body.runs[1].run_id).toBe('20260102020202-act1');
    expect(body.runs[1].is_active).toBe(true);
    expect(body.runs[1].source).toBe('active');
  });

  it('GET /api/events?run_id=<archived> returns the archive snapshot', async () => {
    await writeArchiveFile(historyDir, '20260101010101-arch', [
      { seq: 1, ts: '2026-01-01T01:01:01.000Z', kind: 'run.started', phase: 'INITIALIZING' },
      { seq: 2, ts: '2026-01-01T01:02:00.000Z', kind: 'phase.changed', phase: 'PLANNING' },
      { seq: 3, ts: '2026-01-01T01:03:00.000Z', kind: 'run.completed', phase: 'PASSED' },
    ]);

    const res = await request(port, 'GET', '/api/events?run_id=20260101010101-arch');
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body);
    expect(snap.run_id).toBe('20260101010101-arch');
    expect(snap.current_phase).toBe('PASSED');
    expect(snap.latest_events).toHaveLength(3);
    expect(snap.latest_events[0].seq).toBe(1);
    expect(snap.latest_events[2].seq).toBe(3);
  });

  it('GET /api/events?run_id=<format-valid but unknown> returns 404', async () => {
    const res = await request(port, 'GET', '/api/events?run_id=20260101010101-zzzz');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('run_not_found');
    expect(body.run_id).toBe('20260101010101-zzzz');
  });

  it('GET /api/events?run_id=../../etc/passwd returns 400', async () => {
    const res = await request(port, 'GET', '/api/events?run_id=' + encodeURIComponent('../../etc/passwd'));
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('invalid_run_id');
    expect(body.run_id).toBe('../../etc/passwd');
  });

  it('GET /api/events with no parameter is unchanged (matches pre-R3 behavior)', async () => {
    const store = new EventStore(agentDir, '20260101010101-act');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
    await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });

    const res = await request(port, 'GET', '/api/events');
    expect(res.status).toBe(200);
    const snap = JSON.parse(res.body);
    expect(snap.run_id).toBe('20260101010101-act');
    expect(snap.current_phase).toBe('PLANNING');
    expect(snap.latest_events).toHaveLength(2);
  });

  it('GET /api/events?run_id=<active> matches no-param behavior byte-for-byte', async () => {
    await fs.writeFile(path.join(agentDir, 'state.json'), JSON.stringify({ run_id: '20260101010101-act' }));
    const store = new EventStore(agentDir, '20260101010101-act');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
    await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });

    const noParam = await request(port, 'GET', '/api/events');
    const withActive = await request(port, 'GET', '/api/events?run_id=20260101010101-act');
    expect(noParam.status).toBe(200);
    expect(withActive.status).toBe(200);
    expect(withActive.body).toBe(noParam.body);
  });

  it('GET /api/events?run_id= (empty string) is treated as no-param', async () => {
    const store = new EventStore(agentDir, '20260101010101-emp');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
    const noParam = await request(port, 'GET', '/api/events');
    const emptyParam = await request(port, 'GET', '/api/events?run_id=');
    expect(emptyParam.body).toBe(noParam.body);
  });

  it('resolves archive by first-event run_id when filename differs', async () => {
    // Write an archive where the filename encodes one run_id but events
    // contain a different one. This tests the cross-run contamination case.
    const embeddedRunId = '20260622050000-real';
    const filenameRunId = '20260622020317-dticln';
    const lines = [
      JSON.stringify({
        schema_version: 1,
        run_id: embeddedRunId,
        seq: 1,
        event_id: 'id-1',
        ts: '2026-06-22T05:00:00.000Z',
        kind: 'run.started',
        phase: 'INITIALIZING',
        level: 'info',
        message: 'x',
      }),
      JSON.stringify({
        schema_version: 1,
        run_id: embeddedRunId,
        seq: 2,
        event_id: 'id-2',
        ts: '2026-06-22T05:01:00.000Z',
        kind: 'run.completed',
        phase: 'PASSED',
        level: 'info',
        message: 'x',
      }),
    ].join('\n') + '\n';
    await fs.ensureDir(historyDir);
    await fs.writeFile(
      path.join(historyDir, `events-${filenameRunId}.jsonl`),
      lines,
    );

    // /api/runs should list the embedded run_id, not the filename.
    const runsRes = await request(port, 'GET', '/api/runs');
    expect(runsRes.status).toBe(200);
    const runsBody = JSON.parse(runsRes.body);
    const archived = runsBody.runs.find((r: { source: string }) => r.source === 'history');
    expect(archived).toBeDefined();
    expect(archived.run_id).toBe(embeddedRunId);

    // /api/events?run_id=<embedded-id> should return the snapshot.
    const eventsRes = await request(port, 'GET', `/api/events?run_id=${embeddedRunId}`);
    expect(eventsRes.status).toBe(200);
    const snap = JSON.parse(eventsRes.body);
    expect(snap.run_id).toBe(embeddedRunId);
    expect(snap.current_phase).toBe('PASSED');
    expect(snap.latest_events).toHaveLength(2);

    // /api/events?run_id=<filename-id> should 404 (not find by filename).
    const byFilename = await request(port, 'GET', `/api/events?run_id=${filenameRunId}`);
    expect(byFilename.status).toBe(404);
  });
});