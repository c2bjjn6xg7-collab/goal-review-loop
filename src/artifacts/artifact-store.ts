/**
 * Artifact Store — manages .agent/ directory, file operations, and history archiving.
 * Design doc §6, §7
 */
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'node:crypto';
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
  REWORK_INSTRUCTIONS: 'rework-instructions.md',
} as const;

/**
 * Directories within .agent/
 */
export const ARTIFACT_DIRS = {
  VERIFICATION: 'verification',
  HISTORY: 'history',
  EVIDENCE: 'evidence',
  DEBUG: 'debug',
  TRANSCRIPTS: 'transcripts',
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
  'progress.json',
  'progress.md',
  ARTIFACT_DIRS.VERIFICATION,
  ARTIFACT_DIRS.EVIDENCE,
  ARTIFACT_DIRS.HISTORY,
  ARTIFACT_DIRS.DEBUG,
  ARTIFACT_DIRS.TRANSCRIPTS,
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
    await fs.ensureDir(path.join(this.agentDir, ARTIFACT_DIRS.TRANSCRIPTS));
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
   * Comprehensive iteration archiving — Phase 4 §7.
   * Copies handoff, audit-report, rework-instructions (if exists),
   * plus the full verification/ and evidence/ directories for this iteration.
   */
  async archiveIterationFull(iteration: number): Promise<void> {
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

    // Archive rework instructions (if exists — only for iteration >= 2)
    const reworkPath = this.artifactPath(ARTIFACT_FILES.REWORK_INSTRUCTIONS);
    if (await fs.pathExists(reworkPath)) {
      await fs.copy(reworkPath, path.join(historyDir, ARTIFACT_FILES.REWORK_INSTRUCTIONS));
    }

    // Archive verification directory for this iteration
    const verificationDir = this.verificationDir(iteration);
    if (await fs.pathExists(verificationDir)) {
      const destVerificationDir = path.join(historyDir, ARTIFACT_DIRS.VERIFICATION);
      await fs.copy(verificationDir, destVerificationDir);
    }

    // Archive evidence directory for this iteration
    const evidenceDir = this.evidenceDir(iteration);
    if (await fs.pathExists(evidenceDir)) {
      const destEvidenceDir = path.join(historyDir, ARTIFACT_DIRS.EVIDENCE);
      await fs.copy(evidenceDir, destEvidenceDir);
    }
  }

  /**
   * Check if a history directory for a given iteration already exists.
   */
  async isIterationArchived(iteration: number): Promise<boolean> {
    const historyDir = path.join(
      this.agentDir,
      ARTIFACT_DIRS.HISTORY,
      `iteration-${String(iteration).padStart(2, '0')}`,
    );
    return fs.pathExists(historyDir);
  }

  /**
   * Verify that archiving an iteration is idempotent and safe.
   * If the iteration is already archived, check that the digests of
   * key files match. If they don't, archiving would overwrite different
   * content, which is unsafe.
   *
   * Checks both top-level files (handoff, audit-report, rework-instructions)
   * and subdirectories (verification/, evidence/) for digest mismatches.
   *
   * Returns { safe: true } if no previous archive exists, or if
   * existing archive digests match current files.
   * Returns { safe: false, reason } if digests mismatch.
   */
  async verifyArchiveIdempotent(
    iteration: number,
    currentDigests: Record<string, string>,
  ): Promise<{ safe: boolean; reason?: string }> {
    const historyDir = path.join(
      this.agentDir,
      ARTIFACT_DIRS.HISTORY,
      `iteration-${String(iteration).padStart(2, '0')}`,
    );

    if (!(await fs.pathExists(historyDir))) {
      return { safe: true };
    }

    // Compare digests of archived top-level files against current files
    for (const [fileName, expectedDigest] of Object.entries(currentDigests)) {
      const archivedPath = path.join(historyDir, fileName);
      if (await fs.pathExists(archivedPath)) {
        const content = await fs.readFile(archivedPath, 'utf8');
        const actualDigest = computeFileDigest(content);
        if (actualDigest !== expectedDigest) {
          return {
            safe: false,
            reason: `Archived ${fileName} digest (${actualDigest}) does not match current digest (${expectedDigest}). Archiving would overwrite different content.`,
          };
        }
      }
    }

    // Compare archived verification/ directory against current verification/
    const iterStr = String(iteration).padStart(2, '0');
    const currentVerificationDir = path.join(this.agentDir, ARTIFACT_DIRS.VERIFICATION, `iteration-${iterStr}`);
    const archivedVerificationDir = path.join(historyDir, ARTIFACT_DIRS.VERIFICATION);
    const verificationMismatch = await this.compareDirectoryDigests(
      currentVerificationDir, archivedVerificationDir, `${ARTIFACT_DIRS.VERIFICATION}/iteration-${iterStr}`,
    );
    if (verificationMismatch) {
      return { safe: false, reason: verificationMismatch };
    }

    // Compare archived evidence/ directory against current evidence/
    const currentEvidenceDir = path.join(this.agentDir, ARTIFACT_DIRS.EVIDENCE, `iteration-${iterStr}`);
    const archivedEvidenceDir = path.join(historyDir, ARTIFACT_DIRS.EVIDENCE);
    const evidenceMismatch = await this.compareDirectoryDigests(
      currentEvidenceDir, archivedEvidenceDir, `${ARTIFACT_DIRS.EVIDENCE}/iteration-${iterStr}`,
    );
    if (evidenceMismatch) {
      return { safe: false, reason: evidenceMismatch };
    }

    return { safe: true };
  }

  /**
   * Compare a current directory against an archived directory by computing
   * per-file digests. Returns a reason string if there's a mismatch, or
   * null if they match.
   */
  private async compareDirectoryDigests(
    currentDir: string,
    archivedDir: string,
    label: string,
  ): Promise<string | null> {
    const currentFiles = await this.collectDirectoryDigests(currentDir);
    const archivedFiles = await this.collectDirectoryDigests(archivedDir);

    // Check all archived files still exist with same digest in current
    for (const [relPath, archivedDigest] of Object.entries(archivedFiles)) {
      const currentDigest = currentFiles[relPath];
      if (currentDigest === undefined) {
        return `Archived ${label}/${relPath} no longer exists in current directory. Archiving would lose this file.`;
      }
      if (currentDigest !== archivedDigest) {
        return `Archived ${label}/${relPath} digest (${archivedDigest}) does not match current digest (${currentDigest}). Archiving would overwrite different content.`;
      }
    }

    // Check no new files in current that aren't in archive (would be silently added)
    for (const relPath of Object.keys(currentFiles)) {
      if (archivedFiles[relPath] === undefined) {
        return `Current ${label}/${relPath} does not exist in archive. Archiving would add new file not present in previous archive.`;
      }
    }

    return null;
  }

  /**
   * Recursively collect file digests for a directory.
   * Returns a map of relative paths (posix) to sha256 digests.
   */
  private async collectDirectoryDigests(dirPath: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (!(await fs.pathExists(dirPath))) {
      return result;
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const subDigests = await this.collectDirectoryDigests(fullPath);
        for (const [subPath, digest] of Object.entries(subDigests)) {
          result[`${entry.name}/${subPath}`] = digest;
        }
      } else if (entry.isFile()) {
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          result[entry.name] = computeFileDigest(content);
        } catch {
          // Skip unreadable files (binary, etc.)
        }
      }
    }

    return result;
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
    const agentEntries = LOCAL_ONLY_ARTIFACTS.map((entry) => `.agent/${entry}`);
    // F-702: Common build/test artifact directories that trigger Scope Guard
    // if tracked by git. Only added when they don't already exist in .gitignore.
    const buildArtifacts = [
      'dist/',
      'node_modules/',
      'coverage/',
      '.tsbuildinfo',
    ];
    return [...agentEntries, ...buildArtifacts];
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
        + `# Goal Review Loop - local runtime files and build artifacts\n`
        + newLines.join('\n')
        + '\n';
      await fs.appendFile(gitignorePath, addition, 'utf8');
    }
  }
}

/**
 * Compute SHA-256 digest of a string, prefixed with "sha256:".
 */
function computeFileDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}
