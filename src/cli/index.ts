/**
 * CLI entry point — Commander.js setup.
 * Design doc §4
 */
import { Command } from 'commander';
import { initCommand } from './init.js';
import { createStartCommand } from './start.js';
import { createResumeCommand } from './resume.js';
import { createStatusCommand } from './status.js';
import { createCancelCommand } from './cancel.js';
import { createProvidersCommand } from './providers.js';
import { createFollowupsCommand } from './followups.js';
import { createDashboardCommand } from './dashboard.js';
import { createConfigCommand } from './config.js';
import { createCleanCommand } from './clean.js';

export function createCLI(): Command {
  const program = new Command();

  program
    .name('review-loop')
    .description('Codex + Claude Code Goal Review Loop — automated local orchestration')
    .version('0.1.0');

  program.addCommand(initCommand());
  program.addCommand(createStartCommand());
  program.addCommand(createResumeCommand());
  program.addCommand(createStatusCommand());
  program.addCommand(createCancelCommand());
  program.addCommand(createProvidersCommand());
  program.addCommand(createFollowupsCommand());
  program.addCommand(createDashboardCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createCleanCommand());

  return program;
}
