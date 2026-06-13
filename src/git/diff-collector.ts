import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { runGit, runGitRaw } from './git-manager.js';
import { parsePorcelainStatus, parseNameStatus, parseNumstat } from './git-parsers.js';
import { atomicWriteJSON } from '../runtime/atomic-file.js';
import { validateChangedFiles, validateUntrackedFiles, validateDiffMetadata } from '../artifacts/json-schemas.js';
import type {
  ChangedFile,
  ChangedFilesSchema,
  UntrackedFileEvidence,
  UntrackedFilesSchema,
  DiffMetadata,
  FileStatus,
} from '../types.js';

const DEFAULT_MAX_EVIDENCE_BYTES = 1024 * 1024;

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function isPathSafe(filePath: string, projectRoot: string): boolean {
  const resolved = path.resolve(projectRoot, filePath);
  return resolved.startsWith(projectRoot + path.sep) || resolved === projectRoot;
}

function isBinaryFile(buffer: Buffer): boolean {
  const chunk = buffer.subarray(0, 8192);
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === 0) return true;
  }
  return false;
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export interface CollectDiffOptions {
  projectRoot: string;
  baseCommit: string;
  iteration: number;
  maxEvidenceBytes?: number;
}

export interface CollectDiffResult {
  changedFiles: ChangedFilesSchema;
  untrackedFiles: UntrackedFilesSchema;
  diffMetadata: DiffMetadata;
  diffDigest: string;
  trackedDiff: Buffer;
}

export async function collectDiff(options: CollectDiffOptions): Promise<CollectDiffResult> {
  const { projectRoot, baseCommit, maxEvidenceBytes = DEFAULT_MAX_EVIDENCE_BYTES } = options;

  const statusResult = await runGit(['status', '--porcelain=v1', '-uall'], projectRoot);
  if (statusResult.exit_code !== 0) {
    throw new Error(`Failed to get git status: ${statusResult.stderr}`);
  }

  const nameStatusResult = await runGit(
    ['diff', '--name-status', '--find-renames', '-z', baseCommit, '--', '.'],
    projectRoot,
  );
  if (nameStatusResult.exit_code !== 0) {
    throw new Error(`Failed to get diff name-status: ${nameStatusResult.stderr}`);
  }

  const numstatResult = await runGit(
    ['diff', '--numstat', '--find-renames', '-z', baseCommit, '--', '.'],
    projectRoot,
  );
  if (numstatResult.exit_code !== 0) {
    throw new Error(`Failed to get diff numstat: ${numstatResult.stderr}`);
  }

  const diffResult = await runGitRaw(
    ['diff', '--binary', '--find-renames', baseCommit, '--', '.'],
    projectRoot,
  );
  if (diffResult.exit_code !== 0) {
    throw new Error(`Failed to get diff: ${diffResult.stderr}`);
  }

  const statusEntries = parsePorcelainStatus(statusResult.stdout);
  const nameStatusEntries = parseNameStatus(nameStatusResult.stdout);
  const numstatEntries = parseNumstat(numstatResult.stdout);

  const numstatMap = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const entry of numstatEntries) {
    numstatMap.set(toPosixPath(entry.path), {
      additions: entry.additions,
      deletions: entry.deletions,
    });
  }

  const trackedFiles: ChangedFile[] = [];
  const untrackedFiles: UntrackedFileEvidence[] = [];

  for (const entry of nameStatusEntries) {
    const filePath = toPosixPath(entry.path);
    const stats = numstatMap.get(filePath);

    let status: FileStatus;
    if (entry.status.startsWith('A')) status = 'added';
    else if (entry.status.startsWith('D')) status = 'deleted';
    else if (entry.status.startsWith('R')) status = 'renamed';
    else status = 'modified';

    trackedFiles.push({
      path: filePath,
      status,
      old_path: entry.orig_path ? toPosixPath(entry.orig_path) : undefined,
      tracked: true,
      additions: stats?.additions ?? null,
      deletions: stats?.deletions ?? null,
    });
  }

  const untrackedEntries = statusEntries.filter((e) => e.x === '?' && e.y === '?');

  for (const entry of untrackedEntries) {
    const filePath = entry.path;
    const fullPath = path.join(projectRoot, filePath);

    if (!isPathSafe(filePath, projectRoot)) {
      throw new Error(`Path escape detected: ${filePath}`);
    }

    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Untracked symlinks are not allowed: ${filePath}`);
    }

    if (stat.size > maxEvidenceBytes) {
      const buffer = await fs.readFile(fullPath);
      untrackedFiles.push({
        path: filePath,
        size_bytes: stat.size,
        sha256: sha256(buffer),
        is_text: false,
        has_content: false,
        content: null,
        omitted_reason: 'too_large',
      });
      continue;
    }

    const buffer = await fs.readFile(fullPath);
    const isBinary = isBinaryFile(buffer);

    if (isBinary) {
      untrackedFiles.push({
        path: filePath,
        size_bytes: stat.size,
        sha256: sha256(buffer),
        is_text: false,
        has_content: false,
        content: null,
        omitted_reason: 'binary',
      });
    } else {
      untrackedFiles.push({
        path: filePath,
        size_bytes: stat.size,
        sha256: sha256(buffer),
        is_text: true,
        has_content: true,
        content: buffer.toString('utf8'),
      });
    }
  }

  untrackedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const allChangedFiles: ChangedFile[] = [
    ...trackedFiles,
    ...untrackedFiles.map((f) => ({
      path: f.path,
      status: 'untracked' as FileStatus,
      tracked: false,
      additions: null,
      deletions: null,
    })),
  ];
  allChangedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const changedFilesSchema: ChangedFilesSchema = {
    schema_version: 1,
    base_commit: baseCommit,
    files: allChangedFiles,
  };

  const untrackedFilesSchema: UntrackedFilesSchema = {
    schema_version: 1,
    files: untrackedFiles,
  };

  const diffDigest = computeDiffDigest(baseCommit, diffResult.stdout, untrackedFiles, changedFilesSchema);

  const diffMetadata: DiffMetadata = {
    schema_version: 1,
    base_commit: baseCommit,
    generated_at: new Date().toISOString(),
    tracked_diff_summary: {
      files_changed: trackedFiles.length,
      insertions: trackedFiles.reduce((sum, f) => sum + (f.additions ?? 0), 0),
      deletions: trackedFiles.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    },
    changed_files_summary: {
      total: allChangedFiles.length,
      added: allChangedFiles.filter((f) => f.status === 'added').length,
      modified: allChangedFiles.filter((f) => f.status === 'modified').length,
      deleted: allChangedFiles.filter((f) => f.status === 'deleted').length,
      renamed: allChangedFiles.filter((f) => f.status === 'renamed').length,
      untracked: untrackedFiles.length,
    },
    untracked_files_summary: {
      total: untrackedFiles.length,
      text_files: untrackedFiles.filter((f) => f.is_text).length,
      binary_files: untrackedFiles.filter((f) => !f.is_text).length,
    },
    diff_digest: diffDigest,
  };

  return {
    changedFiles: changedFilesSchema,
    untrackedFiles: untrackedFilesSchema,
    diffMetadata,
    diffDigest,
    trackedDiff: diffResult.stdout,
  };
}

function computeDiffDigest(
  baseCommit: string,
  trackedDiff: Buffer,
  untrackedFiles: UntrackedFileEvidence[],
  changedFiles: ChangedFilesSchema,
): string {
  const hash = crypto.createHash('sha256');
  hash.update(baseCommit);
  hash.update(trackedDiff);

  for (const file of untrackedFiles) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }

  const stableJson = stableStringify(changedFiles);
  hash.update(stableJson);

  return hash.digest('hex');
}

function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

export async function writeDiffArtifacts(
  projectRoot: string,
  iteration: number,
  result: CollectDiffResult,
): Promise<void> {
  if (!validateChangedFiles(result.changedFiles)) {
    throw new Error(`Invalid changed-files.json: ${JSON.stringify(validateChangedFiles.errors)}`);
  }
  if (!validateUntrackedFiles(result.untrackedFiles)) {
    throw new Error(`Invalid untracked-files.json: ${JSON.stringify(validateUntrackedFiles.errors)}`);
  }
  if (!validateDiffMetadata(result.diffMetadata)) {
    throw new Error(`Invalid diff-metadata.json: ${JSON.stringify(validateDiffMetadata.errors)}`);
  }

  const evidenceDir = path.join(projectRoot, '.agent', 'evidence', `iteration-${String(iteration).padStart(2, '0')}`);
  await fs.ensureDir(evidenceDir);

  await fs.writeFile(path.join(evidenceDir, 'tracked.diff'), result.trackedDiff);

  await atomicWriteJSON(path.join(evidenceDir, 'changed-files.json'), result.changedFiles);
  await atomicWriteJSON(path.join(evidenceDir, 'untracked-files.json'), result.untrackedFiles);
  await atomicWriteJSON(path.join(evidenceDir, 'diff-metadata.json'), result.diffMetadata);
}
