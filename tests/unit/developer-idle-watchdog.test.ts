/**
 * Phase 8D P6.5: unit tests for the Developer idle watchdog helper.
 *
 * Covers the two required behaviors — no-activity trip and activity-reset —
 * plus edge cases (stop prevents trip, pre-aborted controller, invalid
 * timeout, per-source resets, default stat path against real files).
 *
 * All time and file-stat sources are injected so the tests are fully
 * deterministic: no real timers, no fake-clock coupling, no flakiness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeveloperIdleWatchdog } from '../../src/orchestrator/developer-idle-watchdog.js';

interface Harness {
  controller: AbortController;
  sizes: Map<string, number>;
  tick: () => void;
  setTime: (ms: number) => void;
  time: () => number;
  timerActive: () => boolean;
}

/** Build a watchdog with injected clock, stat probe, and a captured tick callback. */
function makeHarness(
  overrides: Partial<ConstructorParameters<typeof DeveloperIdleWatchdog>[0]> & {
    idleTimeoutMs?: number;
  } = {},
): { watchdog: DeveloperIdleWatchdog } & Harness {
  const opts = {
    idleTimeoutMs: 2000,
    stdoutPath: '/tmp/stdout.log',
    stderrPath: '/tmp/stderr.log',
    handoffPath: '/tmp/handoff.md',
    pollIntervalMs: 500,
    ...overrides,
  };

  let currentTime = 0;
  const sizes = new Map<string, number>();
  let tickFn: (() => void) | null = null;
  let timerActive = false;

  const controller = new AbortController();
  const watchdog = new DeveloperIdleWatchdog({
    idleTimeoutMs: opts.idleTimeoutMs!,
    stdoutPath: opts.stdoutPath,
    stderrPath: opts.stderrPath,
    handoffPath: opts.handoffPath,
    controller,
    pollIntervalMs: opts.pollIntervalMs,
    now: () => currentTime,
    statSize: (p) => sizes.get(p) ?? -1,
    setIntervalFn: (fn) => {
      tickFn = fn;
      timerActive = true;
      return 1;
    },
    clearIntervalFn: () => {
      tickFn = null;
      timerActive = false;
    },
  });

  return {
    watchdog,
    controller,
    sizes,
    tick: () => tickFn?.(),
    setTime: (ms) => {
      currentTime = ms;
    },
    time: () => currentTime,
    timerActive: () => timerActive,
  };
}

describe('DeveloperIdleWatchdog', () => {
  describe('no-activity behavior', () => {
    it('trips and aborts the controller once the idle window elapses with no growth', () => {
      const h = makeHarness();
      h.watchdog.start();
      // Initial sizes are all -1; the watchdog must not read pre-existing
      // absence as activity, so the deadline starts at t=2000.
      expect(h.controller.signal.aborted).toBe(false);

      // First poll before the deadline: no growth, no trip.
      h.setTime(1000);
      h.tick();
      expect(h.controller.signal.aborted).toBe(false);

      // At the deadline: still no growth -> trip.
      h.setTime(2000);
      h.tick();

      const result = h.watchdog.getResult();
      expect(result.tripped).toBe(true);
      expect(h.controller.signal.aborted).toBe(true);
      expect(result.reason).not.toBeNull();
      expect(result.reason).toContain('idle for 2s');
      expect(result.reason).toContain('/tmp/stdout.log');
      expect(result.reason).toContain('/tmp/stderr.log');
      expect(result.reason).toContain('/tmp/handoff.md');
    });

    it('clears its polling timer when it trips', () => {
      const h = makeHarness();
      h.watchdog.start();
      expect(h.timerActive()).toBe(true);
      h.setTime(2000);
      h.tick();
      expect(h.timerActive()).toBe(false);
    });

    it('does not trip before the idle window elapses', () => {
      const h = makeHarness();
      h.watchdog.start();
      h.setTime(1999);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(false);
      expect(h.controller.signal.aborted).toBe(false);
    });
  });

  describe('activity-reset behavior', () => {
    it('resets the idle deadline when stdout grows and does not trip', () => {
      const h = makeHarness();
      h.watchdog.start();
      // deadline = 2000.

      // Past the original deadline (2500 > 2000) but stdout grew on this poll,
      // so the deadline is pushed to 2500 + 2000 = 4500 and no trip occurs.
      h.setTime(2500);
      h.sizes.set('/tmp/stdout.log', 100);
      h.tick();

      expect(h.watchdog.getResult().tripped).toBe(false);
      expect(h.controller.signal.aborted).toBe(false);

      // Without further growth, the new deadline (4500) still holds at 4000.
      h.setTime(4000);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(false);

      h.watchdog.stop();
    });

    it('keeps the attempt alive under continuous activity past the original deadline', () => {
      const h = makeHarness();
      h.watchdog.start();
      // Each poll advances well past the original 2000ms deadline but always
      // grows stdout, so the deadline keeps moving and the watchdog never trips.
      for (let i = 1; i <= 5; i++) {
        h.setTime(1500 * i); // 1500, 3000, 4500, 6000, 7500
        h.sizes.set('/tmp/stdout.log', i * 10);
        h.tick();
      }
      expect(h.watchdog.getResult().tripped).toBe(false);
      expect(h.controller.signal.aborted).toBe(false);
      h.watchdog.stop();
    });

    it('resets the deadline on stderr growth alone', () => {
      const h = makeHarness();
      h.watchdog.start();
      h.setTime(2500);
      h.sizes.set('/tmp/stderr.log', 50);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(false);
      h.watchdog.stop();
    });

    it('resets the deadline on handoff-file growth alone', () => {
      const h = makeHarness();
      h.watchdog.start();
      h.setTime(2500);
      h.sizes.set('/tmp/handoff.md', 200);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(false);
      h.watchdog.stop();
    });

    it('does not treat identical-size re-stat as activity (no reset, can trip later)', () => {
      const h = makeHarness();
      h.watchdog.start();
      // First poll: stdout appears (growth) at t=1000 -> deadline = 3000.
      h.setTime(1000);
      h.sizes.set('/tmp/stdout.log', 100);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(false);

      // Second poll: same size (no growth), still under deadline.
      h.setTime(2000);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(false);

      // Third poll: still no growth, now past deadline -> trip.
      h.setTime(3000);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(true);
      expect(h.controller.signal.aborted).toBe(true);
    });
  });

  describe('stop and lifecycle', () => {
    it('stop() prevents a subsequent trip even past the deadline', () => {
      const h = makeHarness();
      h.watchdog.start();
      h.watchdog.stop();
      h.setTime(10_000);
      h.tick(); // timer cleared; tick is a captured no-op
      expect(h.watchdog.getResult().tripped).toBe(false);
      expect(h.controller.signal.aborted).toBe(false);
      expect(h.timerActive()).toBe(false);
    });

    it('is idempotent: start() and stop() can be called multiple times safely', () => {
      const h = makeHarness();
      h.watchdog.start();
      h.watchdog.start();
      expect(h.timerActive()).toBe(true);
      h.watchdog.stop();
      h.watchdog.stop();
      expect(h.timerActive()).toBe(false);
    });

    it('does not trip if the controller was already aborted before a tick', () => {
      const h = makeHarness();
      h.watchdog.start();
      h.controller.abort('external cancel');
      h.setTime(2000);
      h.tick();
      expect(h.watchdog.getResult().tripped).toBe(false);
      // The abort reason from the external cancel is preserved.
      expect(h.controller.signal.reason).toBe('external cancel');
    });
  });

  describe('validation', () => {
    it('throws on a non-positive idle window', () => {
      expect(() => makeHarness({ idleTimeoutMs: 0 })).toThrow(/positive number/);
    });

    it('throws on a NaN idle window', () => {
      expect(() => makeHarness({ idleTimeoutMs: Number.NaN })).toThrow(/positive number/);
    });
  });

  describe('default stat path against real files', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'review-loop-watchdog-'));
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('trips using the default fs-based stat when real files do not grow', () => {
      const stdout = join(tmp, 'stdout.log');
      const stderr = join(tmp, 'stderr.log');
      const handoff = join(tmp, 'handoff.md');
      // Pre-create the logs so the initial snapshot is size 0.
      writeFileSync(stdout, '');
      writeFileSync(stderr, '');
      writeFileSync(handoff, '');

      let currentTime = 0;
      let tickFn: (() => void) | null = null;
      const controller = new AbortController();
      // Use the default statSize (real fs) by NOT injecting it.
      const watchdog = new DeveloperIdleWatchdog({
        idleTimeoutMs: 1000,
        stdoutPath: stdout,
        stderrPath: stderr,
        handoffPath: handoff,
        controller,
        pollIntervalMs: 500,
        now: () => currentTime,
        setIntervalFn: (fn) => {
          tickFn = fn;
          return 1;
        },
        clearIntervalFn: () => {
          tickFn = null;
        },
      });

      watchdog.start();
      currentTime = 1000;
      tickFn?.();
      const result = watchdog.getResult();
      expect(result.tripped).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      watchdog.stop();
    });

    it('does not trip using the default fs-based stat when real files grow', () => {
      const stdout = join(tmp, 'stdout.log');
      const stderr = join(tmp, 'stderr.log');
      const handoff = join(tmp, 'handoff.md');
      writeFileSync(stdout, '');
      writeFileSync(stderr, '');
      writeFileSync(handoff, '');

      let currentTime = 0;
      let tickFn: (() => void) | null = null;
      const controller = new AbortController();
      const watchdog = new DeveloperIdleWatchdog({
        idleTimeoutMs: 1000,
        stdoutPath: stdout,
        stderrPath: stderr,
        handoffPath: handoff,
        controller,
        pollIntervalMs: 500,
        now: () => currentTime,
        setIntervalFn: (fn) => {
          tickFn = fn;
          return 1;
        },
        clearIntervalFn: () => {
          tickFn = null;
        },
      });

      watchdog.start();
      // Past the original deadline, but the handoff file grows this poll.
      currentTime = 1500;
      writeFileSync(handoff, 'status: "COMPLETED"\n');
      tickFn?.();
      expect(watchdog.getResult().tripped).toBe(false);
      expect(controller.signal.aborted).toBe(false);
      watchdog.stop();
    });
  });
});
