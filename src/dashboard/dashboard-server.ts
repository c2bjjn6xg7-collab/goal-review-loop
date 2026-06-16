/**
 * Dashboard Server — local HTTP server for read-only visual progress dashboard.
 * Phase 7 §4: Visual Progress Dashboard
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readDashboardSnapshot } from './artifact-reader.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4317;

export interface DashboardServerOptions {
  projectRoot: string;
  host?: string;
  port?: number;
  noOpen?: boolean;
}

export interface DashboardServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Start the dashboard server.
 */
export async function startDashboardServer(options: DashboardServerOptions): Promise<DashboardServer> {
  const projectRoot = resolve(options.projectRoot);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  // Security check: reject non-local host binding
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `Network binding rejected: --host must be 127.0.0.1 or localhost. ` +
      `Binding to ${host} requires explicit --allow-network flag (not yet implemented in v1).`
    );
  }

  const url = `http://${host}:${port}`;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      await handleRequest(req, res, projectRoot);
    });

    server.listen(port, host, () => {
      console.log(`Dashboard server started at ${url}`);
      console.log(`Project root: ${projectRoot}`);
      console.log(`Press Ctrl+C to stop`);

      // Try to open browser (best-effort)
      if (!options.noOpen) {
        openBrowser(url).catch(() => {
          // Ignore browser open failures
        });
      }

      resolve({
        url,
        close: () => new Promise((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
      });
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`));
    });
  });
}

/**
 * Handle incoming HTTP request.
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, projectRoot: string): Promise<void> {
  const url = req.url ?? '/';

  try {
    // Route: API endpoints (read-only)
    if (url === '/api/status' && req.method === 'GET') {
      await handleApiStatus(req, res, projectRoot);
    } else if (url === '/api/artifacts' && req.method === 'GET') {
      await handleApiArtifacts(req, res, projectRoot);
    } else if (url === '/api/transcripts' && req.method === 'GET') {
      await handleApiTranscripts(req, res, projectRoot);
    } else if (url === '/api/verification' && req.method === 'GET') {
      await handleApiVerification(req, res, projectRoot);
    } else if (url === '/api/audit' && req.method === 'GET') {
      await handleApiAudit(req, res, projectRoot);
    } else if (url === '/' && req.method === 'GET') {
      await handleDashboardUI(req, res);
    } else {
      // 404 Not Found
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('Request handler error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

/**
 * GET /api/status — Run summary and timeline.
 */
async function handleApiStatus(_req: IncomingMessage, res: ServerResponse, projectRoot: string): Promise<void> {
  const snapshot = await readDashboardSnapshot(projectRoot);

  const response = {
    run_summary: snapshot.run_summary,
    timeline: snapshot.timeline,
    artifacts_available: snapshot.artifacts_available,
    read_errors: snapshot.read_errors,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response, null, 2));
}

/**
 * GET /api/artifacts — List of available artifacts.
 */
async function handleApiArtifacts(_req: IncomingMessage, res: ServerResponse, projectRoot: string): Promise<void> {
  const snapshot = await readDashboardSnapshot(projectRoot);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    artifacts_available: snapshot.artifacts_available,
    read_errors: snapshot.read_errors,
  }, null, 2));
}

/**
 * GET /api/transcripts — Transcript panel data.
 */
async function handleApiTranscripts(_req: IncomingMessage, res: ServerResponse, projectRoot: string): Promise<void> {
  const snapshot = await readDashboardSnapshot(projectRoot);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(snapshot.transcripts, null, 2));
}

/**
 * GET /api/verification — Verification panel data.
 */
async function handleApiVerification(_req: IncomingMessage, res: ServerResponse, projectRoot: string): Promise<void> {
  const snapshot = await readDashboardSnapshot(projectRoot);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(snapshot.verification, null, 2));
}

/**
 * GET /api/audit — Audit panel data.
 */
async function handleApiAudit(_req: IncomingMessage, res: ServerResponse, projectRoot: string): Promise<void> {
  const snapshot = await readDashboardSnapshot(projectRoot);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(snapshot.audit, null, 2));
}

/**
 * GET / — Dashboard HTML UI.
 */
async function handleDashboardUI(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const html = getDashboardHTML();

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

/**
 * Try to open URL in browser (best-effort, platform-specific).
 */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let command: string[];

  if (platform === 'darwin') {
    command = ['open', url];
  } else if (platform === 'win32') {
    command = ['cmd', '/c', 'start', url];
  } else {
    // Linux and others
    command = ['xdg-open', url];
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      stdio: 'ignore',
      detached: true,
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.unref();
    resolve();
  });
}

/**
 * Get the dashboard HTML content.
 * Phase 7 §4.3: Dashboard Views
 */
function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Goal Review Loop Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      margin: 0;
      padding: 0;
      background: #f5f5f5;
      color: #333;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 10px;
    }
    .meta {
      color: #666;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .panel {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .panel h2 {
      font-size: 18px;
      margin-top: 0;
      margin-bottom: 15px;
      border-bottom: 1px solid #eee;
      padding-bottom: 10px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
    }
    .stat-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 600;
      margin-top: 5px;
    }
    .timeline {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
    }
    .stage-box {
      width: 80px;
      height: 40px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
    }
    .stage-box.pending { background: #f0f0f0; color: #999; }
    .stage-box.running { background: #fff3cd; color: #856404; animation: pulse 1.5s infinite; }
    .stage-box.passed { background: #d4edda; color: #155724; }
    .stage-box.failed { background: #f8d7da; color: #721c24; }
    .stage-box.blocked { background: #f8d7da; color: #721c24; }
    .stage-box.cancelled { background: #e2e3e5; color: #383d41; }
    .stage-box.skipped { background: #f0f0f0; color: #999; }
    .stage-box.unknown { background: #f0f0f0; color: #999; }
    .stage-label { font-size: 10px; color: #666; text-transform: uppercase; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .arrow { font-size: 18px; color: #ccc; }
    .command-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 15px;
    }
    .command-item {
      background: #f9f9f9;
      padding: 10px;
      border-radius: 4px;
    }
    .command-id {
      font-size: 11px;
      color: #999;
      margin-bottom: 5px;
    }
    .command-code {
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 13px;
      background: #e9ecef;
      padding: 5px 8px;
      border-radius: 3px;
      margin-bottom: 5px;
    }
    .command-meta {
      font-size: 12px;
      color: #666;
      display: flex;
      gap: 15px;
    }
    .finding {
      background: #f9f9f9;
      padding: 10px;
      border-radius: 4px;
      margin-bottom: 10px;
    }
    .finding-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 5px;
    }
    .finding-id {
      font-weight: 600;
      font-size: 13px;
    }
    .finding-severity {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
    }
    .finding-severity.critical { background: #f8d7da; color: #721c24; }
    .finding-severity.high { background: #fff3cd; color: #856404; }
    .finding-severity.medium { background: #e2e3e5; color: #383d41; }
    .finding-severity.low { background: #d4edda; color: #155724; }
    .transcript-item {
      background: #f9f9f9;
      padding: 10px;
      border-radius: 4px;
      margin-bottom: 10px;
    }
    .transcript-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 5px;
    }
    .transcript-role {
      font-weight: 600;
    }
    .transcript-iter {
      font-size: 12px;
      color: #666;
    }
    .transcript-preview {
      font-size: 12px;
      color: #666;
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      white-space: pre-wrap;
      max-height: 60px;
      overflow: hidden;
    }
    .action-commands {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .action-command {
      background: #f9f9f9;
      padding: 10px;
      border-radius: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .action-code {
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 13px;
    }
    .copy-btn {
      background: #007bff;
      color: white;
      border: none;
      padding: 5px 15px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .copy-btn:hover { background: #0056b3; }
    .status-badge {
      display: inline-block;
      padding: 5px 15px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 600;
    }
    .status-badge.PASSED { background: #d4edda; color: #155724; }
    .status-badge.FAILED { background: #f8d7da; color: #721c24; }
    .status-badge.BLOCKED { background: #f8d7da; color: #721c24; }
    .status-badge.CANCELLED { background: #e2e3e5; color: #383d41; }
    .error-message {
      color: #721c24;
      background: #f8d7da;
      padding: 10px;
      border-radius: 4px;
      font-size: 13px;
    }
    .unavailable {
      color: #999;
      font-style: italic;
    }
    .refresh-info {
      font-size: 12px;
      color: #666;
      margin-top: 20px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Goal Review Loop Dashboard</h1>
    <div class="meta" id="meta">Loading...</div>

    <div class="panel" id="summary-panel">
      <h2>Run Summary</h2>
      <div class="grid" id="summary-grid">
        <div class="unavailable">No run in progress</div>
      </div>
    </div>

    <div class="panel" id="timeline-panel">
      <h2>Agent Timeline</h2>
      <div id="timeline">
        <div class="unavailable">No timeline available</div>
      </div>
    </div>

    <div class="panel" id="verification-panel">
      <h2>Verification</h2>
      <div id="verification">
        <div class="unavailable">No verification data available</div>
      </div>
    </div>

    <div class="panel" id="audit-panel">
      <h2>Audit</h2>
      <div id="audit">
        <div class="unavailable">No audit data available</div>
      </div>
    </div>

    <div class="panel" id="transcripts-panel">
      <h2>Transcripts</h2>
      <div id="transcripts">
        <div class="unavailable">No transcripts available</div>
      </div>
    </div>

    <div class="panel" id="actions-panel">
      <h2>Actions</h2>
      <div class="action-commands">
        <div class="action-command">
          <code class="action-code">review-loop status --watch</code>
          <button class="copy-btn" onclick="copyCommand('review-loop status --watch')">Copy</button>
        </div>
        <div class="action-command">
          <code class="action-code">review-loop resume</code>
          <button class="copy-btn" onclick="copyCommand('review-loop resume')">Copy</button>
        </div>
        <div class="action-command">
          <code class="action-code">review-loop cancel</code>
          <button class="copy-btn" onclick="copyCommand('review-loop cancel')">Copy</button>
        </div>
      </div>
    </div>

    <div class="refresh-info" id="refresh-info">Last refresh: Never</div>
  </div>

  <script>
    let pollInterval = null;
    const POLL_MS = 2000;

    async function fetchData() {
      try {
        const [statusRes, verificationRes, auditRes, transcriptsRes] = await Promise.all([
          fetch('/api/status'),
          fetch('/api/verification'),
          fetch('/api/audit'),
          fetch('/api/transcripts')
        ]);

        const status = await statusRes.json();
        const verification = await verificationRes.json();
        const audit = await auditRes.json();
        const transcripts = await transcriptsRes.json();

        renderDashboard(status, verification, audit, transcripts);

        const now = new Date().toLocaleTimeString();
        document.getElementById('refresh-info').textContent = 'Last refresh: ' + now;

        // Stop polling if terminal
        if (status.run_summary && status.run_summary.terminal_status) {
          stopPolling();
        }
      } catch (err) {
        console.error('Failed to fetch data:', err);
      }
    }

    function renderDashboard(status, verification, audit, transcripts) {
      renderMeta(status);
      renderSummary(status);
      renderTimeline(status);
      renderVerification(verification);
      renderAudit(audit);
      renderTranscripts(transcripts);
    }

    function renderMeta(status) {
      const meta = document.getElementById('meta');
      if (status.run_summary) {
        const rs = status.run_summary;
        meta.innerHTML =
          'Project: ' + rs.project_root + '<br>' +
          'Run ID: ' + rs.run_id + ' | Task: ' + rs.task_slug;
      } else {
        meta.textContent = 'No active run';
      }
    }

    function renderSummary(status) {
      const grid = document.getElementById('summary-grid');
      if (!status.run_summary) {
        grid.innerHTML = '<div class="unavailable">No run in progress</div>';
        return;
      }

      const rs = status.run_summary;
      grid.innerHTML =
        '<div>' +
          '<div class="stat-label">Phase</div>' +
          '<div class="stat-value">' + escapeHtml(rs.phase) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="stat-label">Iteration</div>' +
          '<div class="stat-value">' + rs.iteration + ' / ' + rs.max_iterations + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="stat-label">Started</div>' +
          '<div class="stat-value" style="font-size:16px">' + formatTime(rs.started_at) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="stat-label">Last Event</div>' +
          '<div class="stat-value" style="font-size:16px">' + formatTime(rs.last_event_at) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="stat-label">Branch</div>' +
          '<div class="stat-value" style="font-size:16px">' + escapeHtml(rs.branch) + '</div>' +
        '</div>' +
        (rs.terminal_status ?
          '<div>' +
            '<div class="stat-label">Status</div>' +
            '<div class="stat-value"><span class="status-badge ' + rs.terminal_status + '">' + rs.terminal_status + '</span></div>' +
          '</div>' : '');
    }

    function renderTimeline(status) {
      const container = document.getElementById('timeline');
      if (!status.timeline) {
        container.innerHTML = '<div class="unavailable">No timeline available</div>';
        return;
      }

      const stages = status.timeline.stages;
      const terminal = status.timeline.terminal_outcome;
      const order = ['planning', 'developing', 'verifying', 'auditing', 'finalizing'];

      let html = '<div class="timeline">';
      for (const key of order) {
        const stage = stages[key];
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        html +=
          '<div class="stage">' +
            '<div class="stage-box ' + stage + '">' + label + '</div>' +
          '</div>' +
          '<div class="arrow">→</div>';
      }

      if (terminal) {
        html +=
          '<div class="stage">' +
            '<div class="stage-box ' + terminal.toLowerCase() + '">' + terminal + '</div>' +
          '</div>';
      } else {
        html += '<div class="stage"><div class="stage-box pending">...</div></div>';
      }

      html += '</div>';
      container.innerHTML = html;
    }

    function renderVerification(verification) {
      const container = document.getElementById('verification');
      if (!verification.available) {
        container.innerHTML = '<div class="unavailable">' + (verification.error || 'No verification data available') + '</div>';
        return;
      }

      let html =
        '<div style="margin-bottom:15px">' +
          '<strong>Overall:</strong> ' +
          (verification.passed ? '<span style="color:#155724">PASSED</span>' : '<span style="color:#721c24">FAILED</span>') +
          ' | Duration: ' + (verification.finished_at && verification.started_at
            ? Math.round((new Date(verification.finished_at) - new Date(verification.started_at)) / 1000) + 's'
            : 'N/A') +
        '</div>';

      if (verification.commands.length > 0) {
        html += '<div class="command-grid">';
        for (const cmd of verification.commands) {
          html +=
            '<div class="command-item">' +
              '<div class="command-id">' + escapeHtml(cmd.id) + '</div>' +
              '<div class="command-code">' + escapeHtml(cmd.command.join(' ')) + '</div>' +
              '<div class="command-meta">' +
                '<span>' + cmd.status + '</span>' +
                '<span>Exit: ' + (cmd.exit_code ?? 'N/A') + '</span>' +
                '<span>' + cmd.duration_ms + 'ms</span>' +
              '</div>' +
            '</div>';
        }
        html += '</div>';
      }

      container.innerHTML = html;
    }

    function renderAudit(audit) {
      const container = document.getElementById('audit');
      if (!audit.available) {
        container.innerHTML = '<div class="unavailable">' + (audit.error || 'No audit data available') + '</div>';
        return;
      }

      let html =
        '<div style="margin-bottom:15px">' +
          '<strong>Decision:</strong> <span class="status-badge ' + audit.decision + '">' + audit.decision + '</span>' +
          ' | Findings: ' + audit.finding_count +
          (audit.has_rework_instructions ? ' | <span style="color:#856404">Rework Required</span>' : '') +
        '</div>';

      if (audit.findings.length > 0) {
        html += '<div>';
        for (const f of audit.findings) {
          html +=
            '<div class="finding">' +
              '<div class="finding-header">' +
                '<span class="finding-id">' + escapeHtml(f.id) + '</span>' +
                '<span class="finding-severity ' + (f.severity || '') + '">' + (f.severity || 'N/A') + '</span>' +
              '</div>' +
              '<div>' + escapeHtml(f.summary) + '</div>' +
            '</div>';
        }
        html += '</div>';
      }

      container.innerHTML = html;
    }

    function renderTranscripts(transcripts) {
      const container = document.getElementById('transcripts');
      if (!transcripts.available) {
        container.innerHTML = '<div class="unavailable">' + (transcripts.error || 'No transcripts available') + '</div>';
        return;
      }

      let html = '';
      for (const t of transcripts.files) {
        html +=
          '<div class="transcript-item">' +
            '<div class="transcript-header">' +
              '<span class="transcript-role">' + escapeHtml(t.role) + '</span>' +
              '<span class="transcript-iter">Iteration ' + t.iteration + '</span>' +
            '</div>' +
            '<div class="transcript-preview">' + escapeHtml(t.preview) + '</div>' +
          '</div>';
      }
      container.innerHTML = html;
    }

    function startPolling() {
      if (pollInterval) return;
      pollInterval = setInterval(fetchData, POLL_MS);
      fetchData();
    }

    function stopPolling() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }

    function copyCommand(cmd) {
      navigator.clipboard.writeText(cmd).catch(() => {});
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function formatTime(iso) {
      if (!iso) return 'N/A';
      try {
        return new Date(iso).toLocaleTimeString();
      } catch {
        return iso;
      }
    }

    // Start polling on load
    startPolling();
  </script>
</body>
</html>`;
}
