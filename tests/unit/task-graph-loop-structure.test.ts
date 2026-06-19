import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTaskGraphTaskSerial } from '../../src/orchestrator/task-graph-loop.js';

describe('task graph loop structure', () => {
  it('exports the serial per-task runner helper', () => {
    expect(typeof runTaskGraphTaskSerial).toBe('function');
  });

  it('keeps the per-task attempt loop inside runTaskGraphTaskSerial, not runTaskGraphLoop', () => {
    const source = readFileSync(join(process.cwd(), 'src/orchestrator/task-graph-loop.ts'), 'utf8');
    const helperStart = source.indexOf('export async function runTaskGraphTaskSerial');
    const loopStart = source.indexOf('export async function runTaskGraphLoop');
    const helpersMarker = source.indexOf('// ─── Phase 8B: Task Graph helpers');

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(loopStart).toBeGreaterThanOrEqual(0);
    expect(helpersMarker).toBeGreaterThan(loopStart);

    const helperBody = source.slice(helperStart, loopStart);
    const loopBody = source.slice(loopStart, helpersMarker);

    expect(helperBody).toMatch(/for \(let attempt = 1; attempt <= maxIterations; attempt\+\+\)/);
    expect(loopBody).toContain('runTaskGraphTaskSerial({');
    expect(loopBody).not.toMatch(/for \(let attempt = 1; attempt <= maxIterations; attempt\+\+\)/);
  });
});
