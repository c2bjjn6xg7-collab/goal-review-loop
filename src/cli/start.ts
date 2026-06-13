/**
 * CLI `start` command — launches the first-round orchestration loop.
 * Phase 3 §11: review-loop start
 *
 * Parameters:
 * --request <text>          User request text (mutually exclusive with --request-file)
 * --request-file <path>     Path to user request file
 * --task-slug <slug>        Optional task short name
 * --max-iterations <n>      Max rework iterations (default from config)
 * --config <path>           Config file path
 * --no-commit               Parse but don't commit (Phase 3 always no-commit)
 * --tag                     Parse but don't tag (Phase 3 never tags)
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { runOrchestrator, type OrchestratorResult } from '../orchestrator/run-orchestrator.js';

export function createStartCommand(): Command {
  const cmd = new Command('start');

  cmd
    .description('Start a new review-loop run')
    .option('--request <text>', 'User request text')
    .option('--request-file <path>', 'Path to user request file')
    .option('--task-slug <slug>', 'Optional task short name')
    .option('--max-iterations <n>', 'Max rework iterations', parseInt)
    .option('--config <path>', 'Config file path')
    .option('--no-commit', 'Do not commit on pass (Phase 3: always no-commit)')
    .option('--tag', 'Create tag on pass (Phase 3: never tags)')
    .action(async (options) => {
      try {
        const result = await executeStart(options);
        process.exit(result.exit_code);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(3);
      }
    });

  return cmd;
}

export async function executeStart(options: StartOptions): Promise<OrchestratorResult> {
  // Validate request input — must have exactly one of --request or --request-file
  if (options.request && options.requestFile) {
    throw new Error('Cannot specify both --request and --request-file');
  }
  if (!options.request && !options.requestFile) {
    throw new Error('Must specify either --request or --request-file');
  }

  // Resolve request text
  let request: string;
  if (options.requestFile) {
    const requestPath = resolve(options.requestFile);
    if (!existsSync(requestPath)) {
      throw new Error(`Request file not found: ${requestPath}`);
    }
    request = readFileSync(requestPath, 'utf8').trim();
  } else {
    request = options.request!.trim();
  }

  if (!request) {
    throw new Error('Request cannot be empty');
  }

  // Validate task-slug — no path characters
  if (options.taskSlug && /[/\\:*?"<>|]/.test(options.taskSlug)) {
    throw new Error(`Invalid task-slug "${options.taskSlug}": must not contain path characters`);
  }

  // Validate max-iterations
  if (options.maxIterations !== undefined && (isNaN(options.maxIterations) || options.maxIterations < 1)) {
    throw new Error('max-iterations must be a positive integer');
  }

  // Run orchestrator
  const projectRoot = process.cwd();
  const result = await runOrchestrator({
    project_root: projectRoot,
    request,
    task_slug: options.taskSlug,
    max_iterations: options.maxIterations,
    config_path: options.config,
    no_commit: options.noCommit ?? true,
    tag: options.tag ?? false,
  });

  // Output result
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Run:        ${result.run_id}`);
  console.log(`  Phase:      ${result.phase}`);
  console.log(`  Branch:     ${result.branch}`);
  if (result.audit_decision) {
    console.log(`  Audit:      ${result.audit_decision}`);
  }
  console.log(`  Next:       ${result.next_action}`);
  console.log(`  Message:    ${result.message}`);
  if (result.artifact_paths.length > 0) {
    console.log(`  Artifacts:  ${result.artifact_paths.join(', ')}`);
  }
  console.log('  ⚠ Not yet committed — Phase 5 handles finalization');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  return result;
}

export interface StartOptions {
  request?: string;
  requestFile?: string;
  taskSlug?: string;
  maxIterations?: number;
  config?: string;
  noCommit?: boolean;
  tag?: boolean;
}
