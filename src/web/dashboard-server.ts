/**
 * Phase 9 R2A — Read-only dashboard HTTP server.
 *
 * Routes:
 *   GET /            -> inline HTML page
 *   GET /api/events  -> JSON snapshot built from events.jsonl
 *   *                -> 404 / 405 JSON
 *
 * Bound to 127.0.0.1 only; never writes to .agent.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { DashboardEventSource } from './event-source.js';
import { renderDashboardHtml } from './dashboard-html.js';

export interface DashboardServerOptions {
  projectRoot: string;
}

export interface DashboardServer {
  start(port?: number): Promise<number>;
  stop(): Promise<void>;
  port(): number | null;
}

const HOST = '127.0.0.1';

export function createDashboardServer(opts: DashboardServerOptions): DashboardServer {
  const source = new DashboardEventSource({ projectRoot: opts.projectRoot });
  const html = renderDashboardHtml();
  let server: http.Server | null = null;
  let listeningPort: number | null = null;

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed', message: `Method ${method} not allowed` });
      return;
    }

    if (pathOnly === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(html);
      return;
    }

    if (pathOnly === '/api/events') {
      try {
        const snapshot = await source.getSnapshot();
        sendJson(res, 200, snapshot);
      } catch (err) {
        sendJson(res, 500, {
          error: 'snapshot_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found', path: pathOnly });
  };

  return {
    async start(port = 0): Promise<number> {
      if (server) return listeningPort ?? 0;
      server = http.createServer((req, res) => {
        handler(req, res).catch((err) => {
          if (!res.headersSent) {
            sendJson(res, 500, {
              error: 'internal_error',
              message: err instanceof Error ? err.message : String(err),
            });
          } else {
            try { res.end(); } catch { /* ignore */ }
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server?.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server?.off('error', onError);
          resolve();
        };
        server!.once('error', onError);
        server!.once('listening', onListening);
        server!.listen(port, HOST);
      });

      const addr = server.address() as AddressInfo | string | null;
      if (addr && typeof addr === 'object') {
        listeningPort = addr.port;
      } else {
        listeningPort = port;
      }
      return listeningPort;
    },

    async stop(): Promise<void> {
      if (!server) return;
      const s = server;
      server = null;
      listeningPort = null;
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    },

    port(): number | null {
      return listeningPort;
    },
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
