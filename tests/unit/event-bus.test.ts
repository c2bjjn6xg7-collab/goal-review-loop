import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { EventBus } from '../../src/runtime/event-bus.js';
import { EventStore } from '../../src/runtime/event-store.js';

describe('Event Bus', () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-bus-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('emit', () => {
    it('should normalize required fields (run_id, seq, event_id, ts) via the store', async () => {
      const bus = new EventBus(agentDir, 'run-1');
      const ev = await bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'started' });
      expect(ev.run_id).toBe('run-1');
      expect(ev.seq).toBe(1);
      expect(ev.event_id).toBeTruthy();
      expect(ev.ts).toBeTruthy();
      expect(ev.schema_version).toBe(1);
    });

    it('should persist through the underlying EventStore', async () => {
      const bus = new EventBus(agentDir, 'run-1');
      await bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      await bus.emit({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });

      const store = new EventStore(agentDir, 'run-1');
      const events = await store.readAll();
      expect(events).toHaveLength(2);
    });

    it('should include role/provider/model/phase when provided', async () => {
      const bus = new EventBus(agentDir, 'run-1');
      const ev = await bus.emit({
        kind: 'role.started',
        phase: 'PLANNING',
        level: 'info',
        message: 'planner starting',
        role: 'planner',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
      });
      expect(ev.role).toBe('planner');
      expect(ev.provider).toBe('anthropic');
      expect(ev.model).toBe('claude-sonnet-4');
      expect(ev.phase).toBe('PLANNING');
    });

    it('should emit provider.failure with payload for quota stderr', async () => {
      const bus = new EventBus(agentDir, 'run-1');
      const ev = await bus.emit({
        kind: 'provider.failure',
        phase: 'AUDITING',
        level: 'error',
        message: 'Codex workspace is out of credits',
        role: 'auditor',
        provider: 'openai',
        model: 'gpt-5.5',
        payload: { classification: 'quota_exhausted', retry_recommended: false },
        artifact_refs: [{ type: 'stderr', path: '.agent/debug/auditor.stderr.log' }],
      });
      expect(ev.kind).toBe('provider.failure');
      expect(ev.level).toBe('error');
      expect(ev.payload).toEqual({ classification: 'quota_exhausted', retry_recommended: false });
      expect(ev.artifact_refs).toHaveLength(1);
    });
  });

  describe('subscribers', () => {
    it('should deliver appended events to subscribers in order', async () => {
      const bus = new EventBus(agentDir, 'run-1');
      const received: string[] = [];
      bus.subscribe((ev) => received.push(ev.message));

      await bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'first' });
      await bus.emit({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'second' });
      await bus.emit({ kind: 'role.started', phase: 'PLANNING', level: 'info', message: 'third', role: 'planner' });

      expect(received).toEqual(['first', 'second', 'third']);
    });

    it('should support multiple subscribers', async () => {
      const bus = new EventBus(agentDir, 'run-1');
      const a: number[] = [];
      const b: number[] = [];
      bus.subscribe((ev) => a.push(ev.seq));
      bus.subscribe((ev) => b.push(ev.seq));

      await bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      await bus.emit({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });

      expect(a).toEqual([1, 2]);
      expect(b).toEqual([1, 2]);
    });

    it('should allow unsubscribing via the returned disposer', async () => {
      const bus = new EventBus(agentDir, 'run-1');
      const received: string[] = [];
      const dispose = bus.subscribe((ev) => received.push(ev.message));

      await bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      dispose();
      await bus.emit({ kind: 'phase.changed', phase: 'PLANNING', level: 'info', message: 'b' });

      expect(received).toEqual(['a']);
    });
  });

  describe('fail-soft', () => {
    it('should not throw when the underlying store append fails', async () => {
      // Make the events path unwritable by pointing the bus at a file inside
      // a path that does not exist and cannot be created.
      const bus = new EventBus(path.join(agentDir, 'no-such-subdir'), 'run-1');
      // Suppress the expected console warning to keep test output clean.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Fail-soft: never throws, and returns a transient event so an
      // in-process watch can still render it. Persistence is skipped.
      const ev = await bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'a' });
      expect(ev).toBeDefined();
      expect(ev?.seq).toBe(-1); // transient marker, not persisted
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should still notify subscribers even if persistence fails', async () => {
      const bus = new EventBus(path.join(agentDir, 'no-such-subdir'), 'run-1');
      const received: string[] = [];
      bus.subscribe((ev) => received.push(ev.message));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'soft' });
      expect(received).toEqual(['soft']);
      warnSpy.mockRestore();
    });
  });

  describe('createNull', () => {
    it('should provide a no-op bus that never throws', async () => {
      const bus = EventBus.createNull();
      const received: string[] = [];
      bus.subscribe((ev) => received.push(ev.message));
      await expect(
        bus.emit({ kind: 'run.started', phase: 'INITIALIZING', level: 'info', message: 'noop' }),
      ).resolves.toBeUndefined();
      // Null bus does not persist and does not notify; it just must not throw.
      expect(received).toEqual([]);
    });
  });
});
