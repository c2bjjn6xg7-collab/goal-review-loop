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

  constructor(agentDir: string, runId: string) {
    this.eventsPath = path.join(agentDir, EVENTS_FILENAME);
    this.runId = runId;
  }

  /**
   * Append a draft and return the fully-formed event.
   * Assigns seq, event_id, ts. The append is a single `appendFile` call,
   * which is atomic-enough for one orchestrator writer per run (the run lock
   * already serializes writers).
   */
  async append(draft: EventDraft): Promise<ReviewLoopEvent> {
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
