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
 * --no-commit               Skip commit on pass (default: commit on pass)
 * --tag                     Create local tag on pass (default: no tag)
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
    .option('--no-commit', 'Do not commit on pass')
    .option('--tag', 'Create local tag on pass')
    .option('--watch', 'Display progress updates during execution')
    .option('--watch-interval <ms>', 'Watch polling interval in ms', parseInt, 2000)
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

  // Set up watch mode polling if --watch is enabled
  let watchInterval: ReturnType<typeof setInterval> | undefined;
  let lastPhase = '';
  if (options.watch) {
    const progressPath = resolve(projectRoot, '.agent', 'progress.json');
    const interval = options.watchInterval ?? 2000;
    watchInterval = setInterval(() => {
      try {
        if (existsSync(progressPath)) {
          const data = JSON.parse(readFileSync(progressPath, 'utf8'));
          const currentKey = `${data.phase}:${data.iteration}:${data.last_event}`;
          if (currentKey !== lastPhase) {
            lastPhase = currentKey;
            console.log(`[${data.phase}] iter=${data.iteration} ${data.last_event}`);
          }
        }
      } catch { /* progress.json may not exist yet */ }
    }, interval);
  }

  try {
    const result = await runOrchestrator({
      project_root: projectRoot,
      request,
      task_slug: options.taskSlug,
      max_iterations: options.maxIterations,
      config_path: options.config,
      // Commander maps `--no-commit` to `options.commit = false` (default `true`).
      // Reading `options.noCommit` would always be `undefined` and silently fall
      // back to the config default, so the flag would never take effect.
      no_commit: options.commit === false,
      tag: options.tag ?? false,
    });

    if (watchInterval) clearInterval(watchInterval);

    // Output result
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log(`  Run:        ${result.run_id}`);
    console.log(`  Phase:      ${result.phase}`);
    console.log(`  Branch:     ${result.branch}`);
    if (result.audit_decision) {
      console.log(`  Audit:      ${result.audit_decision}`);
    }
    if (result.commit_sha) {
      console.log(`  Commit:     ${result.commit_sha.slice(0, 8)}`);
    }
    if (result.commit_skipped) {
      console.log(`  Commit:     skipped (${result.skip_reason})`);
    }
    if (result.tag_name) {
      console.log(`  Tag:        ${result.tag_name} (${result.tag_created ? 'created' : 'not created'})`);
    }
    console.log(`  Next:       ${result.next_action}`);
    console.log(`  Message:    ${result.message}`);
    if (result.artifact_paths.length > 0) {
      console.log(`  Artifacts:  ${result.artifact_paths.join(', ')}`);
    }
    console.log('═══════════════════════════════════════════════════');
    console.log('');

    return result;
  } catch (err) {
    if (watchInterval) clearInterval(watchInterval);
    throw err;
  }
}

export interface StartOptions {
  request?: string;
  requestFile?: string;
  taskSlug?: string;
  maxIterations?: number;
  config?: string;
  /** Commander `--no-commit` populates this as `false`; default is `true`. */
  commit?: boolean;
  tag?: boolean;
  watch?: boolean;
  watchInterval?: number;
}
