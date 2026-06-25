/**
 * Phase 8D P6.5: Developer idle watchdog helper.
 *
 * A focused watchdog that watches three activity sources for a single
 * Developer attempt — the attempt's stdout log, stderr log, and the Developer
 * handoff file. If none of the three grow within the configured idle window,
 * the watchdog aborts the per-attempt AbortController and reports a tripped
 * result with a clear reason.
 *
 * Responsibility boundary:
 *   - Does: poll the three sources, reset the idle deadline on growth, abort
 *     the supplied AbortController when the deadline elapses, and expose a
 *     structured result describing whether it tripped.
 *   - Does NOT: decide BLOCKED vs DEVELOPING, build OrchestratorResult, write
 *     iteration-log/progress/task-results, or choose which attempt to run.
 *     Wiring (start/stop around each Developer attempt) lives in
 *     task-graph-loop.ts; this module only owns detection + abort.
 *
 * The idle window is supplied in milliseconds by the caller (the config field
 * `agent_idle_timeout_seconds` is converted to ms at the call site) so this
 * helper stays unit-agnostic and trivially testable with an injected clock.
 *
 * Time and file-stat sources are injectable so tests can drive ticks and
 * activity deterministically without fake timers or a fake filesystem.
 */
import fs from 'node:fs';

/** Structured outcome reported by the watchdog after an attempt. */
export interface DeveloperIdleWatchdogResult {
  /** True iff the idle window elapsed with no activity and the controller was aborted. */
  tripped: boolean;
  /** Human-readable reason set when tripped; null otherwise. */
  reason: string | null;
  /** The idle window that was enforced, in milliseconds. */
  idleTimeoutMs: number;
  /** Path to the stdout log watched for growth. */
  stdoutPath: string;
  /** Path to the stderr log watched for growth. */
  stderrPath: string;
  /** Path to the Developer handoff file watched for growth. */
  handoffPath: string;
}

/** Options for constructing a {@link DeveloperIdleWatchdog}. */
export interface DeveloperIdleWatchdogOptions {
  /** Idle window in milliseconds. Must be a positive finite number. */
  idleTimeoutMs: number;
  /** Absolute path to the attempt's stdout log. */
  stdoutPath: string;
  /** Absolute path to the attempt's stderr log. */
  stderrPath: string;
  /** Absolute path to the Developer handoff file. */
  handoffPath: string;
  /** Per-attempt controller to abort when the idle window elapses. */
  controller: AbortController;
  /** Polling interval in ms. Defaults to 1000. */
  pollIntervalMs?: number;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  /** Injectable size probe: returns bytes, or -1 if the file is absent. Defaults to fs.statSync. */
  statSize?: (p: string) => number;
  /** Injectable scheduler. Defaults to setInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** Injectable scheduler clearer. Defaults to clearInterval. */
  clearIntervalFn?: (id: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Default size probe: file size in bytes, or -1 if missing/unreadable. */
function defaultStatSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

/**
 * Developer idle watchdog. Construct, call {@link start} before launching the
 * Developer attempt, and call {@link stop} once the attempt returns. Inspect
 * {@link getResult} afterwards to learn whether the idle window tripped.
 */
export class DeveloperIdleWatchdog {
  private readonly idleTimeoutMs: number;
  private readonly stdoutPath: string;
  private readonly stderrPath: string;
  private readonly handoffPath: string;
  private readonly controller: AbortController;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly statSize: (p: string) => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (id: unknown) => void;

  private lastStdout = -1;
  private lastHandoff = -1;
  private deadline = 0;
  private timerId: unknown = null;
  private started = false;
  private stopped = false;
  private tripped = false;
  private reason: string | null = null;

  constructor(opts: DeveloperIdleWatchdogOptions) {
    if (!Number.isFinite(opts.idleTimeoutMs) || opts.idleTimeoutMs <= 0) {
      throw new Error(
        `agent_idle_timeout_seconds must resolve to a positive number of milliseconds (got ${opts.idleTimeoutMs})`,
      );
    }
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.stdoutPath = opts.stdoutPath;
    this.stderrPath = opts.stderrPath;
    this.handoffPath = opts.handoffPath;
    this.controller = opts.controller;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.statSize = opts.statSize ?? defaultStatSize;
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  }

  /** Begin polling. Snapshots initial sizes so pre-existing logs don't read as activity. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastStdout = this.statSize(this.stdoutPath);
    this.lastHandoff = this.statSize(this.handoffPath);
    this.deadline = this.now() + this.idleTimeoutMs;
    this.timerId = this.setIntervalFn(() => this.tick(), this.pollIntervalMs);
  }

  /** Stop polling. Safe to call after a trip or after the attempt returns. Idempotent. */
  stop(): void {
    if (this.timerId !== null) {
      this.clearIntervalFn(this.timerId);
      this.timerId = null;
    }
    this.stopped = true;
  }

  /** Single poll. Re-stat the three sources; reset the deadline on growth, trip if elapsed. */
  private tick(): void {
    if (this.stopped || this.tripped || this.controller.signal.aborted) {
      return;
    }
    const curStdout = this.statSize(this.stdoutPath);
    const curHandoff = this.statSize(this.handoffPath);

    // Only stdout and handoff growth count as real developer activity.
    // stderr is excluded because heartbeat messages (written every 30s by
    // the shell wrapper) would keep the watchdog alive forever even when
    // the agent is actually stalled.
    const grew =
      curStdout > this.lastStdout ||
      curHandoff > this.lastHandoff;

    this.lastStdout = curStdout;
    this.lastHandoff = curHandoff;

    if (grew) {
      // Activity observed — push the idle deadline forward.
      this.deadline = this.now() + this.idleTimeoutMs;
      return;
    }

    if (this.now() >= this.deadline) {
      this.trip();
    }
  }

  /** Abort the controller and record the tripped result with a clear reason. */
  private trip(): void {
    this.tripped = true;
    const seconds = Math.round(this.idleTimeoutMs / 1000);
    this.reason =
      `Developer idle for ${seconds}s with no stdout, stderr, or handoff-file activity ` +
      `(stdout=${this.stdoutPath}, stderr=${this.stderrPath}, handoff=${this.handoffPath}). ` +
      `Inspect the prompt and logs, or widen allowed_changes if scope-blocked.`;
    if (!this.controller.signal.aborted) {
      this.controller.abort(this.reason);
    }
    this.stop();
  }

  /** Report whether the watchdog tripped, plus the watched paths for stall detail. */
  getResult(): DeveloperIdleWatchdogResult {
    return {
      tripped: this.tripped,
      reason: this.reason,
      idleTimeoutMs: this.idleTimeoutMs,
      stdoutPath: this.stdoutPath,
      stderrPath: this.stderrPath,
      handoffPath: this.handoffPath,
    };
  }
}
