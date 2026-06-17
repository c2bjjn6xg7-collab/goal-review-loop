import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import {
  loadConfig,
  loadConfigWithDefaults,
  generateSampleConfig,
  validateMvpConstraints,
  validateNetworkConfig,
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
      const _config = { ...DEFAULT_CONFIG, loop: { max_iterations: 100 } };
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

    // SF-2: Default Developer command must use stdin prompt file transmission
    it('developer command should use {prompt_file} not {prompt} as positional arg', () => {
      const devCmd = DEFAULT_CONFIG.agents.developer.command;
      // Must use {prompt_file} (stdin-based), not {prompt} (positional argv)
      expect(devCmd).toContain('{prompt_file}');
      expect(devCmd).not.toContain('{prompt}');
      // Must use sh -lc wrapper for stdin redirection
      expect(devCmd[0]).toBe('sh');
      expect(devCmd[1]).toBe('-lc');
      // The shell command must pipe prompt file via stdin
      expect(devCmd[2]).toContain('claude');
      expect(devCmd[2]).toContain('--permission-mode');
      expect(devCmd[2]).toContain('<');
    });

    it('planner and auditor commands should use {prompt_file}', () => {
      expect(DEFAULT_CONFIG.agents.planner.command).toContain('{prompt_file}');
      expect(DEFAULT_CONFIG.agents.auditor.command).toContain('{prompt_file}');
    });
  });

  // SF-2: generateSampleConfig round-trip with new developer command
  describe('SF-2: default config stdin prompt transmission', () => {
    it('generateSampleConfig produces YAML that loadConfig can parse', async () => {
      const yaml = generateSampleConfig();
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      await fs.writeFile(configPath, yaml, 'utf8');

      const config = await loadConfig(configPath);
      // Developer command must use stdin prompt file
      expect(config.agents.developer.command).toContain('{prompt_file}');
      expect(config.agents.developer.command).not.toContain('{prompt}');
      // Must be a valid sh -lc command
      expect(config.agents.developer.command[0]).toBe('sh');
      expect(config.agents.developer.command[1]).toBe('-lc');
    });

    it('custom model command can still be loaded', async () => {
      const customYaml = `
version: 1
agents:
  planner:
    command: ["codex", "exec", "{prompt_file}"]
    timeout_seconds: 1800
  developer:
    command: ["sh", "-lc", "exec my-custom-llm --input < \\"$1\\"", "custom-dev", "{prompt_file}"]
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
  push: false
runtime:
  kill_grace_seconds: 10
  max_log_bytes: 10485760
  lock_stale_seconds: 86400
`;
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      await fs.writeFile(configPath, customYaml, 'utf8');

      const config = await loadConfig(configPath);
      expect(config.agents.developer.command[0]).toBe('sh');
      expect(config.agents.developer.command).toContain('{prompt_file}');
      expect(config.agents.developer.command[2]).toContain('my-custom-llm');
    });
  });

  // Phase 8F: network config validation
  describe('Phase 8F: network config validation', () => {
    it('accepts valid network config with proxy_mode inherit', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const yaml = `
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
providers:
  claude:
    enabled: true
    network:
      proxy_mode: inherit
`;
      await fs.writeFile(configPath, yaml, 'utf8');
      const config = await loadConfig(configPath);
      expect(config.providers!.claude.network!.proxy_mode).toBe('inherit');
    });

    it('accepts valid network config with proxy_mode none', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const yaml = `
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
providers:
  claude:
    enabled: true
    network:
      proxy_mode: none
`;
      await fs.writeFile(configPath, yaml, 'utf8');
      const config = await loadConfig(configPath);
      expect(config.providers!.claude.network!.proxy_mode).toBe('none');
    });

    it('accepts valid network config with proxy_mode auto and candidate_ports', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const yaml = `
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
providers:
  codex:
    enabled: true
    network:
      proxy_mode: auto
      candidate_ports: [7890, 7897]
`;
      await fs.writeFile(configPath, yaml, 'utf8');
      const config = await loadConfig(configPath);
      expect(config.providers!.codex.network!.proxy_mode).toBe('auto');
      expect(config.providers!.codex.network!.candidate_ports).toEqual([7890, 7897]);
    });

    it('accepts valid network config with proxy_mode custom and proxy_url', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const yaml = `
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
providers:
  opencode:
    enabled: true
    network:
      proxy_mode: custom
      proxy_url: "http://my-proxy:3128"
`;
      await fs.writeFile(configPath, yaml, 'utf8');
      const config = await loadConfig(configPath);
      expect(config.providers!.opencode.network!.proxy_mode).toBe('custom');
      expect(config.providers!.opencode.network!.proxy_url).toBe('http://my-proxy:3128');
    });

    it('rejects invalid proxy_mode', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const yaml = `
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
providers:
  claude:
    enabled: true
    network:
      proxy_mode: invalid_mode
`;
      await fs.writeFile(configPath, yaml, 'utf8');
      await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
    });

    it('rejects custom mode without proxy_url', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const yaml = `
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
providers:
  claude:
    enabled: true
    network:
      proxy_mode: custom
`;
      await fs.writeFile(configPath, yaml, 'utf8');
      await expect(loadConfig(configPath)).rejects.toThrow(ConfigError);
      await expect(loadConfig(configPath)).rejects.toThrow('proxy_url');
    });

    it('accepts provider without network block (backward compat)', async () => {
      const configPath = path.join(tmpDir, 'review-loop.yaml');
      const yaml = `
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
providers:
  claude:
    enabled: true
`;
      await fs.writeFile(configPath, yaml, 'utf8');
      const config = await loadConfig(configPath);
      expect(config.providers!.claude.network).toBeUndefined();
    });

    it('validateNetworkConfig rejects custom mode without proxy_url', () => {
      const config = {
        ...DEFAULT_CONFIG,
        providers: {
          test: {
            enabled: true,
            network: { proxy_mode: 'custom' as const },
          },
        },
      } as unknown as import('../../src/types.js').ReviewLoopConfig;
      expect(() => validateNetworkConfig(config)).toThrow(ConfigError);
      expect(() => validateNetworkConfig(config)).toThrow('proxy_url');
    });

    it('validateNetworkConfig passes for custom mode with proxy_url', () => {
      const config = {
        ...DEFAULT_CONFIG,
        providers: {
          test: {
            enabled: true,
            network: { proxy_mode: 'custom' as const, proxy_url: 'http://proxy:3128' },
          },
        },
      } as unknown as import('../../src/types.js').ReviewLoopConfig;
      expect(() => validateNetworkConfig(config)).not.toThrow();
    });

    it('validateNetworkConfig passes when no providers configured', () => {
      expect(() => validateNetworkConfig(DEFAULT_CONFIG)).not.toThrow();
    });
  });
});