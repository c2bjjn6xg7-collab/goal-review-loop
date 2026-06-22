import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { RunLister } from '../../src/web/run-lister.js';
import { EventStore } from '../../src/runtime/event-store.js';

describe('RunLister', () => {
  let tmpDir: string;
  let agentDir: string;
  let historyDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-lister-'));
    agentDir = path.join(tmpDir, '.agent');
    historyDir = path.join(agentDir, 'history');
    await fs.ensureDir(agentDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
    vi.restoreAllMocks();
  });

  it('returns empty runs and null active_run_id when nothing exists', async () => {
    const lister = new RunLister({ projectRoot: tmpDir });
    const out = await lister.list();
    expect(out.runs).toEqual([]);
    expect(out.active_run_id).toBeNull();
  });

  it('returns single is_active=true entry when only events.jsonl exists', async () => {
    const store = new EventStore(agentDir, 'run-active');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
    await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });
    const lister = new RunLister({ projectRoot: tmpDir });
    const out = await lister.list();
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].run_id).toBe('run-active');
    expect(out.runs[0].is_active).toBe(true);
    expect(out.runs[0].source).toBe('active');
    expect(out.runs[0].event_count).toBe(2);
    expect(out.runs[0].phase).toBe('PLANNING');
    expect(out.active_run_id).toBe('run-active');
  });

  it('sorts archives by started_at ascending, with active last', async () => {
    await fs.ensureDir(historyDir);
    // Three archives with deliberately interleaved timestamps.
    const ev = (
      runId: string,
      seq: number,
      ts: string,
      kind: string,
      phase: string,
    ): string =>
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        seq,
        event_id: `id-${runId}-${seq}`,
        ts,
        kind,
        phase,
        level: 'info',
        message: 'x',
      });

    await fs.writeFile(
      path.join(historyDir, 'events-20260101010101-aaaa.jsonl'),
      ev('20260101010101-aaaa', 1, '2026-01-01T01:01:01.000Z', 'run.started', 'INITIALIZING') +
        '\n' +
        ev('20260101010101-aaaa', 2, '2026-01-01T01:02:00.000Z', 'run.completed', 'PASSED') +
        '\n',
    );
    await fs.writeFile(
      path.join(historyDir, 'events-20260101020202-bbbb.jsonl'),
      ev('20260101020202-bbbb', 1, '2026-01-01T02:02:02.000Z', 'run.started', 'INITIALIZING') +
        '\n' +
        ev('20260101020202-bbbb', 2, '2026-01-01T02:03:00.000Z', 'run.failed', 'FAILED') +
        '\n',
    );
    await fs.writeFile(
      path.join(historyDir, 'events-20251231235959-cccc.jsonl'),
      ev('20251231235959-cccc', 1, '2025-12-31T23:59:59.000Z', 'run.started', 'INITIALIZING') +
        '\n' +
        ev('20251231235959-cccc', 2, '2025-12-31T23:59:59.500Z', 'run.blocked', 'BLOCKED') +
        '\n',
    );

    // Active run
    const store = new EventStore(agentDir, 'active-run');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });

    const lister = new RunLister({ projectRoot: tmpDir });
    const out = await lister.list();

    expect(out.runs).toHaveLength(4);
    expect(out.runs[0].run_id).toBe('20251231235959-cccc');
    expect(out.runs[1].run_id).toBe('20260101010101-aaaa');
    expect(out.runs[2].run_id).toBe('20260101020202-bbbb');
    expect(out.runs[3].run_id).toBe('active-run');
    expect(out.runs[3].is_active).toBe(true);
    expect(out.runs[0].is_active).toBe(false);
    expect(out.runs[0].source).toBe('history');
    expect(out.active_run_id).toBe('active-run');
  });

  it('skips malformed JSONL with console.warn', async () => {
    await fs.ensureDir(historyDir);
    // All-malformed file: every non-blank line fails JSON.parse,
    // so the file yields zero events and is skipped with a warning.
    await fs.writeFile(
      path.join(historyDir, 'events-99999999999999-bad.jsonl'),
      'this is not json\n{also not json\n',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const lister = new RunLister({ projectRoot: tmpDir });
    const out = await lister.list();

    expect(out.runs).toEqual([]);
    // All-malformed readable archive should warn.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('events-99999999999999-bad.jsonl'),
    );
    warnSpy.mockClear();

    // Also test the unreadable branch: a directory in place of a file.
    await fs.ensureDir(path.join(historyDir, 'events-12345678901234-dir.jsonl'));
    lister.clearCache();
    const out2 = await lister.list();
    expect(out2.runs).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('lists archive by first-event run_id when filename differs', async () => {
    await fs.ensureDir(historyDir);
    // Archive file named with one run_id, but events contain a different one.
    const embeddedRunId = '20260622050000-real';
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
    // Filename uses a DIFFERENT run_id than the embedded events.
    await fs.writeFile(
      path.join(historyDir, 'events-20260622020317-dticln.jsonl'),
      lines,
    );

    const lister = new RunLister({ projectRoot: tmpDir });
    const listing = await lister.list();

    expect(listing.runs).toHaveLength(1);
    // The listed run_id must be the first event's run_id, not the filename.
    expect(listing.runs[0].run_id).toBe(embeddedRunId);
    expect(listing.runs[0].phase).toBe('PASSED');
    expect(listing.runs[0].source).toBe('history');
  });

  it('derives phase from the LAST terminal event on a resumed run', async () => {
    await fs.ensureDir(historyDir);
    const lines = [
      { seq: 1, ts: '2026-01-02T00:00:00.000Z', kind: 'run.started', phase: 'INITIALIZING' },
      { seq: 2, ts: '2026-01-02T00:01:00.000Z', kind: 'run.blocked', phase: 'BLOCKED' },
      { seq: 3, ts: '2026-01-02T00:02:00.000Z', kind: 'run.resumed', phase: 'BLOCKED' },
      { seq: 4, ts: '2026-01-02T00:03:00.000Z', kind: 'run.completed', phase: 'PASSED' },
    ];
    const out = lines
      .map((l) =>
        JSON.stringify({
          schema_version: 1,
          run_id: '20260102000000-resm',
          event_id: 'id-' + l.seq,
          level: 'info',
          message: 'x',
          ...l,
        }),
      )
      .join('\n') + '\n';
    await fs.writeFile(path.join(historyDir, 'events-20260102000000-resm.jsonl'), out);

    const lister = new RunLister({ projectRoot: tmpDir });
    const listing = await lister.list();
    expect(listing.runs).toHaveLength(1);
    expect(listing.runs[0].phase).toBe('PASSED');
  });

  it('formats friendly_time as M/D HH:MM with no leading zeros on month/day', async () => {
    await fs.ensureDir(historyDir);
    // Use a UTC timestamp and check that the formatter applies local timezone
    // consistently. We just assert the regex shape since timezones differ
    // across environments.
    const ts = '2026-03-07T05:09:00.000Z';
    await fs.writeFile(
      path.join(historyDir, 'events-20260307050900-frnd.jsonl'),
      JSON.stringify({
        schema_version: 1,
        run_id: '20260307050900-frnd',
        seq: 1,
        event_id: 'id-1',
        ts,
        kind: 'run.started',
        phase: 'INITIALIZING',
        level: 'info',
        message: 'x',
      }) + '\n',
    );

    const lister = new RunLister({ projectRoot: tmpDir });
    const listing = await lister.list();
    expect(listing.runs).toHaveLength(1);
    const friendly = listing.runs[0].friendly_time;
    // Format: M/D HH:MM — month & day have no leading zero, HH:MM zero-padded.
    expect(friendly).toMatch(/^(?:[1-9]|1[0-2])\/(?:[1-9]|[12]\d|3[01]) \d{2}:\d{2}$/);
  });

  it('caches results for ~5 seconds across mutations', async () => {
    await fs.ensureDir(historyDir);
    await fs.writeFile(
      path.join(historyDir, 'events-20260101010101-cch1.jsonl'),
      JSON.stringify({
        schema_version: 1,
        run_id: '20260101010101-cch1',
        seq: 1,
        event_id: 'id-1',
        ts: '2026-01-01T01:01:01.000Z',
        kind: 'run.started',
        phase: 'INITIALIZING',
        level: 'info',
        message: 'x',
      }) + '\n',
    );

    const lister = new RunLister({ projectRoot: tmpDir });
    const first = await lister.list();
    expect(first.runs).toHaveLength(1);

    // Add a new archive in the middle of the cache window.
    await fs.writeFile(
      path.join(historyDir, 'events-20260101020202-cch2.jsonl'),
      JSON.stringify({
        schema_version: 1,
        run_id: '20260101020202-cch2',
        seq: 1,
        event_id: 'id-2',
        ts: '2026-01-01T02:02:02.000Z',
        kind: 'run.started',
        phase: 'INITIALIZING',
        level: 'info',
        message: 'x',
      }) + '\n',
    );

    const second = await lister.list();
    // Still cached → stable result, one run.
    expect(second).toBe(first);
    expect(second.runs).toHaveLength(1);

    // Invalidate cache and re-read; both archives appear.
    lister.clearCache();
    const third = await lister.list();
    expect(third.runs).toHaveLength(2);
  });
});