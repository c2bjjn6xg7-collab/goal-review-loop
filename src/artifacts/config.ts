/**
 * Configuration loader — parses and validates review-loop.yaml.
 * Design doc §5
 */
import fs from 'fs-extra';
import yaml from 'js-yaml';
import { Ajv } from 'ajv';
import path from 'path';
import type { ReviewLoopConfig, ProviderNetworkConfig, ProviderConfig, FeedbackRole, FeedbackType } from '../types.js';


/**
 * Phase 10: default per-role feedback-type allowlist (Design doc §9).
 */
export const DEFAULT_FEEDBACK_ALLOWED_TYPES: Record<FeedbackRole, FeedbackType[]> = {
  planner: ['clarify', 'risk_note', 'followup_task'],
  developer: ['scope_concern', 'verification_suggestion', 'risk_note', 'followup_task'],
  auditor: ['risk_note', 'followup_task'],
  final_auditor: ['risk_note', 'followup_task'],
};

/**
 * Phase 10: default feedback_protocol configuration.
 */
export const DEFAULT_FEEDBACK_PROTOCOL = {
  enabled: true,
  self_correction: false,
  max_blocks_per_document: 10,
  allowed_types_per_role: DEFAULT_FEEDBACK_ALLOWED_TYPES,
};

const CONFIG_SCHEMA = {
  type: 'object',
  required: ['version', 'agents', 'loop', 'git', 'runtime'],
  properties: {
    version: { type: 'number', const: 1 },
    providers: {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/providerConfig' },
    },
    agents: {
      type: 'object',
      required: ['planner', 'developer', 'auditor'],
      properties: {
        planner: { $ref: '#/$defs/agentConfig' },
        developer: { $ref: '#/$defs/agentConfig' },
        auditor: { $ref: '#/$defs/agentConfig' },
        final_auditor: { $ref: '#/$defs/agentConfig' },
      },
      additionalProperties: false,
    },
    loop: {
      type: 'object',
      required: ['max_iterations'],
      properties: {
        max_iterations: { type: 'number', minimum: 1, maximum: 10 },
        archive_history: { type: 'boolean' },
        stop_on_infrastructure_error: { type: 'boolean' },
        max_consecutive_failures: { type: 'integer', minimum: 1, maximum: 10 },
        max_agent_retries: { type: 'integer', minimum: 1, maximum: 10 },
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
        cancel_grace_seconds: { type: 'number', minimum: 1 },
        agent_idle_timeout_seconds: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
    feedback_protocol: {
      type: 'object',
      required: ['enabled', 'self_correction', 'max_blocks_per_document', 'allowed_types_per_role'],
      properties: {
        enabled: { type: 'boolean' },
        self_correction: { type: 'boolean' },
        max_blocks_per_document: { type: 'integer', minimum: 1, maximum: 50 },
        allowed_types_per_role: {
          type: 'object',
          required: ['planner', 'developer', 'auditor', 'final_auditor'],
          properties: {
            planner: { type: 'array', items: { type: 'string' } },
            developer: { type: 'array', items: { type: 'string' } },
            auditor: { type: 'array', items: { type: 'string' } },
            final_auditor: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    parallel: { $ref: '#/$defs/parallelConfig' },
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
        provider: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    providerConfig: {
      type: 'object',
      required: ['enabled'],
      properties: {
        enabled: { type: 'boolean' },
        command_template: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
        prompt_transport: { type: 'string', enum: ['stdin', 'prompt_file', 'argv'] },
        health_check: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
        permission_mode: { type: 'string' },
        allowed_tools: { type: 'string' },
        transcript_mode: { type: 'string', enum: ['stdout_stderr', 'jsonl', 'none'] },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        network: { $ref: '#/$defs/networkConfig' },
      },
      additionalProperties: false,
    },
    networkConfig: {
      type: 'object',
      required: ['proxy_mode'],
      properties: {
        proxy_mode: { type: 'string', enum: ['inherit', 'none', 'auto', 'custom'] },
        candidate_ports: {
          type: 'array',
          items: { type: 'number', minimum: 1 },
        },
        proxy_url: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    parallelConfig: {
      type: 'object',
      required: ['enabled', 'max_parallel_workers'],
      properties: {
        enabled: { type: 'boolean' },
        max_parallel_workers: { type: 'integer', minimum: 1, maximum: 16 },
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
    final_auditor: {
      command: ['codex', 'exec', '{prompt_file}'],
      timeout_seconds: 1800,
    },
  },
  loop: {
    max_iterations: 3,
    archive_history: true,
    stop_on_infrastructure_error: true,
    max_consecutive_failures: 3,
    max_agent_retries: 3,
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
    cancel_grace_seconds: 10,
    agent_idle_timeout_seconds: 480,
  },
  feedback_protocol: {
    enabled: true,
    self_correction: false,
    max_blocks_per_document: 10,
    allowed_types_per_role: DEFAULT_FEEDBACK_ALLOWED_TYPES,
  },
  parallel: {
    enabled: false,
    max_parallel_workers: 1,
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

    // Phase 4 backward compat: fill in new fields with defaults if missing
    if (config.loop.archive_history === undefined) {
      config.loop.archive_history = DEFAULT_CONFIG.loop.archive_history;
    }
    if (config.loop.stop_on_infrastructure_error === undefined) {
      config.loop.stop_on_infrastructure_error = DEFAULT_CONFIG.loop.stop_on_infrastructure_error;
    }
    if (config.loop.max_consecutive_failures === undefined) {
      config.loop.max_consecutive_failures = DEFAULT_CONFIG.loop.max_consecutive_failures;
    }
    if (config.loop.max_agent_retries === undefined) {
      config.loop.max_agent_retries = DEFAULT_CONFIG.loop.max_agent_retries;
    }
    if (config.runtime.cancel_grace_seconds === undefined) {
      config.runtime.cancel_grace_seconds = DEFAULT_CONFIG.runtime.cancel_grace_seconds;
    }
    // Phase 8D P6.5: fill in agent_idle_timeout_seconds default if missing.
    if (config.runtime.agent_idle_timeout_seconds === undefined) {
      config.runtime.agent_idle_timeout_seconds = DEFAULT_CONFIG.runtime.agent_idle_timeout_seconds;
    }

    // Phase 5 backward compat: fill in final_auditor with auditor config if missing
    if (!config.agents.final_auditor) {
      config.agents.final_auditor = config.agents.auditor;
    }

    // Phase 10 backward compat: fill in feedback_protocol with defaults if missing
    if (!config.feedback_protocol) {
      config.feedback_protocol = {
        enabled: DEFAULT_FEEDBACK_PROTOCOL.enabled,
        self_correction: DEFAULT_FEEDBACK_PROTOCOL.self_correction,
        max_blocks_per_document: DEFAULT_FEEDBACK_PROTOCOL.max_blocks_per_document,
        allowed_types_per_role: DEFAULT_FEEDBACK_ALLOWED_TYPES,
      };
    } else {
      if (config.feedback_protocol.enabled === undefined) {
        config.feedback_protocol.enabled = DEFAULT_FEEDBACK_PROTOCOL.enabled;
      }
      if (config.feedback_protocol.self_correction === undefined) {
        config.feedback_protocol.self_correction = DEFAULT_FEEDBACK_PROTOCOL.self_correction;
      }
      if (config.feedback_protocol.max_blocks_per_document === undefined) {
        config.feedback_protocol.max_blocks_per_document = DEFAULT_FEEDBACK_PROTOCOL.max_blocks_per_document;
      }
      if (!config.feedback_protocol.allowed_types_per_role) {
        config.feedback_protocol.allowed_types_per_role = DEFAULT_FEEDBACK_ALLOWED_TYPES;
      }
    }

    // Phase 10: validate allowed_types_per_role values are legal FeedbackType subset
    validateFeedbackTypes(config);

    // Phase 8D P5 Round 1: fill parallel defaults when absent. The schema
    // requires both leaf fields when `parallel` is provided, so we don't
    // patch a partial object here — only the entire default block.
    if (!config.parallel) {
      config.parallel = {
        enabled: DEFAULT_CONFIG.parallel!.enabled,
        max_parallel_workers: DEFAULT_CONFIG.parallel!.max_parallel_workers,
      };
    }

    // Enforce MVP constraints — Design doc §5.1
    validateMvpConstraints(config);

    // Phase 8F: Validate network config — custom mode requires proxy_url
    validateNetworkConfig(config);

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

const LEGAL_FEEDBACK_TYPES: ReadonlySet<string> = new Set<FeedbackType>([
  'clarify', 'followup_task', 'risk_note', 'scope_concern', 'verification_suggestion',
]);
const LEGAL_FEEDBACK_ROLES: ReadonlySet<string> = new Set<FeedbackRole>([
  'planner', 'developer', 'auditor', 'final_auditor',
]);

/**
 * Phase 10: Validate feedback_protocol.allowed_types_per_role.
 * Each role key must be legal; each type value must be a legal FeedbackType.
 */
export function validateFeedbackTypes(config: ReviewLoopConfig): void {
  const { allowed_types_per_role } = config.feedback_protocol;
  for (const role of Object.keys(allowed_types_per_role)) {
    if (!LEGAL_FEEDBACK_ROLES.has(role)) {
      throw new ConfigError(
        `feedback_protocol.allowed_types_per_role has unknown role "${role}"`,
      );
    }
    const types = allowed_types_per_role[role as FeedbackRole];
    for (const t of types) {
      if (!LEGAL_FEEDBACK_TYPES.has(t)) {
        throw new ConfigError(
          `feedback_protocol.allowed_types_per_role["${role}"] has unknown feedback type "${t}"`,
        );
      }
    }
  }
  // Ensure all four roles present
  for (const r of ['planner', 'developer', 'auditor', 'final_auditor']) {
    if (!allowed_types_per_role[r as FeedbackRole]) {
      throw new ConfigError(
        `feedback_protocol.allowed_types_per_role missing role "${r}"`,
      );
    }
  }
}

/**
 * Phase 8F: Validate network config for all providers.
 * custom mode requires a non-empty proxy_url.
 */
export function validateNetworkConfig(config: ReviewLoopConfig): void {
  if (!config.providers) return;
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const network = (providerConfig as ProviderConfig & { network?: ProviderNetworkConfig }).network;
    if (!network) continue;
    if (network.proxy_mode === 'custom' && (!network.proxy_url || network.proxy_url.length === 0)) {
      throw new ConfigError(
        `Provider "${providerId}" has proxy_mode "custom" but no proxy_url is configured. A non-empty proxy_url is required for custom proxy mode.`,
      );
    }
  }
}
