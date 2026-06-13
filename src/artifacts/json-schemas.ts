import { Ajv, type Schema } from 'ajv';

const ajv = new Ajv({ allErrors: true });

const SHA256_PATTERN = '^[a-f0-9]{64}$';
const GIT_SHA_PATTERN = '^[a-f0-9]{40}$|^[a-f0-9]{64}$';
const SAFE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

function isValidISO8601(str: string): boolean {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  const h = parseInt(hour, 10);
  const min = parseInt(minute, 10);
  const s = parseInt(second, 10);
  if (m < 1 || m > 12) return false;
  if (d < 1) return false;
  if (h > 23) return false;
  if (min > 59) return false;
  if (s > 59) return false;
  
  const daysInMonth = new Date(y, m, 0).getDate();
  if (d > daysInMonth) return false;
  
  return true;
}

ajv.addFormat('iso8601', {
  type: 'string',
  validate: isValidISO8601,
});

ajv.addFormat('safe-relative-path', {
  type: 'string',
  validate: (str: string) => {
    if (str.length === 0) return false;
    if (str.includes('\\')) return false;
    if (str.startsWith('/')) return false;
    if (str.startsWith('./')) return false;
    if (str.includes('//')) return false;
    
    if (/^[a-zA-Z]:/.test(str)) return false;
    
    if (str === '.') return true;
    
    const segments = str.split('/');
    for (const seg of segments) {
      if (seg === '..') return false;
      if (seg.length === 0) return false;
    }
    
    return true;
  },
});

ajv.addFormat('safe-file-path', {
  type: 'string',
  validate: (str: string) => {
    if (str.length === 0) return false;
    if (str === '.') return false;
    if (str.includes('\\')) return false;
    if (str.startsWith('/')) return false;
    if (str.startsWith('./')) return false;
    if (str.includes('//')) return false;
    
    if (/^[a-zA-Z]:/.test(str)) return false;
    
    const segments = str.split('/');
    for (const seg of segments) {
      if (seg === '.' || seg === '..') return false;
      if (seg.length === 0) return false;
    }
    
    return true;
  },
});

ajv.addFormat('non-empty-string', {
  type: 'string',
  validate: (str: string) => str.length > 0,
});

const changedFileSchema: Schema = {
  type: 'object',
  properties: {
    path: { type: 'string', format: 'safe-file-path' },
    status: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed', 'untracked'] },
    old_path: { type: 'string', format: 'safe-file-path' },
    tracked: { type: 'boolean' },
    additions: { type: ['integer', 'null'], minimum: 0 },
    deletions: { type: ['integer', 'null'], minimum: 0 },
  },
  required: ['path', 'status', 'tracked', 'additions', 'deletions'],
  additionalProperties: false,
};

export const changedFilesSchema: Schema = {
  type: 'object',
  properties: {
    schema_version: { type: 'number', const: 1 },
    base_commit: { type: 'string', pattern: GIT_SHA_PATTERN },
    files: { type: 'array', items: changedFileSchema },
  },
  required: ['schema_version', 'base_commit', 'files'],
  additionalProperties: false,
};

const untrackedFileSchema: Schema = {
  type: 'object',
  properties: {
    path: { type: 'string', format: 'safe-file-path' },
    size_bytes: { type: 'integer', minimum: 0 },
    sha256: { type: 'string', pattern: SHA256_PATTERN },
    is_text: { type: 'boolean' },
    has_content: { type: 'boolean' },
    content: { type: ['string', 'null'] },
    omitted_reason: { type: 'string', enum: ['binary', 'too_large', 'symlink_escape'] },
  },
  required: ['path', 'size_bytes', 'sha256', 'is_text', 'has_content', 'content'],
  additionalProperties: false,
};

export const untrackedFilesSchema: Schema = {
  type: 'object',
  properties: {
    schema_version: { type: 'number', const: 1 },
    files: { type: 'array', items: untrackedFileSchema },
  },
  required: ['schema_version', 'files'],
  additionalProperties: false,
};

export const diffMetadataSchema: Schema = {
  type: 'object',
  properties: {
    schema_version: { type: 'number', const: 1 },
    base_commit: { type: 'string', pattern: GIT_SHA_PATTERN },
    generated_at: { type: 'string', format: 'iso8601' },
    tracked_diff_summary: {
      type: 'object',
      properties: {
        files_changed: { type: 'integer', minimum: 0 },
        insertions: { type: 'integer', minimum: 0 },
        deletions: { type: 'integer', minimum: 0 },
      },
      required: ['files_changed', 'insertions', 'deletions'],
      additionalProperties: false,
    },
    changed_files_summary: {
      type: 'object',
      properties: {
        total: { type: 'integer', minimum: 0 },
        added: { type: 'integer', minimum: 0 },
        modified: { type: 'integer', minimum: 0 },
        deleted: { type: 'integer', minimum: 0 },
        renamed: { type: 'integer', minimum: 0 },
        untracked: { type: 'integer', minimum: 0 },
      },
      required: ['total', 'added', 'modified', 'deleted', 'renamed', 'untracked'],
      additionalProperties: false,
    },
    untracked_files_summary: {
      type: 'object',
      properties: {
        total: { type: 'integer', minimum: 0 },
        text_files: { type: 'integer', minimum: 0 },
        binary_files: { type: 'integer', minimum: 0 },
      },
      required: ['total', 'text_files', 'binary_files'],
      additionalProperties: false,
    },
    diff_digest: { type: 'string', pattern: SHA256_PATTERN },
  },
  required: ['schema_version', 'base_commit', 'generated_at', 'tracked_diff_summary', 'changed_files_summary', 'untracked_files_summary', 'diff_digest'],
  additionalProperties: false,
};

export const scopeReportSchema: Schema = {
  type: 'object',
  properties: {
    schema_version: { type: 'number', const: 2 },
    passed: { type: 'boolean' },
    allowed: { type: 'array', items: { type: 'string', format: 'safe-file-path' } },
    excluded_orchestrator_owned: { type: 'array', items: { type: 'string', format: 'safe-file-path' } },
    excluded_dependency_cache: { type: 'array', items: { type: 'string', format: 'safe-file-path' } },
    denied: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', format: 'safe-file-path' },
          reason: { type: 'string', enum: ['system_protected', 'disallowed_change', 'outside_allowed_changes', 'unauthorized_test_deletion'] },
        },
        required: ['path', 'reason'],
        additionalProperties: false,
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
          path: { type: 'string', format: 'safe-file-path' },
        },
        required: ['code', 'message'],
        additionalProperties: false,
      },
    },
  },
  required: ['schema_version', 'passed', 'allowed', 'excluded_orchestrator_owned', 'excluded_dependency_cache', 'denied', 'warnings'],
  additionalProperties: false,
};

const verificationResultSchema: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: SAFE_ID_PATTERN },
    argv: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    cwd: { type: 'string', format: 'safe-relative-path' },
    required: { type: 'boolean' },
    status: { type: 'string', enum: ['success', 'failed', 'timeout'] },
    exit_code: { type: ['integer', 'null'] },
    timed_out: { type: 'boolean' },
    duration_ms: { type: 'integer', minimum: 0 },
    stdout_path: { type: 'string', format: 'safe-file-path' },
    stderr_path: { type: 'string', format: 'safe-file-path' },
    log_io_error: { type: 'string' },
  },
  required: ['id', 'argv', 'cwd', 'required', 'status', 'exit_code', 'timed_out', 'duration_ms', 'stdout_path', 'stderr_path'],
  additionalProperties: false,
};

export const verificationManifestSchema: Schema = {
  type: 'object',
  properties: {
    schema_version: { type: 'number', const: 1 },
    run_id: { type: 'string', minLength: 1 },
    iteration: { type: 'integer', minimum: 1 },
    passed: { type: 'boolean' },
    started_at: { type: 'string', format: 'iso8601' },
    finished_at: { type: 'string', format: 'iso8601' },
    commands: { type: 'array', items: verificationResultSchema },
  },
  required: ['schema_version', 'run_id', 'iteration', 'passed', 'started_at', 'finished_at', 'commands'],
  additionalProperties: false,
};

export const validateChangedFiles = ajv.compile(changedFilesSchema);
export const validateUntrackedFiles = ajv.compile(untrackedFilesSchema);
export const validateDiffMetadata = ajv.compile(diffMetadataSchema);
export const validateScopeReport = ajv.compile(scopeReportSchema);
export const validateVerificationManifest = ajv.compile(verificationManifestSchema);
