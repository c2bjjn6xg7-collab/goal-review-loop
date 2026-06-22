import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { DashboardEventSource, MAX_LATEST_EVENTS } from '../../src/web/event-source.js';
import { EventStore } from '../../src/runtime/event-store.js';

describe('DashboardEventSource', () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-evt-src-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns empty snapshot when .agent is missing', async () => {
    await fs.remove(agentDir);
    const src = new DashboardEventSource({ projectRoot: tmpDir });
    const snap = await src.getSnapshot();
    expect(snap.run_id).toBe('unknown');
    expect(snap.current_phase).toBe('unknown');
    expect(snap.latest_events).toEqual([]);
    expect(snap.artifacts).toEqual([]);
  });

  it('returns empty snapshot when events.jsonl is missing', async () => {
    await fs.writeFile(path.join(agentDir, 'state.json'), JSON.stringify({ run_id: 'run-x' }));
    const src = new DashboardEventSource({ projectRoot: tmpDir });
    const snap = await src.getSnapshot();
    expect(snap.run_id).toBe('run-x');
    expect(snap.current_phase).toBe('unknown');
    expect(snap.latest_events).toEqual([]);
    expect(snap.artifacts).toEqual([]);
  });

  it('returns sorted events with current_phase from last non-terminal event', async () => {
    const store = new EventStore(agentDir, 'run-1');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'start' });
    await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'plan' });
    await store.append({ kind: 'role.started', phase: 'DEVELOPING', level: 'info', message: 'dev start', role: 'developer' });

    const src = new DashboardEventSource({ projectRoot: tmpDir });
    const snap = await src.getSnapshot();
    expect(snap.run_id).toBe('run-1');
    expect(snap.current_phase).toBe('DEVELOPING');
    expect(snap.latest_events).toHaveLength(3);
    expect(snap.latest_events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('uses terminal event phase when present', async () => {
    const store = new EventStore(agentDir, 'run-1');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
    await store.append({ kind: 'run.completed', phase: 'PASSED', level: 'info', message: 'done' });
    await store.append({ kind: 'role.heartbeat', phase: 'IDLE', level: 'info', message: 'after' });

    const src = new DashboardEventSource({ projectRoot: tmpDir });
    const snap = await src.getSnapshot();
    expect(snap.current_phase).toBe('PASSED');
  });

  it('truncates latest_events to the most recent MAX_LATEST_EVENTS', async () => {
    const store = new EventStore(agentDir, 'run-1');
    const total = MAX_LATEST_EVENTS + 5;
    for (let i = 0; i < total; i++) {
      await store.append({ kind: 'role.heartbeat', phase: 'DEVELOPING', level: 'info', message: `msg-${i}` });
    }
    const src = new DashboardEventSource({ projectRoot: tmpDir });
    const snap = await src.getSnapshot();
    expect(snap.latest_events).toHaveLength(MAX_LATEST_EVENTS);
    expect(snap.latest_events[0].seq).toBe(total - MAX_LATEST_EVENTS + 1);
    expect(snap.latest_events[snap.latest_events.length - 1].seq).toBe(total);
  });

  it('dedupes artifacts by type:path and preserves labels', async () => {
    const store = new EventStore(agentDir, 'run-1');
    await store.append({
      kind: 'artifact.created',
      phase: 'DEVELOPING',
      level: 'info',
      message: 'a',
      artifact_refs: [
        { type: 'transcript', path: '.agent/transcripts/dev-1.md', label: 'dev #1' },
        { type: 'transcript', path: '.agent/transcripts/dev-2.md' },
      ],
    });
    await store.append({
      kind: 'artifact.created',
      phase: 'DEVELOPING',
      level: 'info',
      message: 'b',
      artifact_refs: [
        { type: 'transcript', path: '.agent/transcripts/dev-1.md', label: 'duplicate' },
        { type: 'state', path: '.agent/state.json' },
      ],
    });

    const src = new DashboardEventSource({ projectRoot: tmpDir });
    const snap = await src.getSnapshot();
    expect(snap.artifacts).toHaveLength(3);
    const first = snap.artifacts.find((a) => a.path === '.agent/transcripts/dev-1.md');
    expect(first?.label).toBe('dev #1');
    expect(snap.artifacts.map((a) => `${a.type}:${a.path}`).sort()).toEqual([
      'state:.agent/state.json',
      'transcript:.agent/transcripts/dev-1.md',
      'transcript:.agent/transcripts/dev-2.md',
    ]);
  });

  it('prefers run_id from state.json over events run_id', async () => {
    const store = new EventStore(agentDir, 'run-evt');
    await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
    await fs.writeFile(path.join(agentDir, 'state.json'), JSON.stringify({ run_id: 'run-state' }));
    const src = new DashboardEventSource({ projectRoot: tmpDir });
    const snap = await src.getSnapshot();
    expect(snap.run_id).toBe('run-state');
  });
});
