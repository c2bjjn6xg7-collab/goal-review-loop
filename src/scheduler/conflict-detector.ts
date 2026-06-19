import micromatch from 'micromatch';
import type { TaskNode } from '../types.js';

const GLOB_META = /[*?[]/;

function globDirPrefix(glob: string): string {
  const segments = glob.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (GLOB_META.test(segment)) {
      if (literal.length === 0) return '';
      return literal.join('/') + '/';
    }
    literal.push(segment);
  }
  return literal.join('/');
}

function prefixesMayOverlap(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  return a.startsWith(b) || b.startsWith(a);
}

export function globsMayConflict(a: string, b: string, trackedFiles: string[]): boolean {
  const aPrefix = globDirPrefix(a);
  const bPrefix = globDirPrefix(b);

  if (!prefixesMayOverlap(aPrefix, bPrefix)) {
    return false;
  }

  for (const file of trackedFiles) {
    if (micromatch.isMatch(file, [a], { dot: true }) && micromatch.isMatch(file, [b], { dot: true })) {
      return true;
    }
  }

  return true;
}

export function detectWaveConflicts(
  tasks: TaskNode[],
  trackedFiles: string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const task of tasks) {
    result.set(task.id, []);
  }

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const taskA = tasks[i];
      const taskB = tasks[j];
      if (tasksMayConflict(taskA, taskB, trackedFiles)) {
        appendUnique(result, taskA.id, taskB.id);
        appendUnique(result, taskB.id, taskA.id);
      }
    }
  }

  return result;
}

function tasksMayConflict(a: TaskNode, b: TaskNode, trackedFiles: string[]): boolean {
  for (const globA of a.allowed_changes) {
    for (const globB of b.allowed_changes) {
      if (globsMayConflict(globA, globB, trackedFiles)) {
        return true;
      }
    }
  }
  return false;
}

function appendUnique(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [value]);
    return;
  }
  if (!list.includes(value)) {
    list.push(value);
  }
}
