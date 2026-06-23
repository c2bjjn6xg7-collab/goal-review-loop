/**
 * Phase 9 R3 — Historical Run Lister.
 *
 * Scans `.agent/history/events-*.jsonl` for archived runs and
 * `.agent/events.jsonl` for the active run, returning a sorted listing.
 *
 * Archives are read through an internal parse-rules shim (readArchiveEvents)
 * that mirrors EventStore.readAll() line semantics. EventStore.readAll()
 * cannot be reused directly because its eventsPath is hard-coded to the
 * EVENTS_FILENAME constant (events.jsonl) and src/runtime/event-store.ts is
 * in the disallowed_changes list — so a filename-parameterized shim lives here.
 */
import path from 'node:path';
import fs from 'fs-extra';
import { EventStore, type ReviewLoopEvent } from '../runtime/event-store.js';
import { TERMINAL_KINDS } from './event-source.js';

export interface RunSummary {
  run_id: string;
  phase: string;
  started_at: string;
  event_count: number;
  is_active: boolean;
  source: 'history' | 'active';
  friendly_time: string;
  display_title?: string;
}

export interface RunListing {
  runs: RunSummary[];
  active_run_id: string | null;
}

export interface RunListerOptions {
  projectRoot: string;
}

/**
 * Parse-rules shim that mirrors EventStore.readAll() line semantics.
 * Accepts a JSONL path and returns parsed events. Skips blank lines,
 * tolerates malformed JSON, and requires at least a numeric `seq` and
 * a string `kind` per entry.
 *
 * Exported for reuse by event-source.ts so archive parsing is consistent
 * across the run lister and snapshot builder.
 */
export async function parseJsonlEvents(filePath: string): Promise<ReviewLoopEvent[]> {
  if (!fs.existsSync(filePath)) return [];
  const raw = await fs.readFile(filePath, 'utf8');
  const events: ReviewLoopEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ReviewLoopEvent;
      if (parsed && typeof parsed.seq === 'number' && typeof parsed.kind === 'string') {
        events.push(parsed);
      }
    } catch {
      // ignore malformed/partial line
    }
  }
  return events;
}

/**
 * Resolve an archive file path by scanning the history directory and
 * matching the requested run_id against each file's first event.
 * Returns null if no matching archive is found.
 *
 * This avoids the filename-is-run_id assumption: archive files are named
 * `events-<runId>.jsonl` but the embedded run_id may differ from the
 * filename when cross-run contamination occurred before per-run isolation
 * was added.
 */
export async function resolveArchiveByRunId(
  historyDir: string,
  targetRunId: string,
): Promise<string | null> {
  if (!fs.existsSync(historyDir)) return null;
  const files = await fs.readdir(historyDir);
  for (const file of files) {
    if (!file.startsWith('events-') || !file.endsWith('.jsonl')) continue;
    const filePath = path.join(historyDir, file);
    try {
      const events = await parseJsonlEvents(filePath);
      if (events.length > 0 && events[0].run_id === targetRunId) {
        return filePath;
      }
    } catch {
      // skip unreadable archives
    }
  }
  return null;
}

export function deriveDisplayTitle(events: ReviewLoopEvent[], runId: string): string {
  if (events.length === 0) return runId;

  // 1. Prefer first run.started event message (strip 'Run started:' prefix)
  const startedEvent = events.find((e) => e.kind === 'run.started');
  if (startedEvent && startedEvent.message) {
    const stripped = startedEvent.message.replace(/^Run started:\s*/i, '').trim();
    if (stripped) {
      return normalizeTitle(stripped);
    }
  }

  // 2. Fallback to payload.goal or payload.task
  for (const event of events) {
    if (event.payload) {
      const goal = event.payload.goal;
      const task = event.payload.task;
      if (typeof goal === 'string' && goal.trim()) {
        return normalizeTitle(goal);
      }
      if (typeof task === 'string' && task.trim()) {
        return normalizeTitle(task);
      }
    }
  }

  // 3. Fallback to first non-empty message
  const firstMessage = events.find((e) => e.message && e.message.trim());
  if (firstMessage) {
    return normalizeTitle(firstMessage.message);
  }

  // 4. Final fallback to run_id
  return runId;
}

function normalizeTitle(raw: string): string {
  let title = raw.trim();
  // Collapse multiple spaces
  title = title.replace(/\s+/g, ' ');
  // Strip leading markdown headings (e.g. "# Title", "## Title")
  title = title.replace(/^(#{1,6})\s+/, '');
  // Cap at ~48 display characters
  if (title.length > 48) {
    title = title.slice(0, 47) + '…';
  }
  return title;
}

function buildFriendlyTime(isoTs: string): string {
  const d = new Date(isoTs);
  const month = d.getMonth() + 1; // 1-12, no leading zero
  const day = d.getDate();        // 1-31, no leading zero
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}`;
}

export class RunLister {
  private readonly agentDir: string;
  private readonly historyDir: string;
  private readonly eventsPath: string;
  private lastCache: RunListing | null = null;
  private lastCacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(opts: RunListerOptions) {
    this.agentDir = path.join(opts.projectRoot, '.agent');
    this.historyDir = path.join(this.agentDir, 'history');
    this.eventsPath = path.join(this.agentDir, 'events.jsonl');
  }

  async list(): Promise<RunListing> {
    const now = Date.now();
    if (this.lastCache && now - this.lastCacheTime < this.CACHE_TTL_MS) {
      return this.lastCache;
    }

    const runs: RunSummary[] = [];

    // Enumerate archive files
    if (fs.existsSync(this.historyDir)) {
      const files = await fs.readdir(this.historyDir);
      for (const file of files) {
        if (!file.startsWith('events-') || !file.endsWith('.jsonl')) continue;
        const filePath = path.join(this.historyDir, file);
        try {
          const events = await parseJsonlEvents(filePath);
          if (events.length === 0) {
            const raw = await fs.readFile(filePath, 'utf8');
            const hasNonBlank = raw.split('\n').some((l: string) => l.trim().length > 0);
            if (hasNonBlank) {
              console.warn(`RunLister: skipping archive ${file} — all lines malformed`);
            }
            continue;
          }
          const runId = events[0].run_id;
          const startedAt = events[0].ts;
          const eventCount = events.length;
          const lastTerminal = [...events].reverse().find((e) => TERMINAL_KINDS.has(e.kind));
          const phase = lastTerminal ? lastTerminal.phase : events[events.length - 1].phase;
          runs.push({
            run_id: runId,
            phase,
            started_at: startedAt,
            event_count: eventCount,
            is_active: false,
            source: 'history',
            friendly_time: buildFriendlyTime(startedAt),
            display_title: deriveDisplayTitle(events, runId),
          });
        } catch (err) {
          console.warn(`RunLister: skipping malformed archive ${file}`, err);
        }
      }
    }

    // Sort archive entries ascending by started_at
    runs.sort((a, b) => a.started_at.localeCompare(b.started_at));

    // Read active run via EventStore (not the archive shim) so the active
    // path uses the same code as the rest of the dashboard. We still need a
    // run_id to construct EventStore; we read it from the file's first event
    // by quickly inspecting via the shim, then hand off to EventStore.readAll().
    let activeRunId: string | null = null;
    if (fs.existsSync(this.eventsPath)) {
      try {
        const probe = await parseJsonlEvents(this.eventsPath);
        if (probe.length > 0) {
          activeRunId = probe[0].run_id;
          const store = new EventStore(this.agentDir, activeRunId);
          const activeEvents = await store.readAll();
          if (activeEvents.length > 0) {
            const startedAt = activeEvents[0].ts;
            const lastTerminal = [...activeEvents].reverse().find((e) => TERMINAL_KINDS.has(e.kind));
            const phase = lastTerminal ? lastTerminal.phase : activeEvents[activeEvents.length - 1].phase;
            runs.push({
              run_id: activeRunId,
              phase,
              started_at: startedAt,
              event_count: activeEvents.length,
              is_active: true,
              source: 'active',
              friendly_time: buildFriendlyTime(startedAt),
              display_title: deriveDisplayTitle(activeEvents, activeRunId),
            });
          }
        }
      } catch (err) {
        console.warn('RunLister: skipping malformed active events.jsonl', err);
      }
    }

    const listing: RunListing = { runs, active_run_id: activeRunId };
    this.lastCache = listing;
    this.lastCacheTime = now;
    return listing;
  }

  /** Invalidate the cache (for testing). */
  clearCache(): void {
    this.lastCache = null;
    this.lastCacheTime = 0;
  }
}