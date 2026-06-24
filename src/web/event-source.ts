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
  ui_summary?: DashboardUiSummary;
}

export interface DashboardUiSummary {
  display_title: string;
  started_at?: string;
  updated_at?: string;
  elapsed_ms?: number;
  active_role?: string;
  active_provider?: string;
  active_model?: string;
  active_stage: 'initializing' | 'planning' | 'developing' | 'verifying' | 'auditing' | 'final_auditing' | 'complete' | 'blocked' | 'failed' | 'cancelled' | 'unknown';
  iteration?: number;
  max_iterations?: number;
  last_event_kind?: string;
  roles: DashboardAgentStatus[];
}

export interface DashboardAgentStatus {
  role: 'planner' | 'developer' | 'auditor' | 'final-auditor';
  status: 'waiting' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  provider?: string;
  model?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
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
    const iter = this.readIterFromState();
    const uiSummary = buildUiSummary(runId, sorted, iter);

    return {
      run_id: runId,
      current_phase: currentPhase,
      next_action: computeNextAction(currentPhase, iter.iteration, iter.maxIterations),
      latest_events: latest,
      artifacts,
      ui_summary: uiSummary,
    };
  }

  private async readRunIdFromState(): Promise<string | null> {
    return resolveRunIdFromAgentDir(this.agentDir);
  }
}

function buildSnapshot(
  runId: string,
  events: ReviewLoopEvent[],
  iter: { iteration: number; maxIterations: number } = { iteration: 0, maxIterations: 0 },
): DashboardSnapshot {
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
  const uiSummary = buildUiSummary(runId, sorted, iter);
  return {
    run_id: runId,
    current_phase: currentPhase,
    next_action: computeNextAction(currentPhase, iter.iteration, iter.maxIterations),
    latest_events: latest,
    artifacts,
    ui_summary: uiSummary,
  };
}

function deriveActiveStage(events: ReviewLoopEvent[]): DashboardUiSummary['active_stage'] {
  const last = events[events.length - 1];
  const terminal = [...events].reverse().find((e) => TERMINAL_KINDS.has(e.kind));
  if (terminal) {
    if (terminal.kind === 'run.completed') return 'complete';
    if (terminal.kind === 'run.failed') return 'failed';
    if (terminal.kind === 'run.blocked') return 'blocked';
  }
  if (last.phase === 'CANCELLED') return 'cancelled';

  let blockingIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (
      e.kind === 'task.blocked' ||
      e.kind === 'integration.blocked' ||
      e.kind === 'provider.failure' ||
      e.kind === 'role.error' ||
      e.level === 'error'
    ) {
      blockingIndex = i;
      break;
    }
  }
  if (blockingIndex !== -1) {
    const recovered = events.slice(blockingIndex + 1).some((e) =>
      e.kind === 'run.resumed' ||
      e.kind === 'rework.requested' ||
      e.kind === 'role.started' ||
      e.kind === 'task.started' ||
      e.kind === 'verification.started'
    );
    if (!recovered) return 'blocked';
  }

  const phaseMap: Record<string, DashboardUiSummary['active_stage']> = {
    INITIALIZING: 'initializing', PLANNING: 'planning', DEVELOPING: 'developing',
    REWORKING: 'developing', VERIFYING: 'verifying', AUDITING: 'auditing',
    FINALIZING: 'final_auditing', PASSED: 'complete', FAILED: 'failed',
    BLOCKED: 'blocked', CANCELLED: 'cancelled',
  };
  return phaseMap[last.phase] ?? 'unknown';
}

function deriveAgentStatuses(events: ReviewLoopEvent[]): DashboardAgentStatus[] {
  const roles: DashboardAgentStatus['role'][] = ['planner', 'developer', 'auditor', 'final-auditor'];
  const result: Record<string, DashboardAgentStatus> = {};
  for (const r of roles) {
    result[r] = { role: r, status: 'waiting' };
  }
  for (const e of events) {
    if (e.kind === 'role.started' && e.role && result[e.role as DashboardAgentStatus['role']]) {
      const a = result[e.role as DashboardAgentStatus['role']];
      a.status = 'running'; a.started_at = e.ts;
      a.provider = e.provider; a.model = e.model;
    } else if (e.kind === 'task.started') {
      const a = result.developer;
      a.status = 'running';
      a.started_at = a.started_at ?? e.ts;
      a.provider = e.provider ?? a.provider;
      a.model = e.model ?? a.model;
    } else if (e.kind === 'role.heartbeat' && e.role && result[e.role as DashboardAgentStatus['role']]) {
      const a = result[e.role as DashboardAgentStatus['role']];
      if (a.status === 'waiting') {
        a.status = 'running';
      }
      const elapsed = typeof e.payload?.elapsed_ms === 'number' ? e.payload.elapsed_ms : undefined;
      if (!a.started_at && elapsed !== undefined) {
        a.started_at = new Date(new Date(e.ts).getTime() - elapsed).toISOString();
      }
      if (elapsed !== undefined) {
        a.duration_ms = elapsed;
      }
      a.provider = e.provider ?? a.provider;
      a.model = e.model ?? a.model;
    } else if (e.kind === 'role.exited' && e.role && result[e.role as DashboardAgentStatus['role']]) {
      const a = result[e.role as DashboardAgentStatus['role']];
      a.ended_at = e.ts;
      a.status = (e.status === 'success' || e.level !== 'error') ? 'completed' : 'failed';
      if (a.started_at && a.ended_at) a.duration_ms = new Date(a.ended_at).getTime() - new Date(a.started_at).getTime();
      a.provider = e.provider ?? a.provider;
      a.model = e.model ?? a.model;
    } else if (e.kind === 'role.error' && e.role && result[e.role as DashboardAgentStatus['role']]) {
      result[e.role as DashboardAgentStatus['role']].status = 'failed';
    } else if (e.kind === 'provider.failure' && e.role && result[e.role as DashboardAgentStatus['role']]) {
      result[e.role as DashboardAgentStatus['role']].status = 'failed';
    } else if (e.kind === 'task.completed') {
      const a = result.developer;
      if (a.status !== 'failed' && a.status !== 'blocked') {
        a.status = 'completed';
        a.ended_at = e.ts;
        if (a.started_at) a.duration_ms = new Date(e.ts).getTime() - new Date(a.started_at).getTime();
      }
    } else if (e.kind === 'task.blocked') {
      const a = result.developer;
      a.status = 'failed';
      a.ended_at = e.ts;
      if (a.started_at) a.duration_ms = new Date(e.ts).getTime() - new Date(a.started_at).getTime();
    }
  }
  // Terminal events override running roles
  const last = events[events.length - 1];
  if (last.phase === 'CANCELLED' || last.phase === 'BLOCKED') {
    for (const r of roles) {
      if (result[r].status === 'running') result[r].status = last.phase === 'CANCELLED' ? 'cancelled' : 'blocked';
    }
  }
  return roles.map((r) => result[r]);
}

function deriveDisplayTitle(events: ReviewLoopEvent[], fallbackRunId: string): string {
  const started = events.find((e) => e.kind === 'run.started');
  if (started?.message) {
    let title = started.message.replace(/^Run started:\s*/i, '').trim();
    title = title.replace(/^#+\s*/, '').replace(/\s+/g, ' ');
    return title.length > 48 ? title.slice(0, 48) + '…' : title || fallbackRunId;
  }
  return fallbackRunId;
}

function buildUiSummary(
  runId: string,
  events: ReviewLoopEvent[],
  iter: { iteration: number; maxIterations: number } = { iteration: 0, maxIterations: 0 },
): DashboardUiSummary {
  const activeStage = deriveActiveStage(events);
  const roles = deriveAgentStatuses(events);
  let activeAgent = roles.find((r) => r.status === 'running');
  if (!activeAgent && (activeStage === 'blocked' || activeStage === 'failed')) {
    activeAgent = roles.find((r) => r.status === 'failed' || r.status === 'blocked');
  }
  if (!activeAgent) {
    const fallbackRoleByStage: Partial<Record<DashboardUiSummary['active_stage'], DashboardAgentStatus['role']>> = {
      planning: 'planner',
      developing: 'developer',
      auditing: 'auditor',
      final_auditing: 'final-auditor',
    };
    const fallbackRole = fallbackRoleByStage[activeStage];
    if (fallbackRole) {
      activeAgent = roles.find((r) => r.role === fallbackRole);
    }
  }
  const started = events.find((e) => e.kind === 'run.started' || e.kind === 'run.resumed');
  const last = events[events.length - 1];
  return {
    display_title: deriveDisplayTitle(events, runId),
    started_at: started?.ts,
    updated_at: last?.ts,
    elapsed_ms: (started?.ts && last?.ts) ? new Date(last.ts).getTime() - new Date(started.ts).getTime() : undefined,
    active_role: activeAgent?.role,
    active_provider: activeAgent?.provider,
    active_model: activeAgent?.model,
    active_stage: activeStage,
    iteration: iter.iteration,
    max_iterations: iter.maxIterations,
    last_event_kind: last?.kind,
    roles,
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
