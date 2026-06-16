import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { LockManager, LockManagerError } from '../../src/runtime/lock-manager.js';

describe('Lock Manager', () => {
  let tmpDir: string;
  let agentDir: string;
  let lockManager: LockManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-test-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
    lockManager = new LockManager(agentDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('acquire', () => {
    it('should acquire a lock when no lock exists', async () => {
      await lockManager.acquire('run-001');
      const lock = await lockManager.readLock();
      expect(lock).not.toBeNull();
      expect(lock!.run_id).toBe('run-001');
      expect(lock!.pid).toBe(process.pid);
    });

    it('should throw when a lock is held by an active process', async () => {
      await lockManager.acquire('run-001');
      await expect(lockManager.acquire('run-002')).rejects.toThrow(LockManagerError);
      await expect(lockManager.acquire('run-002')).rejects.toThrow('Another run is active');
    });

    it('should throw when a stale lock exists but not yet expired', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      const staleLock = {
        run_id: 'stale-run',
        pid: 999999,
        hostname: os.hostname(),
        created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      };
      await fs.writeJSON(lockPath, staleLock);

      await expect(lockManager.acquire('run-002')).rejects.toThrow(LockManagerError);
      await expect(lockManager.acquire('run-002')).rejects.toThrow('not yet stale');
    });

    it('should reject concurrent acquisitions with exactly one success', async () => {
      const results = await Promise.allSettled([
        lockManager.acquire('run-a'),
        lockManager.acquire('run-b'),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');

      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
    });

    it('should reject malformed lock file', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      await fs.writeFile(lockPath, 'not valid json', 'utf8');

      await expect(lockManager.acquire('run-001')).rejects.toThrow(LockManagerError);
      await expect(lockManager.acquire('run-001')).rejects.toThrow('malformed');
    });
  });

  describe('release', () => {
    it('should release a lock owned by the same run', async () => {
      await lockManager.acquire('run-001');
      expect(await lockManager.isLocked()).toBe(true);

      await lockManager.release('run-001');
      expect(await lockManager.isLocked()).toBe(false);
    });

    it('should reject release by a different runId', async () => {
      await lockManager.acquire('run-001');
      await expect(lockManager.release('run-002')).rejects.toThrow(LockManagerError);
      await expect(lockManager.release('run-002')).rejects.toThrow('owned by');
    });

    it('should reject release without runId', async () => {
      await lockManager.acquire('run-001');
      // release() now requires runId — TypeScript enforces this
      // But we test runtime behavior by calling with wrong id
      await expect(lockManager.release('wrong-id')).rejects.toThrow(LockManagerError);
    });

    it('should not throw when releasing non-existent lock', async () => {
      await expect(lockManager.release('run-001')).resolves.toBeUndefined();
    });

    it('should reject release of corrupted lock (non-JSON)', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      await fs.writeFile(lockPath, 'not valid json', 'utf8');

      // Corrupted lock has pid=-1, should be rejected
      await expect(lockManager.release('<corrupted>')).rejects.toThrow(LockManagerError);
      await expect(lockManager.release('<corrupted>')).rejects.toThrow('malformed or corrupted');
      // Lock should still exist
      expect(await fs.pathExists(lockPath)).toBe(true);
    });

    it('should reject release of malformed lock (invalid structure)', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      await fs.writeJSON(lockPath, { invalid: 'structure' });

      // Malformed lock has pid=-1, should be rejected
      await expect(lockManager.release('<malformed>')).rejects.toThrow(LockManagerError);
      await expect(lockManager.release('<malformed>')).rejects.toThrow('malformed or corrupted');
      // Lock should still exist
      expect(await fs.pathExists(lockPath)).toBe(true);
    });

    it('should reject release with placeholder runId even if it matches', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      await fs.writeFile(lockPath, 'corrupted', 'utf8');

      // Even if someone guesses the placeholder value, it should be rejected
      await expect(lockManager.release('<corrupted>')).rejects.toThrow(LockManagerError);
    });
  });

  describe('forceReleaseStaleLock', () => {
    it('should force-release a stale lock from a dead process', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      const staleLock = {
        run_id: 'stale-run',
        pid: 999999,
        hostname: os.hostname(),
        created_at: new Date(Date.now() - 100000 * 1000).toISOString(),
      };
      await fs.writeJSON(lockPath, staleLock);

      await lockManager.forceReleaseStaleLock();
      expect(await lockManager.isLocked()).toBe(false);
    });

    it('should reject force-release of an active process lock', async () => {
      await lockManager.acquire('run-001');
      await expect(lockManager.forceReleaseStaleLock()).rejects.toThrow(LockManagerError);
      await expect(lockManager.forceReleaseStaleLock()).rejects.toThrow('still alive');
    });

    it('should reject force-release of a dead but not stale lock', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      const deadLock = {
        run_id: 'dead-run',
        pid: 999999,
        hostname: os.hostname(),
        created_at: new Date(Date.now() - 1000).toISOString(),
      };
      await fs.writeJSON(lockPath, deadLock);

      await expect(lockManager.forceReleaseStaleLock()).rejects.toThrow(LockManagerError);
      await expect(lockManager.forceReleaseStaleLock()).rejects.toThrow('not yet stale');
    });

    it('should reject force-release of a malformed lock', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      await fs.writeFile(lockPath, 'not json', 'utf8');

      await expect(lockManager.forceReleaseStaleLock()).rejects.toThrow(LockManagerError);
      await expect(lockManager.forceReleaseStaleLock()).rejects.toThrow('malformed');
    });
  });

  describe('readLock', () => {
    it('should return null when no lock exists', async () => {
      expect(await lockManager.readLock()).toBeNull();
    });

    it('should return lock info when lock exists', async () => {
      await lockManager.acquire('run-001');
      const lock = await lockManager.readLock();
      expect(lock).not.toBeNull();
      expect(lock!.run_id).toBe('run-001');
      expect(lock!.pid).toBe(process.pid);
    });

    it('should return corrupted info for corrupted lock file', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      await fs.writeFile(lockPath, 'not json', 'utf8');
      const lock = await lockManager.readLock();
      expect(lock).not.toBeNull();
      expect(lock!.run_id).toBe('<corrupted>');
    });
  });

  describe('isLocked', () => {
    it('should return false when no lock exists', async () => {
      expect(await lockManager.isLocked()).toBe(false);
    });

    it('should return true when lock is held by active process', async () => {
      await lockManager.acquire('run-001');
      expect(await lockManager.isLocked()).toBe(true);
    });

    it('should return false when lock is held by dead process', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      const deadLock = {
        run_id: 'dead-run',
        pid: 999999,
        hostname: os.hostname(),
        created_at: new Date().toISOString(),
      };
      await fs.writeJSON(lockPath, deadLock);
      expect(await lockManager.isLocked()).toBe(false);
    });

    it('should return true for malformed lock (conservative)', async () => {
      const lockPath = path.join(agentDir, 'run.lock');
      await fs.writeFile(lockPath, 'not json', 'utf8');
      expect(await lockManager.isLocked()).toBe(true);
    });
  });
});