/**
 * Phase 9 R2A — Read-only dashboard HTTP server.
 * Phase 9 R2B — Adds SSE push channel at `GET /api/events/stream`.
 *
 * Routes:
 *   GET /                    -> inline HTML page
 *   GET /api/events          -> JSON snapshot built from events.jsonl
 *   GET /api/events/stream   -> text/event-stream push of new events
 *   *                        -> 404 / 405 JSON
 *
 * Bound to 127.0.0.1 only; never writes to .agent.
 */
import http from 'node:http';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { DashboardEventSource, resolveRunIdFromAgentDir } from './event-source.js';
import { renderDashboardHtml } from './dashboard-html.js';
import { EventStore } from '../runtime/event-store.js';

export interface DashboardServerOptions {
  projectRoot: string;
  /** SSE tail poll interval in ms. Default 500. */
  ssePollMs?: number;
  /** SSE heartbeat interval in ms. Default 15 000. */
  sseHeartbeatMs?: number;
}

export interface DashboardServer {
  start(port?: number): Promise<number>;
  stop(): Promise<void>;
  port(): number | null;
}

const HOST = '127.0.0.1';
const DEFAULT_SSE_POLL_MS = 500;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

interface ActiveSseConnection {
  cleanup(): void;
}

export function createDashboardServer(opts: DashboardServerOptions): DashboardServer {
  const source = new DashboardEventSource({ projectRoot: opts.projectRoot });
  const html = renderDashboardHtml();
  const agentDir = path.join(opts.projectRoot, '.agent');
  const ssePollMs = opts.ssePollMs ?? DEFAULT_SSE_POLL_MS;
  const sseHeartbeatMs = opts.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const activeConnections = new Set<ActiveSseConnection>();
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

    if (pathOnly === '/api/events/stream') {
      await handleSseConnection(req, res);
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

  async function handleSseConnection(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers so the client sees the response before the first event.
    res.flushHeaders?.();

    const runId = (await resolveRunIdFromAgentDir(agentDir)) ?? 'unknown';
    const store = new EventStore(agentDir, runId);
    let lastSeq = 0;
    try {
      lastSeq = await store.getLastSequence();
    } catch {
      lastSeq = 0;
    }

    // Hello frame: first non-comment frame must announce the run id.
    res.write(`event: hello\ndata: ${JSON.stringify({ run_id: runId })}\n\n`);

    let pollTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let polling = false;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      activeConnections.delete(connection);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    };

    const connection: ActiveSseConnection = { cleanup };
    activeConnections.add(connection);

    const poll = async (): Promise<void> => {
      if (closed || polling) return;
      polling = true;
      try {
        const events = await store.readSince(lastSeq);
        if (closed) return;
        for (const ev of events) {
          if (closed) return;
          try {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          } catch {
            cleanup();
            return;
          }
          if (ev.seq > lastSeq) lastSeq = ev.seq;
        }
      } catch {
        // Swallow per-tick errors so a mid-write file does not kill the
        // connection. The next tick will retry.
      } finally {
        polling = false;
      }
    };

    pollTimer = setInterval(() => {
      void poll();
    }, ssePollMs);

    heartbeatTimer = setInterval(() => {
      if (closed) return;
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        cleanup();
      }
    }, sseHeartbeatMs);

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

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
      // End every active SSE response so server.close() is not held open by
      // long-lived sockets.
      for (const conn of [...activeConnections]) {
        try { conn.cleanup(); } catch { /* ignore */ }
      }
      activeConnections.clear();
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
