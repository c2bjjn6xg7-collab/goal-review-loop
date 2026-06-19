/**
 * State Store — atomic read/write of state.json with schema validation.
 * Design doc §7
 *
 * INVARIANT: Phase transitions are ALWAYS enforced.
 * - create() is the ONLY way to write initial state.
 * - transition() is the ONLY way to change phase.
 * - update() allows non-phase field changes but rejects phase changes.
 * - write() is private — no external caller can bypass guards.
 */
import fs from 'fs-extra';
import path from 'path';
import { Ajv } from 'ajv';
import { atomicWriteJSON } from '../runtime/atomic-file.js';
import {
  type RunState,
  type Phase,
  Phase as PhaseEnum,
  StageStatus,
  type StageInfo,
} from '../types.js';
import { validateTransition, isTerminal } from './state-machine.js';

/**
 * Map a Phase to its corresponding stage key in state.stages.
 * Returns undefined for phases that don't have a stage entry.
 */
function phaseToStageKey(phase: Phase): string | undefined {
  switch (phase) {
    case PhaseEnum.PLANNING: return 'planning';
    case PhaseEnum.DEVELOPING: return 'developing';
    case PhaseEnum.REWORKING: return 'developing'; // rework is part of the developing stage
    case PhaseEnum.VERIFYING: return 'verifying';
    case PhaseEnum.AUDITING: return 'auditing';
    case PhaseEnum.FINALIZING: return 'finalizing';
    default: return undefined;
  }
}

// JSON Schema for state.json
const STATE_SCHEMA = {
  type: 'object',
  required: [
    'schema_version', 'run_id', 'task_slug', 'phase', 'iteration',
    'max_iterations', 'consecutive_failure_count', 'project_root', 'base_commit', 'branch',
    'goal_digest', 'audited_diff_digest', 'started_at', 'updated_at',
    'last_error', 'cancel_requested_at', 'final_commit_sha', 'final_commit_message', 'finalized_at', 'commit_skipped', 'skip_reason', 'tag_name', 'tag_created', 'stages', 'task_graph_state',
  ],
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    task_slug: { type: 'string', minLength: 1 },
    phase: {
      type: 'string',
      enum: Object.values(PhaseEnum),
    },
    iteration: { type: 'number', minimum: 0 },
    max_iterations: { type: 'number', minimum: 1 },
    consecutive_failure_count: { type: 'integer', minimum: 0 },
    project_root: { type: 'string', minLength: 1 },
    base_commit: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
    goal_digest: { type: ['string', 'null'] },
    audited_diff_digest: { type: ['string', 'null'] },
    started_at: { type: 'string' },
    updated_at: { type: 'string' },
    last_error: { type: ['string', 'null'] },
    cancel_requested_at: { type: ['string', 'null'] },
    final_commit_sha: { type: ['string', 'null'] },
    final_commit_message: { type: ['string', 'null'] },
    finalized_at: { type: ['string', 'null'] },
    commit_skipped: { type: 'boolean' },
    skip_reason: { type: ['string', 'null'] },
    tag_name: { type: ['string', 'null'] },
    tag_created: { type: 'boolean' },
    stages: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['status', 'attempts'],
        properties: {
          status: { type: 'string', enum: Object.values(StageStatus) },
          attempts: { type: 'number', minimum: 0 },
          at: { type: 'string' },
        },
      },
    },
    task_graph_state: {
      type: ['object', 'null'],
      properties: {
        current_task_index: { type: 'number', minimum: 0 },
        task_statuses: {
          type: 'object',
          additionalProperties: { type: 'string', enum: ['pending', 'running', 'passed', 'failed', 'skipped', 'blocked'] },
        },
        task_attempts: {
          type: 'object',
          additionalProperties: { type: 'number', minimum: 0 },
        },
      },
      required: ['current_task_index', 'task_statuses', 'task_attempts'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateState = ajv.compile(STATE_SCHEMA);

export class StateStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StateStoreError';
  }
}

/**
 * State Store — manages state.json with atomic writes and schema validation.
 * Phase transitions are ALWAYS enforced through transition().
 */
export class StateStore {
  private readonly filePath: string;

  constructor(agentDir: string) {
    this.filePath = path.join(agentDir, 'state.json');
  }

  /**
   * Check if state.json exists.
   */
  async exists(): Promise<boolean> {
    return fs.pathExists(this.filePath);
  }

  /**
   * Read and validate state.json.
   */
  async read(): Promise<RunState> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!validateState(data)) {
        const errors = validateState.errors?.map((e: {instancePath: string; message?: string}) => `${e.instancePath}: ${e.message}`).join('; ');
        throw new StateStoreError(`Invalid state.json schema: ${errors}`);
      }
      return data as RunState;
    } catch (err) {
      if (err instanceof StateStoreError) throw err;
      throw new StateStoreError(`Failed to read state.json: ${err}`, err);
    }
  }

  /**
   * Create initial state for a new run and persist it.
   * This is the ONLY way to write the initial state.
   * Cannot be called if state already exists.
   */
  async create(params: {
    run_id: string;
    task_slug: string;
    project_root: string;
    base_commit: string;
    branch: string;
    max_iterations: number;
  }): Promise<RunState> {
    if (await this.exists()) {
      throw new StateStoreError('Cannot create initial state: state.json already exists');
    }

    const state = this.buildInitialState(params);
    await this.writeInternal(state);
    return state;
  }

  /**
   * Transition to a new phase with validation.
   * This is the ONLY way to change the phase field.
   * F-310 fix: also updates the corresponding stage status.
   */
  async transition(newPhase: Phase): Promise<RunState> {
    const current = await this.read();
    validateTransition(current.phase, newPhase);

    const now = new Date().toISOString();

    // F-310: Update stage status for the new phase
    const stageKey = phaseToStageKey(newPhase);
    const updatedStages = { ...current.stages };
    if (stageKey && updatedStages[stageKey]) {
      const prev = updatedStages[stageKey];
      updatedStages[stageKey] = {
        ...prev,
        status: isTerminal(newPhase) ? StageStatus.COMPLETED : StageStatus.RUNNING,
        attempts: prev.attempts + 1,
        at: now,
      };
    }

    // F-310R1 fix: Mark the previous phase's stage based on the transition target.
    // Normal forward progress → COMPLETED; abnormal/blocked → FAILED.
    const prevStageKey = phaseToStageKey(current.phase);
    if (prevStageKey && prevStageKey !== stageKey && updatedStages[prevStageKey]) {
      const prev = updatedStages[prevStageKey];
      if (prev.status === StageStatus.RUNNING) {
        const abnormalTargets: ReadonlySet<Phase> = new Set([
          PhaseEnum.BLOCKED, PhaseEnum.REWORKING, PhaseEnum.FAILED, PhaseEnum.CANCELLED,
        ]);
        updatedStages[prevStageKey] = {
          ...prev,
          status: abnormalTargets.has(newPhase) ? StageStatus.FAILED : StageStatus.COMPLETED,
          at: now,
        };
      }
    }

    const newState: RunState = {
      ...current,
      phase: newPhase,
      updated_at: now,
      stages: updatedStages,
    };

    await this.writeInternal(newState);
    return newState;
  }

  /**
   * Force a phase transition without enforcing the legal-transition table.
   *
   * Phase 8B: used ONLY to resume a task-graph run that BLOCKED on a task.
   * A BLOCKED phase has no outgoing legal transitions, but the task graph
   * must be able to restart from the failed task. This method performs the
   * same stage bookkeeping as transition() but skips validateTransition().
   */
  async forceTransitionForResume(newPhase: Phase): Promise<RunState> {
    const current = await this.read();
    const now = new Date().toISOString();

    const stageKey = phaseToStageKey(newPhase);
    const updatedStages = { ...current.stages };
    if (stageKey && updatedStages[stageKey]) {
      const prev = updatedStages[stageKey];
      updatedStages[stageKey] = {
        ...prev,
        status: isTerminal(newPhase) ? StageStatus.COMPLETED : StageStatus.RUNNING,
        attempts: prev.attempts + 1,
        at: now,
      };
    }

    const newState: RunState = {
      ...current,
      phase: newPhase,
      updated_at: now,
      stages: updatedStages,
    };

    await this.writeInternal(newState);
    return newState;
  }

  /**
   * Update non-phase fields on the current state.
   * Rejects if the caller tries to change the phase field.
   */
  async update(updater: (state: Readonly<RunState>) => Partial<Omit<RunState, 'phase'>>): Promise<RunState> {
    const current = await this.read();
    const updates = updater(current);

    // Guard: phase must not change through update()
    if ('phase' in updates && updates.phase !== current.phase) {
      throw new StateStoreError(
        `Cannot change phase through update(). Use transition() instead. Current: ${current.phase}, attempted: ${(updates as Record<string, unknown>).phase}`,
      );
    }

    const newState: RunState = {
      ...current,
      ...updates,
      updated_at: new Date().toISOString(),
    };

    await this.writeInternal(newState);
    return newState;
  }

  /**
   * Check if the current run is in a terminal state.
   */
  async isTerminal(): Promise<boolean> {
    const state = await this.read();
    return isTerminal(state.phase);
  }

  /**
   * Build initial state object (does not persist).
   */
  buildInitialState(params: {
    run_id: string;
    task_slug: string;
    project_root: string;
    base_commit: string;
    branch: string;
    max_iterations: number;
  }): RunState {
    const now = new Date().toISOString();
    const defaultStages: Record<string, StageInfo> = {
      planning: { status: StageStatus.PENDING, attempts: 0 },
      developing: { status: StageStatus.PENDING, attempts: 0 },
      verifying: { status: StageStatus.PENDING, attempts: 0 },
      auditing: { status: StageStatus.PENDING, attempts: 0 },
      finalizing: { status: StageStatus.PENDING, attempts: 0 },
    };

    return {
      schema_version: 1,
      run_id: params.run_id,
      task_slug: params.task_slug,
      phase: PhaseEnum.INITIALIZING,
      iteration: 0,
      max_iterations: params.max_iterations,
      consecutive_failure_count: 0,
      project_root: params.project_root,
      base_commit: params.base_commit,
      branch: params.branch,
      goal_digest: null,
      audited_diff_digest: null,
      started_at: now,
      updated_at: now,
      last_error: null,
      cancel_requested_at: null,
      final_commit_sha: null,
      final_commit_message: null,
      finalized_at: null,
      commit_skipped: false,
      skip_reason: null,
      tag_name: null,
      tag_created: false,
      stages: defaultStages,
      task_graph_state: null,
    };
  }

  /**
   * Internal write — validates schema and writes atomically.
   * Private: no external caller can bypass guards.
   */
  private async writeInternal(state: RunState): Promise<void> {
    // Deep freeze check: ensure the state object is valid
    if (!validateState(state)) {
      const errors = validateState.errors?.map((e: {instancePath: string; message?: string}) => `${e.instancePath}: ${e.message}`).join('; ');
      throw new StateStoreError(`Invalid state: ${errors}`);
    }

    state.updated_at = new Date().toISOString();

    try {
      await atomicWriteJSON(this.filePath, state);
    } catch (err) {
      throw new StateStoreError(`Failed to write state.json: ${err}`, err);
    }
  }
}
