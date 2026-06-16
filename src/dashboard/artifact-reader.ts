/**
 * Dashboard Artifact Reader — reads known .agent/ artifacts into normalized snapshot.
 * Phase 7 §4.2: Data sources
 */

import fs from 'fs-extra';
import path from 'path';
import { parseFrontMatter } from '../artifacts/front-matter.js';
import { StateStore } from '../orchestrator/state-store.js';
import type {
  RunState,
  ProgressData,
  VerificationManifest,
  AuditReportFrontMatter,
  FinalAuditFrontMatter,
  TranscriptEntry,
  Phase,
} from '../types.js';
import { TERMINAL_PHASES } from '../types.js';

/**
 * Dashboard snapshot — normalized view of all .agent/ artifacts.
 */
export interface DashboardSnapshot {
  run_summary: RunSummary | null;
  timeline: AgentTimeline | null;
  verification: VerificationPanel | null;
  audit: AuditPanel | null;
  transcripts: TranscriptPanel | null;
  artifacts_available: string[];
  read_errors: string[];
}

export interface RunSummary {
  project_root: string;
  run_id: string;
  task_slug: string;
  phase: Phase;
  iteration: number;
  max_iterations: number;
  started_at: string;
  last_event_at: string;
  last_event: string;
  terminal_status: Phase | null;
  branch: string;
  base_commit: string;
  final_commit_sha: string | null;
}

export interface AgentTimeline {
  stages: {
    planning: StageStatus;
    developing: StageStatus;
    verifying: StageStatus;
    auditing: StageStatus;
    finalizing: StageStatus;
  };
  terminal_outcome: Phase | null;
}

export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'skipped' | 'unknown';

export interface VerificationPanel {
  available: boolean;
  passed: boolean | null;
  started_at: string | null;
  finished_at: string | null;
  commands: VerificationCommandSummary[];
  error: string | null;
}

export interface VerificationCommandSummary {
  id: string;
  command: string[];
  status: 'success' | 'failed' | 'timeout';
  exit_code: number | null;
  duration_ms: number;
  stdout_path: string | null;
  stderr_path: string | null;
  log_io_error: string | null;
}

export interface AuditPanel {
  available: boolean;
  decision: 'PASS' | 'FAIL' | 'BLOCKED' | 'FAILED' | null;
  iteration: number | null;
  finding_count: number;
  findings: AuditFindingSummary[];
  has_rework_instructions: boolean;
  error: string | null;
}

export interface AuditFindingSummary {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | null;
  summary: string;
}

export interface TranscriptPanel {
  available: boolean;
  files: TranscriptFileSummary[];
  error: string | null;
}

export interface TranscriptFileSummary {
  iteration: number;
  role: 'planner' | 'developer' | 'auditor' | 'final-auditor';
  timestamp: string;
  path: string;
  preview: string;
}

/**
 * Known artifact paths that the dashboard may read.
 * Phase 7 §4.2: Only read known paths, not arbitrary filesystem reads.
 * Note: This list is for documentation purposes. The reader only accesses
 * specific paths needed for each panel.
 */

/**
 * Read all known dashboard artifacts and return a normalized snapshot.
 * Tolerates missing files by returning null/unavailable values instead of crashing.
 */
export async function readDashboardSnapshot(projectRoot: string): Promise<DashboardSnapshot> {
  const agentDir = path.join(projectRoot, '.agent');
  const readErrors: string[] = [];
  const artifactsAvailable: string[] = [];

  // Check if .agent directory exists
  if (!(await fs.pathExists(agentDir))) {
    return {
      run_summary: null,
      timeline: null,
      verification: null,
      audit: null,
      transcripts: null,
      artifacts_available: [],
      read_errors: ['.agent directory not found'],
    };
  }

  // Read state.json
  let state: RunState | null = null;
  try {
    const stateStore = new StateStore(agentDir);
    if (await stateStore.exists()) {
      state = await stateStore.read();
      artifactsAvailable.push('state.json');
    }
  } catch (err) {
    readErrors.push(`Failed to read state.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read progress.json
  let progress: ProgressData | null = null;
  try {
    const progressPath = path.join(agentDir, 'progress.json');
    if (await fs.pathExists(progressPath)) {
      progress = await fs.readJson(progressPath);
      artifactsAvailable.push('progress.json');
    }
  } catch (err) {
    readErrors.push(`Failed to read progress.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read verification manifest
  let verificationManifest: VerificationManifest | null = null;
  let verificationIteration: number | null = null;
  try {
    // Find the latest verification manifest by iterating through iteration directories
    const verificationDir = path.join(agentDir, 'verification');
    if (await fs.pathExists(verificationDir)) {
      const iterations = await fs.readdir(verificationDir);
      const iterationNumbers = iterations
        .filter(name => name.startsWith('iteration-'))
        .map(name => parseInt(name.replace('iteration-', ''), 10))
        .filter(n => !isNaN(n))
        .sort((a, b) => b - a);

      if (iterationNumbers.length > 0) {
        verificationIteration = iterationNumbers[0];
        const manifestPath = path.join(verificationDir, `iteration-${String(verificationIteration).padStart(2, '0')}`, 'manifest.json');
        if (await fs.pathExists(manifestPath)) {
          verificationManifest = await fs.readJson(manifestPath);
          artifactsAvailable.push('verification/manifest.json');
        }
      }
    }
  } catch (err) {
    readErrors.push(`Failed to read verification manifest: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read audit report
  let auditFrontMatter: AuditReportFrontMatter | null = null;
  let auditContent: string | null = null;
  try {
    const auditPath = path.join(agentDir, 'audit-report.md');
    if (await fs.pathExists(auditPath)) {
      auditContent = await fs.readFile(auditPath, 'utf8');
      const { frontMatter } = parseFrontMatter<AuditReportFrontMatter>(auditContent);
      auditFrontMatter = frontMatter;
      artifactsAvailable.push('audit-report.md');
    }
  } catch (err) {
    readErrors.push(`Failed to read audit-report.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read final audit
  let finalAuditFrontMatter: FinalAuditFrontMatter | null = null;
  try {
    const finalAuditPath = path.join(agentDir, 'final-audit.md');
    if (await fs.pathExists(finalAuditPath)) {
      const content = await fs.readFile(finalAuditPath, 'utf8');
      const { frontMatter } = parseFrontMatter<FinalAuditFrontMatter>(content);
      finalAuditFrontMatter = frontMatter;
      artifactsAvailable.push('final-audit.md');
    }
  } catch (err) {
    readErrors.push(`Failed to read final-audit.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if developer handoff exists (for artifact availability)
  try {
    const handoffPath = path.join(agentDir, 'developer-handoff.md');
    if (await fs.pathExists(handoffPath)) {
      artifactsAvailable.push('developer-handoff.md');
    }
  } catch (err) {
    readErrors.push(`Failed to check developer-handoff.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read rework instructions (if exists)
  let hasReworkInstructions = false;
  try {
    const reworkPath = path.join(agentDir, 'rework-instructions.md');
    if (await fs.pathExists(reworkPath)) {
      hasReworkInstructions = true;
      artifactsAvailable.push('rework-instructions.md');
    }
  } catch (err) {
    readErrors.push(`Failed to check rework-instructions.md: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read transcripts
  const transcripts: TranscriptFileSummary[] = [];
  try {
    const transcriptsDir = path.join(agentDir, 'transcripts');
    if (await fs.pathExists(transcriptsDir)) {
      const files = await fs.readdir(transcriptsDir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const filePath = path.join(transcriptsDir, file);
          try {
            const content = await fs.readFile(filePath, 'utf8');
            const { frontMatter } = parseFrontMatter<TranscriptEntry>(content);
            const preview = extractPreview(content);
            transcripts.push({
              iteration: frontMatter.iteration ?? 0,
              role: frontMatter.role ?? 'developer',
              timestamp: frontMatter.finished_at ?? frontMatter.started_at ?? '',
              path: `.agent/transcripts/${file}`,
              preview,
            });
          } catch (err) {
            readErrors.push(`Failed to read transcript ${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (transcripts.length > 0) {
        artifactsAvailable.push('transcripts/');
      }
    }
  } catch (err) {
    readErrors.push(`Failed to read transcripts directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Build run summary
  const runSummary: RunSummary | null = state ? {
    project_root: state.project_root,
    run_id: state.run_id,
    task_slug: state.task_slug,
    phase: state.phase,
    iteration: state.iteration,
    max_iterations: state.max_iterations,
    started_at: state.started_at,
    last_event_at: progress?.last_event_at ?? state.updated_at,
    last_event: progress?.last_event ?? '',
    terminal_status: TERMINAL_PHASES.has(state.phase) ? state.phase : null,
    branch: state.branch,
    base_commit: state.base_commit,
    final_commit_sha: state.final_commit_sha,
  } : null;

  // Build agent timeline
  const timeline: AgentTimeline | null = state ? {
    stages: {
      planning: mapStageStatus(state.stages.planning?.status),
      developing: mapStageStatus(state.stages.developing?.status),
      verifying: mapStageStatus(state.stages.verifying?.status),
      auditing: mapStageStatus(state.stages.auditing?.status),
      finalizing: mapStageStatus(state.stages.finalizing?.status),
    },
    terminal_outcome: TERMINAL_PHASES.has(state.phase) ? state.phase : null,
  } : null;

  // Build verification panel
  const verification: VerificationPanel = {
    available: verificationManifest !== null,
    passed: verificationManifest?.passed ?? null,
    started_at: verificationManifest?.started_at ?? null,
    finished_at: verificationManifest?.finished_at ?? null,
    commands: verificationManifest?.commands.map(cmd => ({
      id: cmd.id,
      command: cmd.argv,
      status: cmd.status,
      exit_code: cmd.exit_code,
      duration_ms: cmd.duration_ms,
      stdout_path: cmd.stdout_path ?? null,
      stderr_path: cmd.stderr_path ?? null,
      log_io_error: cmd.log_io_error ?? null,
    })) ?? [],
    error: verificationManifest === null && state && state.iteration > 0
      ? 'Verification manifest not available'
      : null,
  };

  // Build audit panel
  const auditFindings = extractAuditFindings(auditContent);
  const audit: AuditPanel = {
    available: auditFrontMatter !== null || finalAuditFrontMatter !== null,
    decision: finalAuditFrontMatter?.decision ?? auditFrontMatter?.decision ?? null,
    iteration: auditFrontMatter?.iteration ?? null,
    finding_count: auditFindings.length,
    findings: auditFindings,
    has_rework_instructions: hasReworkInstructions,
    error: auditFrontMatter === null && finalAuditFrontMatter === null && state && state.iteration > 0
      ? 'Audit report not available'
      : null,
  };

  // Build transcript panel
  const transcriptPanel: TranscriptPanel = {
    available: transcripts.length > 0,
    files: transcripts.sort((a, b) => {
      if (a.iteration !== b.iteration) return b.iteration - a.iteration;
      const roleOrder = { planner: 0, developer: 1, auditor: 2, 'final-auditor': 3 };
      return (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99);
    }),
    error: transcripts.length === 0 && state && state.iteration > 0
      ? 'No transcripts available'
      : null,
  };

  return {
    run_summary: runSummary,
    timeline: timeline,
    verification: verification,
    audit: audit,
    transcripts: transcriptPanel,
    artifacts_available: artifactsAvailable,
    read_errors: readErrors,
  };
}

/**
 * Map internal stage status string to dashboard stage status.
 */
function mapStageStatus(status: string | undefined): StageStatus {
  switch (status) {
    case 'pending': return 'pending';
    case 'running': return 'running';
    case 'completed': return 'passed';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

/**
 * Extract a short preview from transcript content.
 * Uses the first few lines of the stdout section.
 */
function extractPreview(content: string): string {
  const stdoutMatch = content.match(/## stdout \(last \d+KB\)\s*\n+```\s*\n?([\s\S]*?)```/);
  if (stdoutMatch && stdoutMatch[1]) {
    const lines = stdoutMatch[1].trim().split('\n').slice(0, 3);
    const preview = lines.join('\n').trim();
    if (preview && preview !== '(empty)') {
      return preview.length > 200 ? preview.slice(0, 200) + '...' : preview;
    }
  }
  return '(no preview available)';
}

/**
 * Extract findings summary from audit report content.
 */
function extractAuditFindings(content: string | null): AuditFindingSummary[] {
  if (!content) return [];

  const findings: AuditFindingSummary[] = [];

  // Match finding blocks like:
  // ### F-001: Finding title
  // **Severity**: critical
  const findingRegex = /### (F-\d+):\s*([^\n]+)\n[\s\S]*?\*\*Severity\*\*:\s*(critical|high|medium|low)/gi;
  let match;
  while ((match = findingRegex.exec(content)) !== null) {
    findings.push({
      id: match[1],
      severity: match[3] as 'critical' | 'high' | 'medium' | 'low',
      summary: match[2].trim(),
    });
  }

  return findings;
}
