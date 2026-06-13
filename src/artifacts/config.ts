/**
 * Configuration loader — parses and validates review-loop.yaml.
 * Design doc §5
 */
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { Ajv } from 'ajv';
import path from 'path';
import type { ReviewLoopConfig } from '../types.js';

const CONFIG_SCHEMA = {
  type: 'object',
  required: ['version', 'agents', 'loop', 'git', 'runtime'],
  properties: {
    version: { type: 'number', const: 1 },
    agents: {
      type: 'object',
      required: ['planner', 'developer', 'auditor'],
      properties: {
        planner: { $ref: '#/$defs/agentConfig' },
        developer: { $ref: '#/$defs/agentConfig' },
        auditor: { $ref: '#/$defs/agentConfig' },
      },
      additionalProperties: false,
    },
    loop: {
      type: 'object',
      required: ['max_iterations'],
      properties: {
        max_iterations: { type: 'number', minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
    git: {
      type: 'object',
      required: [
        'require_repository', 'require_head', 'require_clean_worktree',
        'branch_template', 'commit_on_pass', 'commit_template',
        'create_tag', 'tag_template', 'push',
      ],
      properties: {
        require_repository: { type: 'boolean' },
        require_head: { type: 'boolean' },
        require_clean_worktree: { type: 'boolean' },
        branch_template: { type: 'string', minLength: 1 },
        commit_on_pass: { type: 'boolean' },
        commit_template: { type: 'string', minLength: 1 },
        create_tag: { type: 'boolean' },
        tag_template: { type: 'string', minLength: 1 },
        push: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    runtime: {
      type: 'object',
      required: ['kill_grace_seconds', 'max_log_bytes', 'lock_stale_seconds'],
      properties: {
        kill_grace_seconds: { type: 'number', minimum: 1 },
        max_log_bytes: { type: 'number', minimum: 1024 },
        lock_stale_seconds: { type: 'number', minimum: 60 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
  $defs: {
    agentConfig: {
      type: 'object',
      required: ['command', 'timeout_seconds'],
      properties: {
        command: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
        timeout_seconds: { type: 'number', minimum: 60 },
      },
      additionalProperties: false,
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateConfig = ajv.compile(CONFIG_SCHEMA);

export class ConfigError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Default configuration — safe values per Design doc §5
 */
export const DEFAULT_CONFIG: ReviewLoopConfig = {
  version: 1,
  agents: {
    planner: {
      command: ['codex', 'exec', '{prompt_file}'],
      timeout_seconds: 1800,
    },
    developer: {
      command: ['sh', '-lc', 'exec claude -p --permission-mode acceptEdits < "$1"', 'claude-developer', '{prompt_file}'],
      timeout_seconds: 3600,
    },
    auditor: {
      command: ['codex', 'exec', '{prompt_file}'],
      timeout_seconds: 1800,
    },
  },
  loop: {
    max_iterations: 3,
  },
  git: {
    require_repository: true,
    require_head: true,
    require_clean_worktree: true,
    branch_template: 'agent/{run_id}-{task_slug}',
    commit_on_pass: true,
    commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
    create_tag: false,
    tag_template: 'agent-{run_id}-pass',
    push: false,
  },
  runtime: {
    kill_grace_seconds: 10,
    max_log_bytes: 10485760, // 10MB
    lock_stale_seconds: 86400, // 24h
  },
};

/**
 * Load and validate configuration from a YAML file.
 */
export async function loadConfig(configPath: string): Promise<ReviewLoopConfig> {
  if (!(await fs.pathExists(configPath))) {
    throw new ConfigError(`Configuration file not found: ${configPath}`);
  }

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const data = yaml.load(raw);

    if (typeof data !== 'object' || data === null) {
      throw new ConfigError('Configuration must be a YAML object');
    }

    if (!validateConfig(data)) {
      const errors = validateConfig.errors
        ?.map((e: {instancePath: string; message?: string}) => `${e.instancePath || '/'}: ${e.message}`)
        .join('; ');
      throw new ConfigError(`Invalid configuration: ${errors}`);
    }

    const config = data as ReviewLoopConfig;

    // Enforce MVP constraints — Design doc §5.1
    validateMvpConstraints(config);

    return config;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Failed to load configuration: ${err}`, err);
  }
}

/**
 * Load configuration with fallback to defaults.
 * If the config file doesn't exist, returns defaults.
 * F-309 fix: accepts optional explicit config path from --config CLI flag.
 */
export async function loadConfigWithDefaults(
  projectRoot: string,
  explicitConfigPath?: string,
): Promise<ReviewLoopConfig> {
  // If an explicit config path was provided via --config, use it
  if (explicitConfigPath) {
    const resolvedPath = path.resolve(explicitConfigPath);
    // Security: ensure the config path doesn't escape reasonable bounds
    if (!resolvedPath.endsWith('.yaml') && !resolvedPath.endsWith('.yml')) {
      throw new ConfigError(`Config file must be a YAML file: ${resolvedPath}`);
    }
    if (!(await fs.pathExists(resolvedPath))) {
      throw new ConfigError(`Config file not found: ${resolvedPath}`);
    }
    return loadConfig(resolvedPath);
  }

  const configPath = path.join(projectRoot, 'review-loop.yaml');

  if (!(await fs.pathExists(configPath))) {
    return DEFAULT_CONFIG;
  }

  return loadConfig(configPath);
}

/**
 * Generate a sample review-loop.yaml file.
 */
export function generateSampleConfig(): string {
  return yaml.dump(DEFAULT_CONFIG, {
    lineWidth: -1,
    noRefs: true,
  });
}

/**
 * Validate that git.push is false in MVP.
 * Design doc §5.1: "git.push 在 MVP 中即使配置为 true 也应拒绝"
 */
export function validateMvpConstraints(config: ReviewLoopConfig): void {
  if (config.git.push) {
    throw new ConfigError(
      'git.push is not supported in MVP. Remote push is explicitly excluded from the current scope.',
    );
  }
}
