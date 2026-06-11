/**
 * CLI entry point — Commander.js setup.
 * Design doc §4
 */
import { Command } from 'commander';
import { initCommand } from './init.js';

export function createCLI(): Command {
  const program = new Command();

  program
    .name('review-loop')
    .description('Codex + Claude Code Goal Review Loop — automated local orchestration')
    .version('0.1.0');

  program.addCommand(initCommand());

  // Placeholder commands — will be implemented in later phases
  program
    .command('start')
    .description('Start a new Goal Review Loop run')
    .option('--request <file|string>', 'User requirement source')
    .option('--task-slug <slug>', 'Optional task short name')
    .option('--max-iterations <n>', 'Maximum rework iterations', '3')
    .option('--no-commit', 'Do not auto-commit on pass')
    .option('--tag', 'Create a tag on pass')
    .option('--config <path>', 'Configuration file path')
    .action(() => {
      console.error('start: Not yet implemented (Phase 3)');
      process.exit(1);
    });

  program
    .command('resume')
    .description('Resume an interrupted run')
    .option('--recover-lock', 'Recover a stale lock file')
    .option('--config <path>', 'Configuration file path')
    .action(() => {
      console.error('resume: Not yet implemented (Phase 4)');
      process.exit(1);
    });

  program
    .command('status')
    .description('Show current run status')
    .action(() => {
      console.error('status: Not yet implemented (Phase 5)');
      process.exit(1);
    });

  program
    .command('cancel')
    .description('Cancel the current run')
    .action(() => {
      console.error('cancel: Not yet implemented (Phase 4)');
      process.exit(1);
    });

  return program;
}
