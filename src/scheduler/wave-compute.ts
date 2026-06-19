/**
 * Phase 8D P5 Round 1: Pure wave-compute functions.
 *
 * Inputs: a `TaskNode[]` with `depends_on` and `parallelizable` fields.
 * Outputs: a `WavePlan` describing topological-depth waves with non-parallelizable
 * tasks isolated into singleton waves.
 *
 * This module is intentionally pure: no filesystem, process, git, agent, or
 * orchestrator side effects. It only inspects task ids, `depends_on`, and
 * `parallelizable`.
 *
 * Round 1 stops here. Wiring into the task-graph loop or orchestrator dispatch
 * is the responsibility of later rounds.
 */
import type { TaskNode } from '../types.js';

/**
 * A computed wave plan. Each entry of `waves` is a wave (a set of task ids
 * that can run in parallel under the rules in this module). `waveIndexOfTask`
 * maps each task id to the 0-based wave index it ended up in.
 */
export interface WavePlan {
  /** Each element is a wave; inside it are the task ids assigned to that wave. */
  waves: string[][];
  /** Each task id mapped to its 0-based wave index. */
  waveIndexOfTask: Map<string, number>;
}

/**
 * Error thrown for any structural/wave-compute failure: missing dependency,
 * cycle, dependency-order violation, or demotion-cap exceeded. Kept as a
 * single class so callers can `instanceof WaveComputeError` and inspect
 * `.message` or `.code`.
 */
export class WaveComputeError extends Error {
  public readonly code:
    | 'cycle'
    | 'missing-dependency'
    | 'dependency-order-violation'
    | 'demotion-cap-exceeded';

  constructor(
    message: string,
    code:
      | 'cycle'
      | 'missing-dependency'
      | 'dependency-order-violation'
      | 'demotion-cap-exceeded',
  ) {
    super(message);
    this.name = 'WaveComputeError';
    this.code = code;
  }
}

/**
 * Compute deterministic topological-depth waves from a task list.
 *
 * Rules (per Phase 8D P5 brief §1.2 / §1.3):
 * - Throws `WaveComputeError('missing-dependency')` if any `depends_on` entry
 *   does not match a task id in the input.
 * - Throws `WaveComputeError('cycle')` if the dependency graph has a cycle.
 * - Empty input → empty plan (no throw).
 * - Tasks with no dependencies start in topological depth 0; otherwise the
 *   depth is `max(depth(dep)) + 1` for `dep in depends_on`.
 * - Non-parallelizable tasks each occupy a singleton wave. Multiple
 *   non-parallelizable tasks in the same topological layer are placed in
 *   consecutive singleton waves, ordered by `task.id` lexicographically.
 * - A parallelizable task never shares a wave with a non-parallelizable task.
 *   It is shifted to the next non-singleton wave at its layer.
 * - Within a parallelizable wave, task ids are sorted lexicographically.
 */
export function computeWaves(tasks: TaskNode[]): WavePlan {
  if (tasks.length === 0) {
    return { waves: [], waveIndexOfTask: new Map() };
  }

  const byId = new Map<string, TaskNode>();
  for (const task of tasks) {
    byId.set(task.id, task);
  }

  // Validate dependency references before any traversal.
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!byId.has(dep)) {
        throw new WaveComputeError(
          `Task "${task.id}" depends on missing task "${dep}"`,
          'missing-dependency',
        );
      }
    }
  }

  // Compute topological depth via DFS with cycle detection.
  // depth[id] = 0 if no dependencies; else max(depth[dep]) + 1.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  const computeDepth = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      throw new WaveComputeError(
        `Task graph contains a cycle involving "${id}"`,
        'cycle',
      );
    }
    visiting.add(id);
    const node = byId.get(id)!;
    let d = 0;
    for (const dep of node.depends_on) {
      const dd = computeDepth(dep);
      if (dd + 1 > d) d = dd + 1;
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  for (const task of tasks) {
    computeDepth(task.id);
  }

  // Group tasks by topological depth. Each layer's tasks are sorted by id
  // lexicographically so downstream wave layout is deterministic.
  const maxDepth = Math.max(...Array.from(depth.values()));
  const layers: TaskNode[][] = [];
  for (let i = 0; i <= maxDepth; i++) layers.push([]);
  for (const task of tasks) {
    layers[depth.get(task.id)!].push(task);
  }
  for (const layer of layers) {
    layer.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Lay out waves layer by layer.
  // Within a layer:
  //   - All non-parallelizable tasks (sorted by id) each become a singleton
  //     wave, placed before any parallel-task wave.
  //   - All parallelizable tasks form a single wave (or zero waves if none).
  // Parallel tasks never share a wave with a non-parallelizable task.
  const waves: string[][] = [];
  for (const layer of layers) {
    if (layer.length === 0) continue;
    const np: TaskNode[] = [];
    const par: TaskNode[] = [];
    for (const t of layer) {
      if (t.parallelizable) par.push(t);
      else np.push(t);
    }
    for (const t of np) {
      waves.push([t.id]);
    }
    if (par.length > 0) {
      waves.push(par.map((t) => t.id));
    }
  }

  return { waves, waveIndexOfTask: buildWaveIndex(waves) };
}

/**
 * Demote tasks that conflict with a peer in the same wave.
 *
 * Rules (per Phase 8D P5 brief §1.3):
 * - For each wave, iterate task ids; if any pair of ids in that wave conflict
 *   (per the `conflicts` adjacency map), demote the lexically larger id to the
 *   next wave (creating a new trailing wave if needed).
 * - Re-check the demoted-into wave so cascades resolve deterministically.
 * - Cap iterations at `tasks.length × Σ|conflicts[t]|`. If still demoting at
 *   the cap, throw `WaveComputeError('demotion-cap-exceeded')`.
 * - Within each wave, keep ids sorted lexicographically for determinism.
 * - Returns a new `WavePlan` with a freshly built `waveIndexOfTask`.
 *
 * The input `plan` is not mutated. Empty `conflicts` returns an
 * equivalent plan (with the same task layout, but a freshly built index map).
 */
export function demoteConflicts(
  plan: WavePlan,
  conflicts: Map<string, string[]>,
  tasks?: TaskNode[],
): WavePlan {
  // Deep-copy waves so we can mutate freely.
  const waves: string[][] = plan.waves.map((w) => [...w]);

  // Compute total task count across the plan and total conflict edges.
  let taskCount = 0;
  for (const wave of waves) taskCount += wave.length;
  let edgeCount = 0;
  for (const peers of conflicts.values()) edgeCount += peers.length;

  // Cap = tasks × Σ|conflicts[t]|. If either is 0, no demotions are possible
  // anyway, but we still allow one normalization pass below.
  const cap = taskCount * edgeCount;

  // Helper: does `a` conflict with `b` per the adjacency map (either direction)?
  const conflictsWith = (a: string, b: string): boolean => {
    const peersA = conflicts.get(a);
    if (peersA && peersA.includes(b)) return true;
    const peersB = conflicts.get(b);
    if (peersB && peersB.includes(a)) return true;
    return false;
  };

  // Find the first conflicting pair in a wave (after lexical sort), and return
  // the lexically larger id. Returns null if the wave is conflict-free.
  const findConflictedTask = (wave: string[]): string | null => {
    for (let i = 0; i < wave.length; i++) {
      for (let j = i + 1; j < wave.length; j++) {
        if (conflictsWith(wave[i], wave[j])) {
          // Lexically larger id is demoted.
          return wave[i] < wave[j] ? wave[j] : wave[i];
        }
      }
    }
    return null;
  };

  let iterations = 0;
  let waveIdx = 0;
  while (waveIdx < waves.length) {
    // Sort current wave for deterministic comparison ordering.
    waves[waveIdx].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const victim = findConflictedTask(waves[waveIdx]);
    if (victim === null) {
      waveIdx++;
      continue;
    }
    if (iterations >= cap) {
      throw new WaveComputeError(
        `demoteConflicts: demotion cap (${cap}) exceeded — graph is not separable by demotion`,
        'demotion-cap-exceeded',
      );
    }
    iterations++;

    // Remove victim from current wave.
    waves[waveIdx] = waves[waveIdx].filter((id) => id !== victim);

    // Insert into next wave (create one if needed).
    if (waveIdx + 1 >= waves.length) {
      waves.push([victim]);
    } else {
      waves[waveIdx + 1].push(victim);
    }
    // Do NOT advance waveIdx; re-check current wave for further conflicts
    // among the survivors, then re-check the next wave on the next iteration.
    if (waves[waveIdx].length === 0) {
      // Drop empty wave so the plan stays compact.
      waves.splice(waveIdx, 1);
      // After splice, the next wave (the one we demoted into) is at waveIdx;
      // the loop will sort and check it next.
    }
  }

  const result = { waves, waveIndexOfTask: buildWaveIndex(waves) };
  if (tasks) {
    validateWaveDependencies(result, tasks);
  }
  return result;
}

/**
 * Validate that every dependency is placed in an earlier wave than the task
 * that depends on it. This is intentionally separate from `computeWaves`
 * because future scheduler rounds may transform a plan after initial layering
 * (for example, conflict demotion) and must re-check dependency ordering before
 * executing the plan.
 */
export function validateWaveDependencies(plan: WavePlan, tasks: TaskNode[]): void {
  const waveIndexOfTask = buildWaveIndex(plan.waves);
  const taskIds = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    const taskWave = waveIndexOfTask.get(task.id);
    if (taskWave === undefined) {
      throw new WaveComputeError(
        `Task "${task.id}" is missing from the wave plan`,
        'dependency-order-violation',
      );
    }

    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        throw new WaveComputeError(
          `Task "${task.id}" depends on missing task "${dep}"`,
          'missing-dependency',
        );
      }

      const depWave = waveIndexOfTask.get(dep);
      if (depWave === undefined) {
        throw new WaveComputeError(
          `Dependency "${dep}" for task "${task.id}" is missing from the wave plan`,
          'dependency-order-violation',
        );
      }

      if (depWave >= taskWave) {
        throw new WaveComputeError(
          `Task "${task.id}" depends on "${dep}", but dependency wave ${depWave} is not before task wave ${taskWave}`,
          'dependency-order-violation',
        );
      }
    }
  }
}

function buildWaveIndex(waves: string[][]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < waves.length; i++) {
    for (const id of waves[i]) {
      idx.set(id, i);
    }
  }
  return idx;
}
