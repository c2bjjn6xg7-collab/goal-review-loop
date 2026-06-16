/**
 * Dashboard Command — start local visual progress dashboard.
 * Phase 7 §4.6: CLI Options
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { startDashboardServer } from '../dashboard/dashboard-server.js';

interface DashboardCommandOptions {
  port?: number;
  host?: string;
  open?: boolean;
  projectRoot: string;
}

export interface ResolvedDashboardCommandOptions {
  projectRoot: string;
  host: string;
  port: number;
  noOpen: boolean;
}

export function createDashboardCommand(): Command {
  const cmd = new Command('dashboard');
  cmd
    .description('Start local visual progress dashboard')
    .option('--port <number>', 'Port to listen on (default: 4317)', parseDashboardPort)
    .option('--host <host>', 'Host to bind to (default: 127.0.0.1)', '127.0.0.1')
    .option('--no-open', 'Do not open browser automatically')
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action(async (options) => {
      try {
        const resolvedOptions = resolveDashboardCommandOptions(options);

        console.log('Starting dashboard...');
        console.log('');

        const server = await startDashboardServer({
          projectRoot: resolvedOptions.projectRoot,
          host: resolvedOptions.host,
          port: resolvedOptions.port,
          noOpen: resolvedOptions.noOpen,
        });

        console.log('');
        console.log('Dashboard URL:', server.url);
        console.log('');
        console.log('Press Ctrl+C to stop');

        // Keep the process running
        process.on('SIGINT', async () => {
          console.log('\nShutting down dashboard...');
          await server.close();
          process.exit(0);
        });

        // Wait indefinitely
        await new Promise(() => {});
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  return cmd;
}

export function parseDashboardPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function resolveDashboardCommandOptions(
  options: DashboardCommandOptions,
): ResolvedDashboardCommandOptions {
  return {
    projectRoot: resolve(options.projectRoot),
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 4317,
    // Commander stores negated flags as the positive option name.
    noOpen: options.open === false,
  };
}
