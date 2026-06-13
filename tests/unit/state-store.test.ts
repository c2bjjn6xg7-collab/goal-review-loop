import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { StateStore, StateStoreError } from '../../src/orchestrator/state-store.js';
import { Phase } from '../../src/types.js';

describe('State Store', () => {
  let tmpDir: string;
  let agentDir: string;
  let store: StateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-test-'));
    agentDir = path.join(tmpDir, '.agent');
    await fs.ensureDir(agentDir);
    store = new StateStore(agentDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('create', () => {
    it('should create initial state and persist it', async () => {
      const state = await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      expect(state.schema_version).toBe(1);
      expect(state.run_id).toBe('20260610-test');
      expect(state.phase).toBe(Phase.INITIALIZING);
      expect(state.iteration).toBe(0);
      expect(state.max_iterations).toBe(3);
      expect(state.goal_digest).toBeNull();
      expect(state.last_error).toBeNull();

      // Verify persisted
      const read = await store.read();
      expect(read.run_id).toBe('20260610-test');
    });

    it('should reject creating state when one already exists', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      await expect(store.create({
        run_id: '20260610-test2',
        task_slug: 'test-task2',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      })).rejects.toThrow(StateStoreError);
    });
  });

  describe('read', () => {
    it('should read persisted state', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      const read = await store.read();
      expect(read.run_id).toBe('20260610-test');
    });

    it('should throw when reading non-existent state', async () => {
      await expect(store.read()).rejects.toThrow(StateStoreError);
    });

    it('should throw when reading corrupted JSON', async () => {
      await fs.writeFile(path.join(agentDir, 'state.json'), 'not json', 'utf8');
      await expect(store.read()).rejects.toThrow(StateStoreError);
    });

    it('should reject state with invalid phase', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });
      // Directly write invalid state to file (bypassing store)
      const raw = await fs.readFile(path.join(agentDir, 'state.json'), 'utf8');
      const parsed = JSON.parse(raw);
      parsed.phase = 'INVALID_PHASE';
      await fs.writeFile(path.join(agentDir, 'state.json'), JSON.stringify(parsed), 'utf8');
      await expect(store.read()).rejects.toThrow(StateStoreError);
    });
  });

  describe('transition', () => {
    it('should transition to a legal next phase', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      const newState = await store.transition(Phase.PLANNING);
      expect(newState.phase).toBe(Phase.PLANNING);
    });

    it('should reject illegal direct phase jump', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      // INITIALIZING → AUDITING is illegal (must go through PLANNING → DEVELOPING → VERIFYING → AUDITING)
      await expect(store.transition(Phase.AUDITING)).rejects.toThrow();
    });

    it('should reject transition from terminal state', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      await store.transition(Phase.PLANNING);
      await store.transition(Phase.BLOCKED);

      // BLOCKED → any is illegal
      await expect(store.transition(Phase.PLANNING)).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('should update non-phase fields', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      const updated = await store.update((_state) => ({
        goal_digest: 'sha256:abc123',
        last_error: null,
      }));

      expect(updated.goal_digest).toBe('sha256:abc123');
      expect(updated.phase).toBe(Phase.INITIALIZING); // Phase unchanged
    });

    it('should reject phase change through update()', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });

      await expect(store.update((state) => ({
        ...state,
        phase: Phase.AUDITING,
      }))).rejects.toThrow(StateStoreError);
      await expect(store.update((state) => ({
        ...state,
        phase: Phase.AUDITING,
      }))).rejects.toThrow('Use transition()');
    });
  });

  describe('exists', () => {
    it('should return false before create', async () => {
      expect(await store.exists()).toBe(false);
    });

    it('should return true after create', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });
      expect(await store.exists()).toBe(true);
    });
  });

  describe('isTerminal', () => {
    it('should return true for terminal phases', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });
      await store.transition(Phase.PLANNING);
      await store.transition(Phase.BLOCKED);
      expect(await store.isTerminal()).toBe(true);
    });

    it('should return false for active phases', async () => {
      await store.create({
        run_id: '20260610-test',
        task_slug: 'test-task',
        project_root: '/tmp/test',
        base_commit: 'abc123',
        branch: 'main',
        max_iterations: 3,
      });
      expect(await store.isTerminal()).toBe(false);
    });
  });
});