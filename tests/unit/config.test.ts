import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import {
  loadConfig,
  loadConfigWithDefaults,
  generateSampleConfig,
  validateMvpConstraints,
  DEFAULT_CONFIG,
  ConfigError,
} from '../../src/artifacts/config.js';

describe('Configuration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('loadConfig', () => {
    it('should load a valid configuration', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      await fs.writeFile(configPath, generateSampleConfig(), 'utf8');

      const config = await loadConfig(configPath);
      expect(config.version).toBe(1);
      expect(config.agents.planner.command).toEqual(['codex', 'exec', '{prompt_file}']);
      expect(config.loop.max_iterations).toBe(3);
      expect(config.git.push).toBe(false);
    });

    it('should throw when config file does not exist', async () => {
      await expect(loadConfig('/nonexistent.yaml')).rejects.toThrow(ConfigError);
    });

    it('should throw when config has missing required fields', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      await fs.writeFile(configPath, 'version: 1\n', 'utf8');

      await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
    });

    it('should throw when config has wrong types', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      await fs.writeFile(configPath, 'version: "not a number"\n', 'utf8');

      await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
    });

    it('should throw when max_iterations is out of range', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const config = { ...DEFAULT_CONFIG, loop: { max_iterations: 100 } };
      await fs.writeFile(configPath, generateSampleConfig(), 'utf8');

      // We test with a manually crafted invalid config
      const invalidYaml = `
version: 1
agents:
  planner:
    command: ["codex"]
    timeout_seconds: 1800
  developer:
    command: ["claude"]
    timeout_seconds: 3600
  auditor:
    command: ["codex"]
    timeout_seconds: 1800
loop:
  max_iterations: 100
git:
  require_repository: true
  require_head: true
  require_clean_worktree: true
  branch_template: "agent/test"
  commit_on_pass: true
  commit_template: "feat: test"
  create_tag: false
  tag_template: "test"
  push: false
runtime:
  kill_grace_seconds: 10
  max_log_bytes: 10485760
  lock_stale_seconds: 86400
`;
      await fs.writeFile(configPath, invalidYaml, 'utf8');
      await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
    });
  });

  describe('loadConfigWithDefaults', () => {
    it('should return defaults when no config file exists', async () => {
      const config = await loadConfigWithDefaults(tmpDir);
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should load config when file exists', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      await fs.writeFile(configPath, generateSampleConfig(), 'utf8');

      const config = await loadConfigWithDefaults(tmpDir);
      expect(config.version).toBe(1);
    });
  });

  describe('generateSampleConfig', () => {
    it('should generate valid YAML', async () => {
      const yaml = generateSampleConfig();
      expect(yaml).toContain('version: 1');
      expect(yaml).toContain('agents:');
      expect(yaml).toContain('loop:');
      expect(yaml).toContain('git:');
      expect(yaml).toContain('runtime:');
    });

    it('should generate parseable config', async () => {
      const yaml = generateSampleConfig();
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      await fs.writeFile(configPath, yaml, 'utf8');

      const config = await loadConfig(configPath);
      expect(config.version).toBe(1);
    });
  });

  describe('validateMvpConstraints', () => {
    it('should pass when push is false', () => {
      const config = { ...DEFAULT_CONFIG };
      expect(() => validateMvpConstraints(config)).not.toThrow();
    });

    it('should throw when push is true', () => {
      const config = { ...DEFAULT_CONFIG, git: { ...DEFAULT_CONFIG.git, push: true } };
      expect(() => validateMvpConstraints(config)).toThrow(ConfigError);
      expect(() => validateMvpConstraints(config)).toThrow('not supported in MVP');
    });

    it('loadConfig should reject git.push=true in config file', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const pushYaml = `
version: 1
agents:
  planner:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800
  developer:
    command: ["claude", "-p", "{prompt}"]
    timeout_seconds: 3600
  auditor:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800
loop:
  max_iterations: 3
git:
  require_repository: true
  require_head: true
  require_clean_worktree: true
  branch_template: "agent/{run_id}-{task_slug}"
  commit_on_pass: true
  commit_template: "feat(agent): complete {task_slug} [{run_id}]"
  create_tag: false
  tag_template: "agent-{run_id}-pass"
  push: true
runtime:
  kill_grace_seconds: 10
  max_log_bytes: 10485760
  lock_stale_seconds: 86400
`;
      await fs.writeFile(configPath, pushYaml, 'utf8');
      await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
      await expect(loadConfig(configPath)).rejects.toThrow('not supported in MVP');
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('should have safe defaults', () => {
      expect(DEFAULT_CONFIG.version).toBe(1);
      expect(DEFAULT_CONFIG.loop.max_iterations).toBe(3);
      expect(DEFAULT_CONFIG.git.push).toBe(false);
      expect(DEFAULT_CONFIG.git.require_clean_worktree).toBe(true);
      expect(DEFAULT_CONFIG.git.commit_on_pass).toBe(true);
      expect(DEFAULT_CONFIG.git.create_tag).toBe(false);
    });
  });
});