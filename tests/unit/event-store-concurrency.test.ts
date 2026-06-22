/**
 * Repro test for P1#1: concurrent appends must not duplicate seq values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { EventStore } from '../../src/runtime/event-store.js';

describe('EventStore concurrent append', () => {
  let tmpDir: string;
  let agentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-conc-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('must assign unique monotonic seq under concurrent appends', async () => {
    const store = new EventStore(agentDir, 'run-1');

    // Fire 10 appends concurrently, as wave-mode Promise.all would.
    const drafts = Array.from({ length: 10 }, (_, i) => ({
      kind: 'role.output' as const,
      phase: 'DEVELOPING',
      level: 'info' as const,
      message: `concurrent-${i}`,
    }));
    await Promise.all(drafts.map((d) => store.append(d)));

    const events = await store.readAll();
    const seqs = events.map((e) => e.seq).sort((a, b) => a - b);

    // Expect 1..10 with no duplicates.
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
