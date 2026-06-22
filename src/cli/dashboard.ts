/**
 * Phase 9 R2A — `review-loop dashboard` CLI subcommand.
 *
 * Starts the read-only dashboard server bound to 127.0.0.1 and prints the
 * actual listening port. Shuts down cleanly on SIGINT/SIGTERM.
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { createDashboardServer } from '../web/dashboard-server.js';

function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`--port must be a non-negative integer, got "${value}"`);
  }
  const n = Number(value);
  if (n < 0 || n > 65535) {
    throw new Error(`--port must be between 0 and 65535, got ${n}`);
  }
  return n;
}

export function createDashboardCommand(): Command {
  const cmd = new Command('dashboard');
  cmd
    .description('Start the read-only Phase 9 web dashboard for events.jsonl')
    .option('--port <number>', 'Port to bind on 127.0.0.1 (0 = random)', parsePort, 0)
    .option('--project-root <path>', 'Project root directory', process.cwd())
    .action(async (options) => {
      try {
        await runDashboard({
          port: options.port,
          projectRoot: options.projectRoot,
        });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
  return cmd;
}

export interface RunDashboardOptions {
  port: number;
  projectRoot: string;
}

export async function runDashboard(opts: RunDashboardOptions): Promise<void> {
  const projectRoot = resolve(opts.projectRoot);
  const server = createDashboardServer({ projectRoot });
  const port = await server.start(opts.port);
  console.log(`Dashboard listening on http://127.0.0.1:${port}`);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, stopping dashboard…`);
    try {
      await server.stop();
    } catch (err) {
      console.error(`Error stopping dashboard: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}
