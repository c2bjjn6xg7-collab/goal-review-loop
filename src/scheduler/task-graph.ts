/**
 * Phase 8B: Task graph utilities — topological sort, cycle detection,
 * and validation for the minimal task graph.
 *
 * Sequential execution only (no parallelism, worktrees, or merge orchestration).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { TaskGraph, TaskNode, TaskStatus } from '../types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

const SAFE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
const SAFE_GLOB_PATTERN = '^[^\\\\]+$';

const taskVerificationCommandSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: SAFE_ID_PATTERN },
    command: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    cwd: { type: 'string', minLength: 1 },
    required: { type: 'boolean' },
    timeout_seconds: { type: 'number', minimum: 1, maximum: 7200 },
  },
  required: ['id', 'command', 'cwd', 'required', 'timeout_seconds'],
  additionalProperties: false,
} as const;

const taskNodeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: SAFE_ID_PATTERN },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    difficulty: { type: 'string', enum: ['low', 'medium', 'high'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    parallelizable: { type: 'boolean' },
    depends_on: { type: 'array', items: { type: 'string', pattern: SAFE_ID_PATTERN } },
    allowed_changes: { type: 'array', items: { type: 'string', pattern: SAFE_GLOB_PATTERN, minLength: 1 }, minItems: 1 },
    disallowed_changes: { type: 'array', items: { type: 'string', pattern: SAFE_GLOB_PATTERN, minLength: 1 } },
    verification_commands: { type: 'array', items: taskVerificationCommandSchema, minItems: 1 },
    status: { type: 'string', enum: ['pending', 'running', 'passed', 'failed', 'skipped', 'blocked'] },
  },
  required: [
    'id', 'title', 'description', 'difficulty', 'risk', 'parallelizable',
    'depends_on', 'allowed_changes', 'disallowed_changes',
    'verification_commands', 'status',
  ],
  additionalProperties: false,
} as const;

const taskGraphSchema = {
  type: 'object',
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    goal_digest: { type: 'string', minLength: 1 },
    tasks: { type: 'array', items: taskNodeSchema, minItems: 1, maxItems: 10 },
    created_at: { type: 'string', minLength: 1 },
  },
  required: ['schema_version', 'run_id', 'goal_digest', 'tasks', 'created_at'],
  additionalProperties: false,
} as const;

const validateTaskGraphSchema = ajv.compile(taskGraphSchema);

export interface TaskGraphValidationResult {
  valid: boolean;
  errors: string[];
  graph: TaskGraph | null;
}

/**
 * Validate a task graph object against the Phase 8B requirements:
 * - Parses as TaskGraph (AJV schema).
 * - 1–10 tasks.
 * - All depends_on references point to existing task IDs.
 * - No duplicate task IDs.
 * - No cycles (topological sort succeeds).
 * - Every task has at least one verification_commands entry.
 * - allowed_changes is non-empty for each task.
 * - Safe paths (no absolute, no ..).
 */
export function validateTaskGraph(input: unknown): TaskGraphValidationResult {
  const errors: string[] = [];

  if (!validateTaskGraphSchema(input)) {
    for (const err of validateTaskGraphSchema.errors ?? []) {
      errors.push(`${err.instancePath || '(root)'}: ${err.message}`);
    }
    return { valid: false, errors, graph: null };
  }

  const graph = input as TaskGraph;

  // Duplicate IDs
  const seenIds = new Set<string>();
  for (const task of graph.tasks) {
    if (seenIds.has(task.id)) {
      errors.push(`Duplicate task id: ${task.id}`);
    }
    seenIds.add(task.id);
  }

  // depends_on references + safe paths
  for (const task of graph.tasks) {
    for (const dep of task.depends_on) {
      if (!seenIds.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
      if (dep === task.id) {
        errors.push(`Task "${task.id}" depends on itself`);
      }
    }
    for (const ac of task.allowed_changes) {
      if (ac.startsWith('/') || ac.includes('..')) {
        errors.push(`Task "${task.id}" allowed_changes contains unsafe path: "${ac}"`);
      }
    }
    for (const dc of task.disallowed_changes) {
      if (dc.startsWith('/') || dc.includes('..')) {
        errors.push(`Task "${task.id}" disallowed_changes contains unsafe path: "${dc}"`);
      }
    }
    for (const vc of task.verification_commands) {
      if (vc.cwd.startsWith('/') || vc.cwd.includes('..')) {
        errors.push(`Task "${task.id}" verification command "${vc.id}" has unsafe cwd: "${vc.cwd}"`);
      }
    }
  }

  // Cycle detection via topological sort
  const order = topologicalSort(graph);
  if (order === null) {
    errors.push('Task graph contains a cycle (topological sort failed)');
  }

  return {
    valid: errors.length === 0,
    errors,
    graph: errors.length === 0 ? graph : null,
  };
}

/**
 * Topological sort of task graph nodes.
 * Returns an array of task IDs in dependency order, or null if a cycle exists.
 * Uses Kahn's algorithm (in-degree based).
 */
export function topologicalSort(graph: TaskGraph): string[] | null {
  const ids = graph.tasks.map((t) => t.id);
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of ids) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const task of graph.tasks) {
    for (const dep of task.depends_on) {
      // Only count edges to existing tasks (unknown deps are reported elsewhere)
      if (inDegree.has(dep)) {
        adjacency.get(dep)!.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  // For deterministic output, sort the initial queue by task order in the graph
  queue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));

  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    const next: string[] = [];
    for (const neighbor of adjacency.get(id) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) next.push(neighbor);
    }
    next.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    queue.push(...next);
  }

  if (ordered.length !== ids.length) {
    return null; // cycle detected
  }
  return ordered;
}

/**
 * Return tasks ordered by their topological sort.
 * Throws if the graph contains a cycle.
 */
export function orderedTasks(graph: TaskGraph): TaskNode[] {
  const order = topologicalSort(graph);
  if (order === null) {
    throw new Error('Task graph contains a cycle');
  }
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  return order.map((id) => byId.get(id)!);
}

/**
 * Load and validate task-graph.json from the .agent directory.
 * Returns null if the file does not exist.
 */
export function loadTaskGraph(projectRoot: string): TaskGraphValidationResult {
  const path = join(projectRoot, '.agent', 'task-graph.json');
  if (!existsSync(path)) {
    return { valid: false, errors: ['task-graph.json not found'], graph: null };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { valid: false, errors: [`Cannot read task-graph.json: ${err instanceof Error ? err.message : String(err)}`], graph: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { valid: false, errors: [`task-graph.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`], graph: null };
  }
  return validateTaskGraph(parsed);
}

/**
 * Check whether a task graph exists in the .agent directory.
 */
export function taskGraphExists(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.agent', 'task-graph.json'));
}

/**
 * Initialize per-task statuses to 'pending'.
 */
export function initialTaskStatuses(graph: TaskGraph): Record<string, TaskStatus> {
  const statuses: Record<string, TaskStatus> = {};
  for (const task of graph.tasks) {
    statuses[task.id] = 'pending';
  }
  return statuses;
}

/**
 * Initialize per-task attempt counts to 0.
 */
export function initialTaskAttempts(graph: TaskGraph): Record<string, number> {
  const attempts: Record<string, number> = {};
  for (const task of graph.tasks) {
    attempts[task.id] = 0;
  }
  return attempts;
}
