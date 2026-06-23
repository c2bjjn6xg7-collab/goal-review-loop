/**
 * Lock Manager — prevents concurrent runs in the same workspace.
 * Design doc §16.3
 *
 * INVARIANT: Lock acquisition is atomic via O_EXCL (wx flag).
 * - acquire() creates the lock file exclusively; EEXIST = lock contention.
 * - release() verifies ownership before deleting.
 * - Stale locks require explicit recovery with stale threshold enforcement.
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import process from 'process';
import type { LockInfo } from '../types.js';

export class LockManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockManagerError';
  }
}

export interface LockManagerOptions {
  /**
   * Optional alternate lock file name (e.g. "scheduler.lock").
   * When omitted, defaults to "run.lock" — byte-identical to the legacy behavior.
   */
  lockName?: string;
}

export class LockManager {
  private readonly lockPath: string;

  constructor(agentDir: string, options: LockManagerOptions = {}) {
    const lockName = options.lockName ?? 'run.lock';
    this.lockPath = path.join(agentDir, lockName);
  }

  /**
   * Check if a lock file exists and is valid.
   * Returns the lock info if the lock is held, null otherwise.
   */
  async readLock(): Promise<LockInfo | null> {
    if (!(await fs.pathExists(this.lockPath))) {
      return null;
    }

    try {
      const raw = await fs.readFile(this.lockPath, 'utf8');
      const data = JSON.parse(raw);
      // Basic validation
      if (data.run_id && typeof data.pid === 'number' && data.hostname && data.created_at) {
        return data as LockInfo;
      }
      // Malformed lock — treat conservatively as a held lock
      return { run_id: '<malformed>', pid: -1, hostname: '<unknown>', created_at: '' };
    } catch {
      // Corrupted but exists — treat as held lock (conservative)
      return { run_id: '<corrupted>', pid: -1, hostname: '<unknown>', created_at: '' };
    }
  }

  /**
   * Check if the process holding the lock is still alive.
   */
  isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false; // Malformed/corrupted lock
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Acquire the lock atomically using exclusive file creation (wx flag).
   * This is a true atomic operation: either we create the file exclusively, or it already exists.
   *
   * Known limitation — stale-lock recovery TOCTOU window:
   * There is a TOCTOU (time-of-check to time-of-use) window during stale-lock recovery
   * between detecting that the existing lock is stale (dead PID + past staleness threshold)
   * and completing recovery (unlinking the stale lock and re-running the exclusive create).
   * Within that window, the original holder may become active again — for example, the OS
   * may reuse the original PID for a new unrelated process, or, in pathological cases, the
   * original process may be observed as dead and then resume — and recovery would then
   * displace a lock that is no longer actually stale. This is a known limitation and is
   * not being fixed in this change; callers needing strict guarantees against this race
   * should coordinate at a higher level (e.g., external orchestration or operator review).
   */
  async acquire(runId: string, staleSeconds = 86400): Promise<void> {
    const lockInfo: LockInfo = {
      run_id: runId,
      pid: process.pid,
      hostname: os.hostname(),
      created_at: new Date().toISOString(),
    };

    // Attempt atomic creation with wx (O_EXCL)
    try {
      const fd = await fs.promises.open(this.lockPath, 'wx');
      await fd.writeFile(JSON.stringify(lockInfo, null, 2) + '\n', 'utf8');
      await fd.sync();
      await fd.close();
      return; // Successfully acquired
    } catch (err) {
      const code = (err as {code?: string}).code;
      if (code !== 'EEXIST') {
        throw new LockManagerError(`Failed to acquire lock: ${err}`);
      }
      // Lock file exists — inspect it
    }

    // Lock file already exists — check who holds it
    const existing = await this.readLock();

    if (!existing) {
      // Race condition: file was deleted between EEXIST and readLock
      // Retry once
      try {
        const fd = await fs.promises.open(this.lockPath, 'wx');
        await fd.writeFile(JSON.stringify(lockInfo, null, 2) + '\n', 'utf8');
        await fd.sync();
        await fd.close();
        return;
      } catch (retryErr) {
        const code = (retryErr as {code?: string}).code;
        if (code === 'EEXIST') {
          throw new LockManagerError('Lock contention: another process acquired the lock simultaneously.');
        }
        throw new LockManagerError(`Failed to acquire lock on retry: ${retryErr}`);
      }
    }

    // Malformed/corrupted lock — do NOT silently overwrite
    if (existing.pid <= 0) {
      throw new LockManagerError(
        `Lock file exists but is malformed. Manual intervention required. Delete ${this.lockPath} after verifying no other run is active.`,
      );
    }

    // Check if the process is still alive
    if (this.isProcessAlive(existing.pid)) {
      throw new LockManagerError(
        `Another run is active: run_id=${existing.run_id}, pid=${existing.pid}, hostname=${existing.hostname}. Cannot start a new run.`,
      );
    }

    // Process is dead — check stale threshold
    const lockAge = Date.now() - new Date(existing.created_at).getTime();
    if (lockAge < staleSeconds * 1000) {
      throw new LockManagerError(
        `Lock file exists but process ${existing.pid} is dead. Lock is not yet stale (age: ${Math.round(lockAge / 1000)}s, stale threshold: ${staleSeconds}s). Use --recover-lock to force recovery.`,
      );
    }

    // Stale lock — require explicit recovery
    throw new LockManagerError(
      `Stale lock found (process ${existing.pid} is dead, age: ${Math.round(lockAge / 1000)}s). Use --recover-lock to recover.`,
    );
  }

  /**
   * Acquire the lock, recovering a stale lock if one exists.
   * Enforces stale threshold even with recovery flag.
   */
  async acquireWithRecovery(runId: string, staleSeconds = 86400): Promise<void> {
    // First try normal acquire
    try {
      await this.acquire(runId, staleSeconds);
      return;
    } catch (err) {
      if (!(err instanceof LockManagerError)) throw err;
      // Check if it's a stale lock we can recover
      const msg = err.message;
      if (!msg.includes('Stale lock') && !msg.includes('not yet stale')) {
        // Active lock or malformed — cannot recover
        throw err;
      }
    }

    // Verify the lock is actually stale (dead process + past threshold)
    const existing = await this.readLock();
    if (!existing || existing.pid <= 0) {
      throw new LockManagerError('Cannot recover: lock file disappeared or is malformed.');
    }

    if (this.isProcessAlive(existing.pid)) {
      throw new LockManagerError(
        `Cannot recover: process ${existing.pid} is still alive.`,
      );
    }

    const lockAge = Date.now() - new Date(existing.created_at).getTime();
    if (lockAge < staleSeconds * 1000) {
      throw new LockManagerError(
        `Cannot recover: lock is not yet stale (age: ${Math.round(lockAge / 1000)}s, threshold: ${staleSeconds}s).`,
      );
    }

    // Remove stale lock and acquire
    await fs.unlink(this.lockPath);
    await this.acquire(runId, staleSeconds);
  }

  /**
   * Acquire the lock, automatically recovering a stale lock if one exists.
   *
   * Recovery is performed when the existing lock is held by:
   *   - a dead PID (any age), or
   *   - a live PID whose lock age has exceeded `staleSeconds`.
   *
   * If the existing lock is held by a live process with a fresh (non-expired)
   * lock, this throws `LockManagerError` — that is a real concurrency conflict
   * and must not be silently displaced.
   *
   * When no lock exists, this behaves identically to `acquire()`.
   *
   * Known limitation — stale-lock recovery TOCTOU window: see the note on
   * `acquire()`. The same race applies here between staleness detection and
   * re-acquisition.
   */
  async acquireOrRecover(runId: string, staleSeconds = 86400): Promise<void> {
    // Fast path: no existing lock — normal acquire succeeds.
    try {
      await this.acquire(runId, staleSeconds);
      return;
    } catch (err) {
      if (!(err instanceof LockManagerError)) throw err;
      // Lock exists or contention occurred — fall through to inspect.
    }

    const existing = await this.readLock();
    if (!existing) {
      // Lock disappeared between the failed acquire and readLock — retry once.
      await this.acquire(runId, staleSeconds);
      return;
    }

    // Malformed/corrupted lock — do NOT silently overwrite.
    if (existing.pid <= 0) {
      throw new LockManagerError(
        `Lock file exists but is malformed. Manual intervention required. Delete ${this.lockPath} after verifying no other run is active.`,
      );
    }

    const alive = this.isProcessAlive(existing.pid);
    const lockAge = Date.now() - new Date(existing.created_at).getTime();
    const expired = lockAge >= staleSeconds * 1000;

    // Real conflict: live process holding a fresh lock.
    if (alive && !expired) {
      throw new LockManagerError(
        `Another run is active: run_id=${existing.run_id}, pid=${existing.pid}, hostname=${existing.hostname}. Cannot start a new run.`,
      );
    }

    // Stale lock — dead PID (any age) or live PID past stale threshold.
    // Remove it and retry the atomic acquire.
    try {
      await fs.unlink(this.lockPath);
    } catch (err) {
      if ((err as {code?: string}).code !== 'ENOENT') {
        throw new LockManagerError(`Failed to remove stale lock: ${err}`);
      }
    }
    await this.acquire(runId, staleSeconds);
  }

  /**
   * Release the lock. runId is REQUIRED — ownership is always verified.
   *
   * Rules:
   * 1. If lock doesn't exist, return silently.
   * 2. If lock is malformed/corrupted (pid <= 0), reject — manual intervention required.
   * 3. If runId doesn't match, reject — not the owner.
   * 4. Internal placeholder values (<malformed>, <corrupted>) are never valid owners.
   */
  async release(runId: string): Promise<void> {
    if (!(await fs.pathExists(this.lockPath))) {
      return; // No lock to release
    }

    // Read and validate the lock
    const lock = await this.readLock();

    // If lock is malformed/corrupted, require manual intervention
    if (!lock || lock.pid <= 0) {
      throw new LockManagerError(
        `Cannot release lock: file is malformed or corrupted. Manual intervention required. Delete ${this.lockPath} after verifying no other run is active.`,
      );
    }

    // Verify ownership
    if (lock.run_id !== runId) {
      throw new LockManagerError(
        `Cannot release lock: owned by run_id=${lock.run_id}, not ${runId}.`,
      );
    }

    try {
      await fs.unlink(this.lockPath);
    } catch (err) {
      if ((err as {code?: string}).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * Force-release a stale lock. Only allowed when:
   * 1. The lock exists
   * 2. The owning process is dead
   * 3. The lock age exceeds the stale threshold
   *
   * This is a separate, explicitly-named API for admin/recovery use.
   * Normal release() always requires ownership.
   */
  async forceReleaseStaleLock(staleSeconds = 86400): Promise<void> {
    const existing = await this.readLock();
    if (!existing) {
      return; // No lock
    }

    if (existing.pid <= 0) {
      throw new LockManagerError(
        'Cannot force-release: lock file is malformed. Manual intervention required.',
      );
    }

    if (this.isProcessAlive(existing.pid)) {
      throw new LockManagerError(
        `Cannot force-release: process ${existing.pid} is still alive.`,
      );
    }

    const lockAge = Date.now() - new Date(existing.created_at).getTime();
    if (lockAge < staleSeconds * 1000) {
      throw new LockManagerError(
        `Cannot force-release: lock is not yet stale (age: ${Math.round(lockAge / 1000)}s, threshold: ${staleSeconds}s).`,
      );
    }

    try {
      await fs.unlink(this.lockPath);
    } catch (err) {
      if ((err as {code?: string}).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * Check if a lock is currently held by an active process.
   */
  async isLocked(): Promise<boolean> {
    const lock = await this.readLock();
    if (!lock) return false;
    if (lock.pid <= 0) return true; // Malformed — treat as locked
    return this.isProcessAlive(lock.pid);
  }
}
