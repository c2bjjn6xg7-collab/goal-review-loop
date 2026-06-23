/**
 * review-loop config agents — view and reconfigure which AI provider/model
 * each role (planner, developer, auditor, final_auditor) uses.
 *
 * Usage:
 *   review-loop config agents                      # interactive
 *   review-loop config agents --set planner=claude  # non-interactive
 *   review-loop config agents --set planner=opencode/ownplan/deepseekv4pro
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { createInterface } from 'node:readline';

const ROLES = ['planner', 'developer', 'auditor', 'final_auditor'] as const;
type Role = typeof ROLES[number];

interface AgentConfig {
  command: string[];
  timeout_seconds: number;
  provider?: string;
}

/** Command templates for each provider + optional model. */
function buildCommand(role: Role, provider: string, model?: string): { command: string[]; providerLabel: string } {
  const heartbeatName = `${provider}-${role}`;
  const heartbeatLine = buildHeartbeatLine(role);

  if (provider === 'opencode') {
    const modelFlag = model ? `--model ${model}` : '';
    return {
      command: [
        'sh', '-c',
        [
          'P=$(cat "$1")',
          heartbeatLine,
          `~/.opencode/bin/opencode run ${modelFlag} --dangerously-skip-permissions --no-replay -- "$P"`,
          'status=$?',
          'kill "$heartbeat_pid" 2>/dev/null || true',
          'wait "$heartbeat_pid" 2>/dev/null || true',
          'exit "$status"',
        ].join('\n'),
        heartbeatName,
        '{prompt_file}',
      ],
      providerLabel: model ? `${provider}/${model}` : provider,
    };
  }

  if (provider === 'claude') {
    return {
      command: [
        'sh', '-c',
        [
          'P=$(cat "$1")',
          heartbeatLine,
          'env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \\',
          '  claude -p --permission-mode bypassPermissions --max-turns 160 -- "$P"',
          'status=$?',
          'kill "$heartbeat_pid" 2>/dev/null || true',
          'wait "$heartbeat_pid" 2>/dev/null || true',
          'exit "$status"',
        ].join('\n'),
        heartbeatName,
        '{prompt_file}',
      ],
      providerLabel: 'claude',
    };
  }

  if (provider === 'codex') {
    return {
      command: ['codex', 'exec', '{prompt_file}'],
      providerLabel: 'codex',
    };
  }

  // Generic fallback
  return {
    command: [provider, '{prompt_file}'],
    providerLabel: provider,
  };
}

function buildHeartbeatLine(role: string): string {
  return [
    `heartbeat_interval="\${REVIEW_LOOP_${role.toUpperCase().replace(/-/g, '_')}_HEARTBEAT_SECONDS:-30}"`,
    '(',
    '  while :; do',
    '    sleep "$heartbeat_interval"',
    `    printf '[review-loop heartbeat] ${role} still running (%%ss idle heartbeat)\\n' "$heartbeat_interval" >&2`,
    '  done',
    ' ) &',
    'heartbeat_pid=$!',
    "trap 'kill \"$heartbeat_pid\" 2>/dev/null || true' EXIT INT TERM",
  ].join('\n');
}

function readConfig(projectRoot: string): Record<string, unknown> | null {
  const configPath = resolve(projectRoot, 'review-loop.yaml');
  if (!existsSync(configPath)) return null;
  const raw = readFileSync(configPath, 'utf8');
  return yaml.load(raw) as Record<string, unknown>;
}

function writeConfig(projectRoot: string, config: Record<string, unknown>): void {
  const configPath = resolve(projectRoot, 'review-loop.yaml');
  writeFileSync(configPath, yaml.dump(config, { indent: 2, lineWidth: 120 }), 'utf8');
}

function getRoleConfig(config: Record<string, unknown>, role: string): AgentConfig | undefined {
  const agents = config.agents as Record<string, AgentConfig> | undefined;
  return agents?.[role];
}

function displayCurrent(config: Record<string, unknown>): void {
  console.log('\nCurrent agent configuration:\n');
  console.log('  Role             Provider    Command preview');
  console.log('  ' + '─'.repeat(70));
  for (const role of ROLES) {
    const ac = getRoleConfig(config, role);
    if (!ac) {
      console.log(`  ${pad(role, 16)} (not configured)`);
      continue;
    }
    const cmdPreview = ac.command.slice(0, 4).join(' ').slice(0, 45);
    const provider = ac.provider ?? detectProvider(ac.command);
    console.log(`  ${pad(role, 16)} ${pad(provider, 10)} ${cmdPreview}...`);
  }
  console.log('');
}

function detectProvider(command: string[]): string {
  const joined = command.join(' ');
  if (joined.includes('opencode')) return 'opencode';
  if (joined.includes('claude')) return 'claude';
  if (joined.includes('codex')) return 'codex';
  return 'unknown';
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function createConfigCommand(): Command {
  const cmd = new Command('config');
  cmd.description('Manage review-loop configuration');

  const agents = new Command('agents');
  agents.description('View or reconfigure agent provider/model bindings');

  agents
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .option('--set <role=provider[/model]>', 'Non-interactive: set role to provider/model')
    .action(async (options) => {
      const projectRoot = resolve(options.projectRoot);
      const config = readConfig(projectRoot);

      if (!config) {
        console.error('Error: review-loop.yaml not found. Run "review-loop init" first.');
        process.exit(1);
      }

      // Non-interactive --set mode
      if (options.set) {
        const eqIdx = options.set.indexOf('=');
        if (eqIdx < 0) {
          console.error('Invalid --set format. Use: --set <role>=<provider[/model]>');
          console.error('Examples:');
          console.error('  --set planner=claude');
          console.error('  --set planner=opencode/ownplan/deepseekv4pro');
          process.exit(1);
        }
        const role = options.set.slice(0, eqIdx).trim();
        const value = options.set.slice(eqIdx + 1).trim();

        if (!ROLES.includes(role as Role)) {
          console.error(`Unknown role "${role}". Valid roles: ${ROLES.join(', ')}`);
          process.exit(1);
        }

        const slashIdx = value.indexOf('/');
        const provider = slashIdx >= 0 ? value.slice(0, slashIdx) : value;
        const model = slashIdx >= 0 ? value.slice(slashIdx + 1) : undefined;

        applyChange(config, role as Role, provider, model);
        writeConfig(projectRoot, config);
        console.log(`✓ ${role} → ${model ? `${provider}/${model}` : provider} updated in review-loop.yaml`);
        return;
      }

      // Interactive mode
      displayCurrent(config);

      const roleChoice = await prompt('Select a role to reconfigure [1-4, q to quit]: ');
      if (roleChoice === 'q' || roleChoice === 'Q' || roleChoice === '') {
        console.log('No changes.');
        return;
      }

      const roleIdx = parseInt(roleChoice, 10) - 1;
      if (isNaN(roleIdx) || roleIdx < 0 || roleIdx >= ROLES.length) {
        console.error('Invalid selection.');
        process.exit(1);
      }
      const role = ROLES[roleIdx];

      console.log('\nAvailable providers:');
      const providers = ['claude', 'codex', 'opencode'];
      providers.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

      const providerChoice = await prompt(`\nSelect provider for ${role} [1-${providers.length}]: `);
      const providerIdx = parseInt(providerChoice, 10) - 1;
      if (isNaN(providerIdx) || providerIdx < 0 || providerIdx >= providers.length) {
        console.error('Invalid selection.');
        process.exit(1);
      }
      const provider = providers[providerIdx];

      let model: string | undefined;
      if (provider === 'opencode') {
        console.log('\nEnter the model ID for opencode (e.g., ownplan/deepseekv4pro):');
        model = await prompt('Model: ');
        if (!model) {
          console.error('Model is required for opencode.');
          process.exit(1);
        }
      }

      applyChange(config, role, provider, model);
      writeConfig(projectRoot, config);
      console.log(`\n✓ ${role} → ${model ? `${provider}/${model}` : provider} updated in review-loop.yaml`);
    });

  cmd.addCommand(agents);
  return cmd;
}

function applyChange(config: Record<string, unknown>, role: Role, provider: string, model?: string): void {
  if (!config.agents || typeof config.agents !== 'object') {
    config.agents = {};
  }
  const agents = config.agents as Record<string, AgentConfig>;
  const existing = agents[role];
  const built = buildCommand(role, provider, model);

  agents[role] = {
    command: built.command,
    timeout_seconds: existing?.timeout_seconds ?? 1800,
    provider,
  };
}
