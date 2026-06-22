/**
 * Phase 9 R2A — Dashboard event source.
 *
 * Read-only adapter that turns the durable `events.jsonl` stream into a
 * compact snapshot for the dashboard HTTP API. Performs no writes.
 */
import path from 'node:path';
import fs from 'fs-extra';
import {
  EventStore,
  EVENTS_FILENAME,
  type ReviewLoopEvent,
  type ArtifactRef,
} from '../runtime/event-store.js';

export const MAX_LATEST_EVENTS = 20;

export interface DashboardSnapshot {
  run_id: string;
  current_phase: string;
  latest_events: ReviewLoopEvent[];
  artifacts: ArtifactRef[];
}

export interface EventSourceOptions {
  projectRoot: string;
}

/**
 * Phases that mark the end of a run. When present, their `phase` value
 * is treated as the run's final phase regardless of later non-terminal
 * events appended during resume.
 */
const TERMINAL_KINDS = new Set([
  'run.completed',
  'run.blocked',
  'run.failed',
]);

export class DashboardEventSource {
  private readonly agentDir: string;
  private readonly statePath: string;
  private readonly eventsPath: string;

  constructor(opts: EventSourceOptions) {
    this.agentDir = path.join(opts.projectRoot, '.agent');
    this.statePath = path.join(this.agentDir, 'state.json');
    this.eventsPath = path.join(this.agentDir, EVENTS_FILENAME);
  }

  /**
   * Build a snapshot from the event stream. Gracefully degrades when
   * `.agent` or `events.jsonl` is missing.
   */
  async getSnapshot(): Promise<DashboardSnapshot> {
    const runIdFromState = await this.readRunIdFromState();

    if (!fs.existsSync(this.agentDir) || !fs.existsSync(this.eventsPath)) {
      return {
        run_id: runIdFromState ?? 'unknown',
        current_phase: 'unknown',
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
      latest_events: latest,
      artifacts,
    };
  }

  private async readRunIdFromState(): Promise<string | null> {
    if (!fs.existsSync(this.statePath)) return null;
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as { run_id?: unknown };
      return typeof parsed.run_id === 'string' ? parsed.run_id : null;
    } catch {
      return null;
    }
  }
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
