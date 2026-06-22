/**
 * Phase 9 R2A — Dashboard event source.
 *
 * Read-only adapter that turns the durable `events.jsonl` stream into a
 * compact snapshot for the dashboard HTTP API. Performs no writes.
 *
 * Phase 9 R3 — getSnapshot accepts an optional { runId } parameter. When
 * runId differs from the active run, the snapshot is built from
 * `.agent/history/events-<runId>.jsonl` using a parse-rules shim that
 * mirrors EventStore.readAll() line semantics.
 */
import path from 'node:path';
import fs from 'fs-extra';
import {
  EventStore,
  EVENTS_FILENAME,
  type ReviewLoopEvent,
  type ArtifactRef,
} from '../runtime/event-store.js';
import { parseJsonlEvents, resolveArchiveByRunId } from './run-lister.js';
import { computeNextAction } from '../runtime/next-action.js';

export const MAX_LATEST_EVENTS = 20;

/**
 * Resolve `run_id` from `<agentDir>/state.json`, falling back to `null` when
 * the file is missing or malformed. Used by both the snapshot path and the
 * SSE stream to keep run-id resolution consistent.
 */
export async function resolveRunIdFromAgentDir(agentDir: string): Promise<string | null> {
  const statePath = path.join(agentDir, 'state.json');
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { run_id?: unknown };
    return typeof parsed.run_id === 'string' ? parsed.run_id : null;
  } catch {
    return null;
  }
}

export interface DashboardSnapshot {
  run_id: string;
  current_phase: string;
  next_action: string;
  latest_events: ReviewLoopEvent[];
  artifacts: ArtifactRef[];
}

export interface EventSourceOptions {
  projectRoot: string;
}

export interface GetSnapshotOptions {
  runId?: string;
}

/**
 * Phases that mark the end of a run. When present, their `phase` value
 * is treated as the run's final phase regardless of later non-terminal
 * events appended during resume.
 *
 * Exported for reuse by RunLister so the dashboard's archive listing
 * derives phase consistently with the active snapshot.
 */
export const TERMINAL_KINDS = new Set<string>([
  'run.completed',
  'run.blocked',
  'run.failed',
]);

export class DashboardEventSource {
  private readonly agentDir: string;
  private readonly historyDir: string;
  private readonly eventsPath: string;

  constructor(opts: EventSourceOptions) {
    this.agentDir = path.join(opts.projectRoot, '.agent');
    this.historyDir = path.join(this.agentDir, 'history');
    this.eventsPath = path.join(this.agentDir, EVENTS_FILENAME);
  }

  /**
   * Read iteration/maxIterations from state.json for the next-action hint.
   * Returns {0,0} when state.json is missing (archived/old runs), which is
   * fine because those runs are terminal and the hint ignores iteration.
   */
  private readIterFromState(): { iteration: number; maxIterations: number } {
    try {
      const statePath = path.join(this.agentDir, 'state.json');
      if (!fs.existsSync(statePath)) return { iteration: 0, maxIterations: 0 };
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return {
        iteration: typeof st.iteration === 'number' ? st.iteration : 0,
        maxIterations: typeof st.max_iterations === 'number' ? st.max_iterations : 0,
      };
    } catch {
      return { iteration: 0, maxIterations: 0 };
    }
  }

  /**
   * Build a snapshot from the event stream. Gracefully degrades when
   * `.agent` or `events.jsonl` is missing.
   *
   * When `opts.runId` is supplied and differs from the active run, the
   * snapshot is built from `.agent/history/events-<runId>.jsonl`. If the
   * archive file is missing, throws an Error carrying
   * code='ARCHIVE_NOT_FOUND' (server route translates to 404).
   */
  async getSnapshot(opts: GetSnapshotOptions = {}): Promise<DashboardSnapshot> {
    const runIdFromState = await this.readRunIdFromState();
    const requestedRunId = opts.runId;

    // Archive path: requested run_id differs from active.
    if (requestedRunId && requestedRunId !== runIdFromState) {
      // Validate runId format before any filesystem access to prevent
      // path traversal. This is the defense-in-depth layer; the HTTP
      // route also validates, but the exported API must be safe on its own.
      if (!/^[0-9]{14}-[a-z0-9]+$/.test(requestedRunId)) {
        const err = new Error(`Invalid run_id format: ${requestedRunId}`) as Error & {
          code?: string;
        };
        err.code = 'INVALID_RUN_ID';
        throw err;
      }

      // Resolve archive by scanning history and matching first-event run_id,
      // not by assuming the filename encodes the run_id.
      const archivePath = await resolveArchiveByRunId(this.historyDir, requestedRunId);
      if (!archivePath) {
        const err = new Error(`Archive not found: ${requestedRunId}`) as Error & {
          code?: string;
        };
        err.code = 'ARCHIVE_NOT_FOUND';
        throw err;
      }
      const events = await parseJsonlEvents(archivePath);
      const archiveRunId = events.length > 0 ? events[0].run_id : requestedRunId;
      return buildSnapshot(archiveRunId, events);
    }

    // Active path: existing behavior, byte-for-byte unchanged when no runId
    // is supplied or runId matches the active run.
    if (!fs.existsSync(this.agentDir) || !fs.existsSync(this.eventsPath)) {
      return {
        run_id: runIdFromState ?? 'unknown',
        current_phase: 'unknown',
        next_action: '',
        latest_events: [],
        artifacts: [],
      };
    }

    const store = new EventStore(this.agentDir, runIdFromState ?? 'unknown');
    const events = await store.readAll();

    if (events.length === 0) {
      return {
        run_id: runIdFromState ?? 'unknown',
        current_phase: 'unknown',
        next_action: '',
        latest_events: [],
        artifacts: [],
      };
    }

    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    const last = sorted[sorted.length - 1];
    const runId = runIdFromState ?? last.run_id ?? 'unknown';

    // Choose the LAST terminal event, not the first: a resumed run's history
    // is append-only and can contain an earlier run.blocked followed by
    // run.resumed and run.completed. Picking the first would report the stale
    // BLOCKED phase instead of the final PASSED.
    const terminal = [...sorted].reverse().find((e) => TERMINAL_KINDS.has(e.kind));
    const currentPhase = terminal ? terminal.phase : last.phase;

    const latest = sorted.slice(-MAX_LATEST_EVENTS);
    const artifacts = dedupeArtifacts(sorted);

    return {
      run_id: runId,
      current_phase: currentPhase,
      next_action: computeNextAction(currentPhase, this.readIterFromState().iteration, this.readIterFromState().maxIterations),
      latest_events: latest,
      artifacts,
    };
  }

  private async readRunIdFromState(): Promise<string | null> {
    return resolveRunIdFromAgentDir(this.agentDir);
  }
}

function buildSnapshot(runId: string, events: ReviewLoopEvent[]): DashboardSnapshot {
  if (events.length === 0) {
    return {
      run_id: runId,
      current_phase: 'unknown',
      next_action: '',
      latest_events: [],
      artifacts: [],
    };
  }
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const last = sorted[sorted.length - 1];
  const terminal = [...sorted].reverse().find((e) => TERMINAL_KINDS.has(e.kind));
  const currentPhase = terminal ? terminal.phase : last.phase;
  const latest = sorted.slice(-MAX_LATEST_EVENTS);
  const artifacts = dedupeArtifacts(sorted);
  return {
    run_id: runId,
    current_phase: currentPhase,
    next_action: computeNextAction(currentPhase, 0, 0),
    latest_events: latest,
    artifacts,
  };
}

function dedupeArtifacts(events: ReviewLoopEvent[]): ArtifactRef[] {
  const seen = new Set<string>();
  const out: ArtifactRef[] = [];
  for (const ev of events) {
    if (!ev.artifact_refs) continue;
    for (const ref of ev.artifact_refs) {
      if (!ref || typeof ref.path !== 'string') continue;
      const key = `${ref.type}:${ref.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry: ArtifactRef = { type: ref.type, path: ref.path };
      if (typeof ref.label === 'string') entry.label = ref.label;
      out.push(entry);
    }
  }
  return out;
}