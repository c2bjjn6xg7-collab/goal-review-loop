import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { LockManager, LockManagerError } from '../../src/runtime/lock-manager.js';

describe('LockManager.acquireOrRecover', () => {
  let tmpDir: string;
  let agentDir: string;
  let lockManager: LockManager;
  let lockPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-recover-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
    lockManager = new LockManager(agentDir);
    lockPath = path.join(agentDir, 'run.lock');
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('succeeds when no lock exists', async () => {
    await lockManager.acquireOrRecover('run-001');
    const lock = await lockManager.readLock();
    expect(lock).not.toBeNull();
    expect(lock!.run_id).toBe('run-001');
    expect(lock!.pid).toBe(process.pid);
  });

  it('recovers a stale lock held by a dead PID', async () => {
    const staleLock = {
      run_id: 'dead-run',
      pid: 999999, // reliably dead
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    };
    await fs.writeJSON(lockPath, staleLock);

    await lockManager.acquireOrRecover('run-002');

    const lock = await lockManager.readLock();
    expect(lock).not.toBeNull();
    expect(lock!.run_id).toBe('run-002');
    expect(lock!.pid).toBe(process.pid);
  });

  it('recovers a stale lock held by a dead PID even when not yet past stale threshold', async () => {
    const staleLock = {
      run_id: 'dead-run-young',
      pid: 999999,
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 60 * 1000).toISOString(),
    };
    await fs.writeJSON(lockPath, staleLock);

    await lockManager.acquireOrRecover('run-003', 86400);

    const lock = await lockManager.readLock();
    expect(lock!.run_id).toBe('run-003');
    expect(lock!.pid).toBe(process.pid);
  });

  it('throws when the lock is held by a live, fresh process', async () => {
    // Acquire with the current (live) process — fresh lock.
    await lockManager.acquire('run-active');

    await expect(lockManager.acquireOrRecover('run-002')).rejects.toThrow(LockManagerError);
    await expect(lockManager.acquireOrRecover('run-002')).rejects.toThrow('Another run is active');

    // The original lock is untouched.
    const lock = await lockManager.readLock();
    expect(lock!.run_id).toBe('run-active');
  });

  it('recovers a live-PID lock that has exceeded the stale threshold', async () => {
    const staleLock = {
      run_id: 'old-live-run',
      pid: process.pid, // alive
      hostname: os.hostname(),
      created_at: new Date(Date.now() - 7200 * 1000).toISOString(), // 2h old
    };
    await fs.writeJSON(lockPath, staleLock);

    await lockManager.acquireOrRecover('run-004', 3600); // stale threshold 1h

    const lock = await lockManager.readLock();
    expect(lock!.run_id).toBe('run-004');
    expect(lock!.pid).toBe(process.pid);
  });

  it('is idempotent on double invocation — second call sees its own fresh lock and refuses to recover it', async () => {
    await lockManager.acquireOrRecover('run-005');

    // Second invocation: lock now exists, held by us (alive, fresh).
    // Must NOT recover its own active lock; must throw a clean conflict.
    await expect(lockManager.acquireOrRecover('run-005')).rejects.toThrow(LockManagerError);

    const lock = await lockManager.readLock();
    expect(lock!.run_id).toBe('run-005');
    expect(lock!.pid).toBe(process.pid);
  });
});
