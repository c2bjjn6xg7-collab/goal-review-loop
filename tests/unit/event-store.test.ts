import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { EventStore } from '../../src/runtime/event-store.js';
import type { EventDraft, ReviewLoopEvent } from '../../src/runtime/event-store.js';

describe('Event Store', () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-events-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('append', () => {
    it('should create .agent/events.jsonl when missing', async () => {
      const store = new EventStore(agentDir, 'run-1');
      const eventsPath = path.join(agentDir, 'events.jsonl');
      expect(fs.existsSync(eventsPath)).toBe(false);

      const ev = await store.append({
        kind: 'run.started',
        phase: 'INITIALIZING',
        level: 'info',
        message: 'Run started',
      });

      expect(fs.existsSync(eventsPath)).toBe(true);
      expect(ev.seq).toBe(1);
      expect(ev.run_id).toBe('run-1');
      expect(ev.event_id).toBeTruthy();
      expect(ev.ts).toBeTruthy();
    });

    it('should assign monotonically increasing sequence numbers', async () => {
      const store = new EventStore(agentDir, 'run-1');
      const e1 = await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      const e2 = await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });
      const e3 = await store.append({ kind: 'role.started', phase: 'PLANNING', level: 'info', message: 'c', role: 'planner' });

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e3.seq).toBe(3);
      expect(e1.event_id).not.toBe(e2.event_id);
    });

    it('should continue sequence after resume on a new EventStore instance', async () => {
      const store1 = new EventStore(agentDir, 'run-1');
      await store1.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      await store1.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });

      // Simulate resume: new process, same run id and agent dir
      const store2 = new EventStore(agentDir, 'run-1');
      const resumed = await store2.append({ kind: 'run.resumed', phase: 'PLANNING', level: 'info', message: 'resumed' });

      expect(resumed.seq).toBe(3);
    });

    it('should preserve artifact refs and payloads', async () => {
      const store = new EventStore(agentDir, 'run-1');
      const ev = await store.append({
        kind: 'verification.completed',
        phase: 'VERIFYING',
        level: 'info',
        message: 'all passed',
        duration_ms: 1234,
        exit_code: 0,
        artifact_refs: [
          { type: 'verification-log', path: '.agent/verify.log', label: 'full log' },
        ],
        payload: { commands: ['typecheck', 'lint', 'build'] },
      });

      expect(ev.artifact_refs).toEqual([
        { type: 'verification-log', path: '.agent/verify.log', label: 'full log' },
      ]);
      expect(ev.payload).toEqual({ commands: ['typecheck', 'lint', 'build'] });
      expect(ev.duration_ms).toBe(1234);
      expect(ev.exit_code).toBe(0);
    });

    it('should default schema_version to 1', async () => {
      const store = new EventStore(agentDir, 'run-1');
      const ev = await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      expect(ev.schema_version).toBe(1);
    });
  });

  describe('readAll', () => {
    it('should read existing events in order', async () => {
      const store = new EventStore(agentDir, 'run-1');
      await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'first' });
      await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'second' });
      await store.append({ kind: 'role.started', phase: 'PLANNING', level: 'info', message: 'third', role: 'planner' });

      const events = await store.readAll();
      expect(events).toHaveLength(3);
      expect(events[0].message).toBe('first');
      expect(events[1].message).toBe('second');
      expect(events[2].message).toBe('third');
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it('should return empty array when no events file exists', async () => {
      const store = new EventStore(agentDir, 'run-1');
      const events = await store.readAll();
      expect(events).toEqual([]);
    });
  });

  describe('readSince', () => {
    it('should return only events with seq greater than the cursor', async () => {
      const store = new EventStore(agentDir, 'run-1');
      await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });
      await store.append({ kind: 'role.started', phase: 'PLANNING', level: 'info', message: 'c', role: 'planner' });

      const tail = await store.readSince(1);
      expect(tail).toHaveLength(2);
      expect(tail[0].seq).toBe(2);
      expect(tail[1].seq).toBe(3);
    });
  });

  describe('getLastSequence', () => {
    it('should return 0 for a fresh store', async () => {
      const store = new EventStore(agentDir, 'run-1');
      expect(await store.getLastSequence()).toBe(0);
    });

    it('should return the highest seq after appends', async () => {
      const store = new EventStore(agentDir, 'run-1');
      await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      await store.append({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });
      expect(await store.getLastSequence()).toBe(2);
    });
  });

  describe('malformed line tolerance', () => {
    it('should ignore a trailing partial JSONL line without crashing', async () => {
      const eventsPath = path.join(agentDir, 'events.jsonl');
      // Write one good line and one truncated/partial line
      const goodEvent: ReviewLoopEvent = {
        schema_version: 1,
        run_id: 'run-1',
        seq: 1,
        event_id: 'ev-1',
        ts: new Date().toISOString(),
        kind: 'run.started',
        phase: 'INITIALIZING',
        level: 'info',
        message: 'good',
      };
      const partialLine = '{"kind":"phase.changed","phase":"PLANNING"'; // truncated
      await fs.writeFile(eventsPath, JSON.stringify(goodEvent) + '\n' + partialLine + '\n', 'utf8');

      const store = new EventStore(agentDir, 'run-1');
      const events = await store.readAll();
      // Partial line is ignored, not thrown
      expect(events).toHaveLength(1);
      expect(events[0].message).toBe('good');
      // getLastSequence must still recover the good seq
      expect(await store.getLastSequence()).toBe(1);

      // Appending a new event must continue the sequence cleanly
      const next = await store.append({ kind: 'run.resumed', phase: 'PLANNING', level: 'info', message: 'resumed' });
      expect(next.seq).toBe(2);
    });

    it('should start seq at 1 if file only has garbage', async () => {
      const eventsPath = path.join(agentDir, 'events.jsonl');
      await fs.writeFile(eventsPath, 'not json at all\nalso not json\n', 'utf8');

      const store = new EventStore(agentDir, 'run-1');
      expect(await store.getLastSequence()).toBe(0);
      const ev = await store.append({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'first' });
      expect(ev.seq).toBe(1);
    });
  });
});
