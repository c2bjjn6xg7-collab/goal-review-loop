/**
 * Event Store — append-only durable run event log.
 * Phase 9 R1: `.agent/events.jsonl`
 *
 * The store assigns `seq`, `event_id`, and `ts`. It is observability-only:
 * the authoritative run state remains `.agent/state.json`.
 *
 * Tolerates a trailing partial JSONL line by ignoring it, so a crash mid-append
 * does not corrupt future reads.
 */
import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'node:crypto';

export const EVENT_SCHEMA_VERSION = 1 as const;
export const EVENTS_FILENAME = 'events.jsonl';

export type ReviewLoopEventKind =
  | 'run.started'
  | 'run.resumed'
  | 'run.completed'
  | 'run.blocked'
  | 'run.failed'
  | 'phase.changed'
  | 'role.started'
  | 'role.heartbeat'
  | 'role.output'
  | 'role.error'
  | 'role.exited'
  | 'verification.started'
  | 'verification.completed'
  | 'verification.failed'
  | 'audit.decision'
  | 'rework.requested'
  | 'task.started'
  | 'task.completed'
  | 'task.blocked'
  | 'wave.started'
  | 'wave.completed'
  | 'integration.started'
  | 'integration.completed'
  | 'integration.blocked'
  | 'provider.failure'
  | 'artifact.created';

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export type ArtifactRefType =
  | 'prompt'
  | 'transcript'
  | 'stdout'
  | 'stderr'
  | 'verification-log'
  | 'diff'
  | 'scope-report'
  | 'audit-report'
  | 'final-audit'
  | 'integration-metadata'
  | 'state';

export interface ArtifactRef {
  type: ArtifactRefType;
  path: string;
  label?: string;
}

export interface ReviewLoopEvent {
  schema_version: typeof EVENT_SCHEMA_VERSION;
  run_id: string;
  seq: number;
  event_id: string;
  ts: string;
  kind: ReviewLoopEventKind;
  phase: string;
  level: EventLevel;
  message: string;
  role?: string;
  task_id?: string;
  wave_index?: number;
  status?: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  exit_code?: number;
  artifact_refs?: ArtifactRef[];
  payload?: Record<string, unknown>;
}

/**
 * What callers pass in. `seq`, `event_id`, `ts`, `run_id`, and
 * `schema_version` are assigned by the store.
 */
export interface EventDraft {
  kind: ReviewLoopEventKind;
  phase: string;
  level: EventLevel;
  message: string;
  role?: string;
  task_id?: string;
  wave_index?: number;
  status?: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  exit_code?: number;
  artifact_refs?: ArtifactRef[];
  payload?: Record<string, unknown>;
}

export class EventStore {
  private readonly eventsPath: string;
  private readonly runId: string;
  private cachedLastSeq: number | null = null;
  /**
   * In-process append serialization. Wave mode fires events concurrently from
   * `Promise.all` workers; without a chain, two appends can both read the same
   * `lastSeq` and produce duplicate seq values. Each append awaits the
   * previous one before computing its own seq.
   */
  private appendChain: Promise<unknown> = Promise.resolve();

  constructor(agentDir: string, runId: string) {
    this.eventsPath = path.join(agentDir, EVENTS_FILENAME);
    this.runId = runId;
  }

  /**
   * Phase 9 R1: archive any existing events.jsonl that belongs to a DIFFERENT
   * run before this run starts writing. Moves the file to
   * `.agent/history/events-<previousRunId>.jsonl` and returns the previous
   * run_id (or null if no file / file already belongs to this run).
   *
   * This keeps each run's event stream isolated. Resume paths (same run_id)
   * must NOT call this — they continue appending to the same file.
   *
   * If the existing file is malformed or has mixed run_ids, it is archived
   * under the first run_id found.
   */
  async archivePreviousRun(): Promise<string | null> {
    if (!fs.existsSync(this.eventsPath)) return null;
    let firstRunId: string | null = null;
    try {
      const existing = await this.readAll();
      if (existing.length > 0) {
        firstRunId = existing[0].run_id;
      }
    } catch {
      // malformed file — archive it under a sentinel name
      firstRunId = 'unknown';
    }
    // If the existing stream already belongs to THIS run, do nothing (resume).
    if (firstRunId === this.runId) return null;

    const historyDir = path.join(path.dirname(this.eventsPath), 'history');
    await fs.ensureDir(historyDir);
    const archivePath = path.join(historyDir, `events-${firstRunId ?? 'unknown'}.jsonl`);
    // If an archive for this run_id already exists (rare), append a timestamp
    // suffix to avoid clobbering.
    let finalPath = archivePath;
    if (fs.existsSync(archivePath)) {
      finalPath = path.join(historyDir, `events-${firstRunId ?? 'unknown'}-${Date.now()}.jsonl`);
    }
    await fs.move(this.eventsPath, finalPath);
    return firstRunId;
  }

  /**
   * Append a draft and return the fully-formed event.
   * Assigns seq, event_id, ts. Serialized through an in-process promise chain
   * so concurrent appends (wave mode Promise.all) get monotonic seq values.
   */
  async append(draft: EventDraft): Promise<ReviewLoopEvent> {
    const run = (): Promise<ReviewLoopEvent> => this.doAppend(draft);
    const next = this.appendChain.then(run, run);
    // Keep the chain alive even if the caller drops the returned promise.
    this.appendChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async doAppend(draft: EventDraft): Promise<ReviewLoopEvent> {
    const seq = (await this.getLastSequence()) + 1;
    const event: ReviewLoopEvent = {
      schema_version: EVENT_SCHEMA_VERSION,
      run_id: this.runId,
      seq,
      event_id: randomUUID(),
      ts: new Date().toISOString(),
      ...draft,
    };
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(this.eventsPath, line, 'utf8');
    this.cachedLastSeq = seq;
    return event;
  }

  /**
   * Read all events in order. Malformed lines are skipped silently so a
   * partial trailing line never blocks resume.
   */
  async readAll(): Promise<ReviewLoopEvent[]> {
    if (!fs.existsSync(this.eventsPath)) return [];
    const raw = await fs.readFile(this.eventsPath, 'utf8');
    const events: ReviewLoopEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ReviewLoopEvent;
        if (parsed && typeof parsed.seq === 'number' && parsed.kind) {
          events.push(parsed);
        }
      } catch {
        // ignore malformed/partial line
      }
    }
    return events;
  }

  /** Return events whose seq is strictly greater than `afterSeq`. */
  async readSince(afterSeq: number): Promise<ReviewLoopEvent[]> {
    const all = await this.readAll();
    return all.filter((e) => e.seq > afterSeq);
  }

  /** Return the highest seq seen, or 0 if none. Malformed lines are ignored. */
  async getLastSequence(): Promise<number> {
    if (this.cachedLastSeq !== null) return this.cachedLastSeq;
    if (!fs.existsSync(this.eventsPath)) {
      this.cachedLastSeq = 0;
      return 0;
    }
    let max = 0;
    const raw = await fs.readFile(this.eventsPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ReviewLoopEvent;
        if (typeof parsed.seq === 'number' && parsed.seq > max) {
          max = parsed.seq;
        }
      } catch {
        // ignore
      }
    }
    this.cachedLastSeq = max;
    return max;
  }
}
