/**
 * Status Command — show current run status.
 * Phase 4 §9.2: `review-loop status [--json]`
 */

import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { StateStore } from '../orchestrator/state-store.js';
import { LockManager } from '../runtime/lock-manager.js';
import { EventStore, type ReviewLoopEvent } from '../runtime/event-store.js';
import type { RunState, StatusOutput, ReviewLoopError } from '../types.js';
import { Phase as PhaseEnum } from '../types.js';
import { isTerminal } from '../orchestrator/state-machine.js';
import {
  readFeedbackSummary,
  feedbackSummaryHasContent,
} from './status-feedback-summary.js';

function parseWatchInterval(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    throw new Error(`--watch-interval must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

function parseWatchTimeout(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
    throw new Error(`--watch-timeout must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

export function createStatusCommand(): Command {
  const cmd = new Command('status');
  cmd
    .description('Show current run status')
    .option('--json', 'Output status as JSON')
    .option('--watch', 'Continuously poll status until terminal phase')
    .option('--watch-interval <ms>', 'Watch polling interval in ms', parseWatchInterval, 2000)
    .option('--watch-timeout <ms>', 'Max wall-clock ms before watch exits (test-friendly)', parseWatchTimeout, 0)
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action(async (options) => {
      try {
        if (options.watch) {
          await watchStatus(options);
        } else {
          const result = await executeStatus({
            project_root: options.projectRoot,
            json: options.json ?? false,
          });
          if (result !== null) {
            if (options.json) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              printHumanReadable(result);
            }
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * Terminal event kinds that signal the watch loop should exit.
 */
const TERMINAL_EVENT_KINDS = new Set(['run.completed', 'run.blocked', 'run.failed']);

/**
 * Phase 9 R1: watch status by reading the durable event stream.
 *
 * When `.agent/events.jsonl` exists, watch replays existing events then
 * polls for newly appended events. JSON mode emits one JSON event per line;
 * text mode renders a compact live view. The loop exits when it sees a
 * terminal run event or when --watch-timeout (ms) elapses.
 *
 * Falls back to the legacy state-polling watch when no event stream exists,
 * so older runs without events.jsonl remain observable.
 */
async function watchStatus(options: {
  projectRoot: string;
  json?: boolean;
  watchInterval?: number;
  watchTimeout?: number;
}): Promise<void> {
  const projectRoot = resolve(options.projectRoot);
  const agentDir = join(projectRoot, '.agent');
  const eventsPath = join(agentDir, 'events.jsonl');

  if (existsSync(eventsPath)) {
    await watchEventStream({ agentDir, eventsPath, json: options.json ?? false, watchInterval: options.watchInterval ?? 1000, watchTimeout: options.watchTimeout ?? 0 });
    return;
  }

  // Legacy fallback: poll state.json + progress.json.
  await watchStatePoll(options);
}

async function watchEventStream(params: {
  agentDir: string;
  eventsPath: string;
  json: boolean;
  watchInterval: number;
  watchTimeout: number;
}): Promise<void> {
  const { agentDir, json, watchInterval, watchTimeout } = params;
  // Derive run_id from state.json if present, else from the first event.
  let runId = 'unknown';
  const statePath = join(agentDir, 'state.json');
  if (existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8')) as { run_id?: string };
      if (typeof st.run_id === 'string') runId = st.run_id;
    } catch { /* ignore */ }
  }
  const store = new EventStore(agentDir, runId);

  const startMs = Date.now();
  let lastSeq = 0;

  // Replay ALL existing events first. A resumed run's history is append-only,
  // so it can legitimately contain an earlier run.blocked followed by
  // run.resumed and run.completed. Stopping at the first terminal event would
  // truncate the resumed history. Only the LAST replayed event decides whether
  // the run is currently terminal.
  const existing = await store.readAll();
  for (const ev of existing) {
    emitWatchLine(ev, json);
    lastSeq = ev.seq;
  }
  const lastReplayed = existing[existing.length - 1];
  if (lastReplayed && TERMINAL_EVENT_KINDS.has(lastReplayed.kind)) {
    renderTextSummary(existing, json);
    return;
  }

  // Follow newly appended events.
  while (true) {
    if (watchTimeout > 0 && Date.now() - startMs > watchTimeout) {
      renderTextSummary(existing.concat(await store.readSince(lastSeq)), json);
      return;
    }
    const tail = await store.readSince(lastSeq);
    if (tail.length > 0) {
      for (const ev of tail) {
        emitWatchLine(ev, json);
        lastSeq = ev.seq;
        if (TERMINAL_EVENT_KINDS.has(ev.kind)) {
          renderTextSummary(existing.concat(await store.readAll()), json);
          return;
        }
      }
    }
    await new Promise((r) => setTimeout(r, watchInterval));
  }
}

function emitWatchLine(ev: ReviewLoopEvent, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(ev));
  }
  // In text mode, each new event is rendered inline; the full summary is
  // printed once at the end (or on timeout) by renderTextSummary.
}

function renderTextSummary(events: ReviewLoopEvent[], json: boolean): void {
  if (json) return; // JSON mode already emitted each event inline.
  if (events.length === 0) return;
  const last = events[events.length - 1];
  const runId = last.run_id;

  // Derive current phase and active role from the latest relevant events.
  const lastRoleStarted = [...events].reverse().find((e) => e.kind === 'role.started');
  const terminalEv = events.find((e) => TERMINAL_EVENT_KINDS.has(e.kind));
  const phase = terminalEv ? terminalEv.phase : last.phase;

  const recent = events.slice(-6);

  console.log('');
  console.log(`Run: ${runId}  Phase: ${phase}`);
  if (lastRoleStarted?.role) {
    const providerInfo = lastRoleStarted.provider ? `  Provider: ${lastRoleStarted.provider}` : '';
    console.log(`Active: ${lastRoleStarted.role}${providerInfo}`);
  }
  console.log('Latest:');
  for (const ev of recent) {
    const ts = new Date(ev.ts).toLocaleTimeString();
    console.log(`${ts} ${ev.kind} ${ev.message}`);
  }

  // Surface artifact refs from recent events.
  const refs = new Set<string>();
  for (const ev of recent) {
    if (ev.artifact_refs) {
      for (const ref of ev.artifact_refs) refs.add(ref.path);
    }
  }
  if (refs.size > 0) {
    console.log('Artifacts:');
    for (const p of refs) console.log(`  ${p}`);
  }
}

/**
 * Legacy state-polling watch, used when no events.jsonl exists.
 */
async function watchStatePoll(options: { projectRoot: string; json?: boolean; watchInterval?: number; watchTimeout?: number }): Promise<void> {
  const interval = options.watchInterval ?? 2000;
  const deadline = options.watchTimeout && options.watchTimeout > 0 ? Date.now() + options.watchTimeout : 0;
  let lastKey = '';
  while (true) {
    if (deadline > 0 && Date.now() > deadline) return;
    const result = await executeStatus({ project_root: options.projectRoot, json: false });
    if (result) {
      // F-604: Read progress.json for finer-grained last_event_at
      let progressEventAt = '';
      const progressPath = join(resolve(options.projectRoot), '.agent', 'progress.json');
      if (existsSync(progressPath)) {
        try {
          const progress = JSON.parse(readFileSync(progressPath, 'utf8'));
          progressEventAt = progress.last_event_at ?? '';
        } catch { /* ignore */ }
      }
      const key = `${result.phase}:${result.iteration}:${progressEventAt}`;
      if (key !== lastKey) {
        lastKey = key;
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const eventInfo = progressEventAt ? ` (${new Date(progressEventAt).toLocaleTimeString()})` : '';
          console.log(`[${result.phase}] iter=${result.iteration} ${result.next_step}${eventInfo}`);
        }
      }
      if (['PASSED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(result.phase)) {
        return;
      }
    }
    await new Promise(r => setTimeout(r, interval));
  }
}

export async function executeStatus(params: {
  project_root: string;
  json: boolean;
}): Promise<StatusOutput | null> {
  const projectRoot = resolve(params.project_root);
  const agentDir = resolve(projectRoot, '.agent');

  // Check if .agent directory exists
  if (!existsSync(agentDir)) {
    console.error('No .agent directory found. No run in progress.');
    return null;
  }

  // Read state
  const stateStore = new StateStore(agentDir);
  if (!await stateStore.exists()) {
    console.error('No state.json found. No run in progress.');
    return null;
  }

  let state: RunState;
  try {
    state = await stateStore.read();
  } catch (err) {
    console.error(`Failed to read state: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  // Read lock
  const lockManager = new LockManager(agentDir);
  let lockStatus: 'held' | 'stale' | 'none' = 'none';

  try {
    const lock = await lockManager.readLock();
    if (lock) {
      // Check if the process is still alive
      try {
        process.kill(lock.pid, 0);
        lockStatus = 'held';
      } catch {
        lockStatus = 'stale';
      }
    }
  } catch {
    lockStatus = 'none';
  }

  const nextStep = computeNextStep(state.phase, state.iteration, state.max_iterations);

  const lock = await lockManager.readLock().catch(() => null);

  const lastError: ReviewLoopError | null = state.last_error
    ? { code: 'STATE_CONFLICT', message: state.last_error, resumable: false, suggested_action: 'Check configuration and try again' }
    : null;

  // Phase 5: Finalization status fields
  const finalAuditPath = existsSync(join(agentDir, 'final-audit.md'))
    ? '.agent/final-audit.md' : null;
  let finalAuditDecision: string | null = null;
  if (finalAuditPath) {
    try {
      const { parseFinalAudit } = await import('../artifacts/artifact-schemas.js');
      const content = readFileSync(join(agentDir, 'final-audit.md'), 'utf8');
      const { frontMatter } = parseFinalAudit(content);
      finalAuditDecision = frontMatter.decision;
    } catch { /* ignore parse errors */ }
  }

  const output: StatusOutput = {
    run_id: state.run_id,
    phase: state.phase,
    iteration: state.iteration,
    max_iterations: state.max_iterations,
    branch: state.branch,
    base_commit: state.base_commit,
    goal_digest: state.goal_digest,
    audited_diff_digest: state.audited_diff_digest,
    last_error: lastError,
    lock_status: lockStatus,
    lock_info: lock,
    started_at: state.started_at,
    updated_at: state.updated_at,
    next_step: nextStep,
    final_audit_decision: finalAuditDecision,
    final_audit_path: finalAuditPath,
    commit_on_pass: true,
    commit_skipped: state.commit_skipped,
    final_commit_sha: state.final_commit_sha,
    tag_requested: state.tag_name !== null,
    tag_name: state.tag_name,
    tag_created: state.tag_created,
    push_enabled: false,
    finalization_next_step: computeFinalizationNextStep(state),
    feedback_summary: readFeedbackSummary(projectRoot),
  };

  return output;
}

function computeFinalizationNextStep(state: RunState): string | null {
  switch (state.phase) {
    case 'FINALIZING':
      return 'Finalization in progress — waiting for Final Audit and commit.';
    case 'PASSED':
      if (state.commit_skipped) {
        return 'Run completed. Commit was skipped.';
      }
      if (state.final_commit_sha) {
        return `Run completed. Committed as ${state.final_commit_sha.slice(0, 8)}.`;
      }
      return 'Run completed.';
    case 'BLOCKED':
      if (state.final_commit_sha && !state.tag_created && state.tag_name) {
        return 'Code committed but tag failed. Use `review-loop resume` to retry tag.';
      }
      return null;
    default:
      return null;
  }
}

/**
 * Compute the next step suggestion based on current phase.
 */
function computeNextStep(phase: string, iteration: number, maxIterations: number): string {
  if (isTerminal(phase as PhaseEnum)) {
    const p = phase as PhaseEnum;
    switch (p) {
      case PhaseEnum.PASSED:
        return 'Run completed successfully. Final Audit passed and code committed.';
      case PhaseEnum.FAILED:
        return `Run failed after ${iteration} iteration(s). Review errors and adjust configuration.`;
      case PhaseEnum.BLOCKED:
        return 'Run is blocked. Resolve the blocking issue and use `review-loop resume`.';
      case PhaseEnum.CANCELLED:
        return 'Run was cancelled.';
      default:
        return 'Run is in a terminal state.';
    }
  }

  switch (phase) {
    case 'INITIALIZING':
      return 'Run is initializing. Use `review-loop start` to begin.';
    case 'PLANNING':
      return 'Planner is running. Wait for it to complete.';
    case 'DEVELOPING':
      return `Developer is running (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'REWORKING':
      return `Rework is in progress (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'VERIFYING':
      return `Verification is running (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'AUDITING':
      return `Auditor is running (iteration ${iteration}/${maxIterations}). Wait for it to complete.`;
    case 'FINALIZING':
      return '正在等待或执行最终审计/本地提交';
    default:
      return 'Unknown phase.';
  }
}

/**
 * Print human-readable status output.
 */
export function printHumanReadable(status: StatusOutput): void {
  console.log(`Run: ${status.run_id}`);
  console.log(`Phase: ${status.phase}`);
  console.log(`Iteration: ${status.iteration}/${status.max_iterations}`);
  console.log(`Branch: ${status.branch}`);
  console.log(`Base commit: ${status.base_commit}`);
  console.log(`Started: ${status.started_at}`);
  console.log(`Updated: ${status.updated_at}`);

  if (status.goal_digest) {
    console.log(`GOAL digest: ${status.goal_digest}`);
  }
  if (status.audited_diff_digest) {
    console.log(`Diff digest: ${status.audited_diff_digest}`);
  }

  console.log(`Lock: ${status.lock_status}`);
  if (status.lock_info) {
    console.log(`  PID: ${status.lock_info.pid}`);
    console.log(`  Acquired: ${status.lock_info.created_at}`);
  }

  if (status.last_error) {
    console.log(`Last error: ${status.last_error.message}`);
  }

  console.log(`Next step: ${status.next_step}`);

  if (status.final_commit_sha) {
    console.log(`Commit: ${status.final_commit_sha}`);
  }
  if (status.commit_skipped) {
    console.log(`Commit: skipped`);
  }
  if (status.tag_name) {
    console.log(`Tag: ${status.tag_name} (${status.tag_created ? 'created' : 'not created'})`);
  }
  if (status.final_audit_decision) {
    console.log(`Final Audit: ${status.final_audit_decision}`);
  }

  printFeedbackSummarySection(status);
}

/**
 * Print the Phase 10 feedback byproduct summary, if any signal is present.
 * Silent when no byproduct file exists and no counts are recorded.
 */
function printFeedbackSummarySection(status: StatusOutput): void {
  const fs = status.feedback_summary;
  if (!feedbackSummaryHasContent(fs)) return;

  console.log('Phase 10 feedback:');
  console.log(`  Blocks: ${fs.blocks_total} (parse warnings: ${fs.parse_warnings})`);

  const typeParts: string[] = [];
  for (const t of ['clarify', 'risk_note', 'followup_task', 'scope_concern', 'verification_suggestion'] as const) {
    if (fs.by_type[t] > 0) typeParts.push(`${t}=${fs.by_type[t]}`);
  }
  if (typeParts.length > 0) {
    console.log(`  By type: ${typeParts.join(', ')}`);
  }

  const roleParts: string[] = [];
  for (const r of ['planner', 'developer', 'auditor', 'final_auditor'] as const) {
    if (fs.by_role[r] > 0) roleParts.push(`${r}=${fs.by_role[r]}`);
  }
  if (roleParts.length > 0 || fs.unknown_role_blocks > 0) {
    const unknown = fs.unknown_role_blocks > 0 ? `unknown=${fs.unknown_role_blocks}` : '';
    const all = unknown ? [...roleParts, unknown] : roleParts;
    if (all.length > 0) {
      console.log(`  By role: ${all.join(', ')}`);
    }
  }

  if (fs.present_files.length > 0) {
    console.log(`  Files: ${fs.present_files.join(', ')}`);
  }
}
