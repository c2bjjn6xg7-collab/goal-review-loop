/**
 * Event Bus — thin wrapper over EventStore that normalizes caller events,
 * persists them, and notifies in-process subscribers.
 *
 * Phase 9 R1. Observability only. Fail-soft: a persistence failure warns
 * but never changes orchestration state. `.agent/state.json` remains the
 * source of truth for resume.
 *
 * Callers pass an EventDraft; the bus/store fill run_id, seq, event_id, ts.
 */
import { EventStore, type EventDraft, type ReviewLoopEvent } from './event-store.js';

export type EventListener = (event: ReviewLoopEvent) => void;

export interface IEventBus {
  emit(draft: EventDraft): Promise<ReviewLoopEvent | undefined>;
  subscribe(listener: EventListener): () => void;
  /** Phase 9 R1: archive a previous run's events.jsonl. Optional — null bus no-ops. */
  archivePreviousRun?(): Promise<string | null>;
}

export class EventBus implements IEventBus {
  private readonly store: EventStore;
  private readonly runId: string;
  private readonly listeners = new Set<EventListener>();

  constructor(agentDir: string, runId: string) {
    this.store = new EventStore(agentDir, runId);
    this.runId = runId;
  }

  /**
   * Phase 9 R1: delegate to the underlying store's archivePreviousRun.
   * Called by the orchestrator at fresh-run start to isolate event streams
   * across runs. Returns the archived previous run_id, or null if nothing
   * was archived.
   */
  async archivePreviousRun(): Promise<string | null> {
    return this.store.archivePreviousRun();
  }

  /**
   * Emit an event. Persists through the store and notifies subscribers.
   * Returns undefined if persistence failed (fail-soft); in that case
   * subscribers are still notified so an in-process watch can render the
   * transient event.
   */
  async emit(draft: EventDraft): Promise<ReviewLoopEvent | undefined> {
    let event: ReviewLoopEvent | undefined;
    try {
      event = await this.store.append(draft);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[event-bus] failed to persist event (${draft.kind}): ${msg}`);
      // Synthesize a transient event so in-process subscribers still see it.
      // It is not persisted and has no guaranteed seq/event_id stability.
      event = {
        schema_version: 1,
        run_id: this.runId,
        seq: -1,
        event_id: `transient-${Date.now()}`,
        ts: new Date().toISOString(),
        ...draft,
      };
    }
    if (event) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (listenerErr) {
          const msg = listenerErr instanceof Error ? listenerErr.message : String(listenerErr);
          console.warn(`[event-bus] subscriber threw: ${msg}`);
        }
      }
    }
    return event;
  }

  /** Subscribe to appended events. Returns a disposer. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Null implementation for tests / contexts where observability is disabled
   * (e.g. unit tests of modules that take an IEventBus dependency). All calls
   * are no-ops and never throw.
   */
  static createNull(): IEventBus {
    const noop = async () => undefined;
    const noopDispose = () => {};
    return {
      emit: noop,
      subscribe: () => noopDispose,
    };
  }
}
