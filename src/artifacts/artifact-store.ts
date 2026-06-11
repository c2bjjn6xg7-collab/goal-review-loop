/**
 * Artifact Store — manages .agent/ directory, file operations, and history archiving.
 * Design doc §6, §7
 */
import fs from 'fs-extra';
import path from 'path';
import { atomicWriteFile } from '../runtime/atomic-file.js';

export class ArtifactStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

/**
 * Artifact names — Design doc §6
 */
export const ARTIFACT_FILES = {
  PLAN: 'plan.md',
  GOAL: 'GOAL.md',
  HANDOFF: 'developer-handoff.md',
  AUDIT_REPORT: 'audit-report.md',
  FINAL_AUDIT: 'final-audit.md',
  ITERATION_LOG: 'iteration-log.md',
  STATE: 'state.json',
  RUN_LOCK: 'run.lock',
} as const;

/**
 * Directories within .agent/
 */
export const ARTIFACT_DIRS = {
  VERIFICATION: 'verification',
  HISTORY: 'history',
  EVIDENCE: 'evidence',
  DEBUG: 'debug',
} as const;

/**
 * Files that enter the final Git commit — Design doc §6.1
 */
export const VERSIONED_ARTIFACTS = [
  ARTIFACT_FILES.PLAN,
  ARTIFACT_FILES.GOAL,
  ARTIFACT_FILES.HANDOFF,
  ARTIFACT_FILES.AUDIT_REPORT,
  ARTIFACT_FILES.FINAL_AUDIT,
] as const;

/**
 * Files that are local-only (added to .gitignore) — Design doc §6.2
 */
export const LOCAL_ONLY_ARTIFACTS = [
  ARTIFACT_FILES.STATE,
  ARTIFACT_FILES.RUN_LOCK,
  ARTIFACT_FILES.ITERATION_LOG,
  ARTIFACT_DIRS.VERIFICATION,
  ARTIFACT_DIRS.EVIDENCE,
  ARTIFACT_DIRS.HISTORY,
  ARTIFACT_DIRS.DEBUG,
] as const;

/**
 * Artifact Store — manages the .agent/ directory.
 */
export class ArtifactStore {
  readonly agentDir: string;

  constructor(private readonly projectRoot: string) {
    this.agentDir = path.join(projectRoot, '.agent');
  }

  /**
   * Initialize the .agent/ directory structure.
   */
  async init(): Promise<void> {
    await fs.ensureDir(this.agentDir);
    await fs.ensureDir(path.join(this.agentDir, ARTIFACT_DIRS.VERIFICATION));
    await fs.ensureDir(path.join(this.agentDir, ARTIFACT_DIRS.HISTORY));
    await fs.ensureDir(path.join(this.agentDir, ARTIFACT_DIRS.EVIDENCE));
    await fs.ensureDir(path.join(this.agentDir, ARTIFACT_DIRS.DEBUG));
  }

  /**
   * Check if the .agent/ directory exists.
   */
  async exists(): Promise<boolean> {
    return fs.pathExists(this.agentDir);
  }

  /**
   * Get the full path to an artifact file.
   */
  artifactPath(name: string): string {
    return path.join(this.agentDir, name);
  }

  /**
   * Read an artifact file.
   */
  async read(name: string): Promise<string> {
    const filePath = this.artifactPath(name);
    if (!(await fs.pathExists(filePath))) {
      throw new ArtifactStoreError(`Artifact not found: ${name}`);
    }
    return fs.readFile(filePath, 'utf8');
  }

  /**
   * Write an artifact file atomically.
   */
  async write(name: string, content: string): Promise<void> {
    const filePath = this.artifactPath(name);
    await atomicWriteFile(filePath, content);
  }

  /**
   * Check if an artifact file exists.
   */
  async has(name: string): Promise<boolean> {
    return fs.pathExists(this.artifactPath(name));
  }

  /**
   * Archive the current iteration's handoff and audit to history.
   * Design doc §8.6: "进入下一轮前，将上一轮 handoff 和 audit 归档到 history/"
   */
  async archiveIteration(iteration: number): Promise<void> {
    const historyDir = path.join(
      this.agentDir,
      ARTIFACT_DIRS.HISTORY,
      `iteration-${String(iteration).padStart(2, '0')}`,
    );
    await fs.ensureDir(historyDir);

    // Archive handoff
    const handoffPath = this.artifactPath(ARTIFACT_FILES.HANDOFF);
    if (await fs.pathExists(handoffPath)) {
      await fs.copy(handoffPath, path.join(historyDir, ARTIFACT_FILES.HANDOFF));
    }

    // Archive audit report
    const auditPath = this.artifactPath(ARTIFACT_FILES.AUDIT_REPORT);
    if (await fs.pathExists(auditPath)) {
      await fs.copy(auditPath, path.join(historyDir, ARTIFACT_FILES.AUDIT_REPORT));
    }
  }

  /**
   * Append to the iteration log.
   * Design doc §8.6: "只允许 Artifact Store 追加，不允许模型重写"
   */
  async appendIterationLog(entry: string): Promise<void> {
    const logPath = this.artifactPath(ARTIFACT_FILES.ITERATION_LOG);
    const timestamp = new Date().toISOString();
    const line = `${timestamp} | ${entry}\n`;
    await fs.appendFile(logPath, line, 'utf8');
  }

  /**
   * Get the verification directory for a specific iteration.
   */
  verificationDir(iteration: number): string {
    return path.join(
      this.agentDir,
      ARTIFACT_DIRS.VERIFICATION,
      `iteration-${String(iteration).padStart(2, '0')}`,
    );
  }

  /**
   * Get the evidence directory for a specific iteration.
   */
  evidenceDir(iteration: number): string {
    return path.join(
      this.agentDir,
      ARTIFACT_DIRS.EVIDENCE,
      `iteration-${String(iteration).padStart(2, '0')}`,
    );
  }

  /**
   * Generate .gitignore entries for local-only artifacts.
   * Design doc §6.2
   */
  gitignoreEntries(): string[] {
    return LOCAL_ONLY_ARTIFACTS.map((entry) => `.agent/${entry}`);
  }

  /**
   * Update .gitignore with local-only artifact entries.
   * Does not overwrite existing content — only adds missing entries.
   */
  async updateGitignore(): Promise<void> {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    let existingContent = '';

    if (await fs.pathExists(gitignorePath)) {
      existingContent = await fs.readFile(gitignorePath, 'utf8');
    }

    const entries = this.gitignoreEntries();
    const existingLines = new Set(existingContent.split('\n'));
    const newLines = entries.filter((entry) => !existingLines.has(entry));

    if (newLines.length > 0) {
      const addition = (existingContent.endsWith('\n') || existingContent === '' ? '' : '\n')
        + `# Goal Review Loop - local runtime files\n`
        + newLines.join('\n')
        + '\n';
      await fs.appendFile(gitignorePath, addition, 'utf8');
    }
  }
}
