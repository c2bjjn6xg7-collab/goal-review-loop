/**
 * Phase 8D P6.5: Task graph scope preflight.
 *
 * A deterministic, side-effect-free preflight that flags *risky* task scopes
 * before a Developer attempt runs. The specific risk it detects:
 *
 *   A task's required verification runs integration tests (a command argv
 *   references `tests/integration`), yet the task's `allowed_changes` permits
 *   ONLY test paths — no source, docs, or config path. Integration tests
 *   exercise source behavior, so a Developer who can only touch tests usually
 *   cannot make a failing integration test pass. That is a scope mismatch worth
 *   surfacing before burning an attempt.
 *
 * Responsibility boundary:
 *   - Does: classify allowed_changes, scan required verification command argvs
 *     for `tests/integration`, and return structured warnings.
 *   - Does NOT: block execution, decide BLOCKED, build OrchestratorResult, or
 *     write iteration-log/progress. The preflight is warning-only by default;
 *     logging the warnings to iteration-log.md before task execution is wired
 *     by the caller in task-graph-loop.ts.
 *
 * The helper is pure: identical input always yields identical output, with no
 * clock, filesystem, or random access. This makes it trivially unit-testable.
 */
import type { VerificationCommand } from '../types.js';

/** Warning code emitted for an integration-test / test-only-scope mismatch. */
export const TASK_GRAPH_PREFLIGHT_WARNING_CODE = 'integration_test_testonly_scope' as const;

/** A single preflight warning. */
export interface TaskGraphPreflightWarning {
  /** Stable warning code; currently always {@link TASK_GRAPH_PREFLIGHT_WARNING_CODE}. */
  code: typeof TASK_GRAPH_PREFLIGHT_WARNING_CODE;
  /** The task id the warning applies to. */
  task_id: string;
  /** Human-readable, actionable warning message. */
  message: string;
  /** Required verification command ids that reference `tests/integration`. */
  verification_command_ids: string[];
  /** The task's allowed_changes, as supplied to the preflight. */
  allowed_changes: string[];
}

/** Input to {@link runTaskGraphPreflight}. */
export interface TaskGraphPreflightInput {
  /** The task id (for warning attribution). */
  task_id: string;
  /** The task's allowed_changes globs/paths. */
  allowed_changes: string[];
  /** Normalized verification commands (argv form, with `required` flag). */
  verification_commands: VerificationCommand[];
}

/** Result of {@link runTaskGraphPreflight}. Always non-blocking. */
export interface TaskGraphPreflightResult {
  /** Emitted warnings (possibly empty). */
  warnings: TaskGraphPreflightWarning[];
  /**
   * Always `false`. The preflight warns by default and must never block task
   * execution. Present as an explicit field so callers cannot mistake a
   * non-empty warnings list for a blocking failure.
   */
  blocked: false;
}

/** Path classification used to detect a test-only scope. */
type AllowedChangeClass = 'test' | 'source' | 'docs' | 'config' | 'other';

/** Root-level / well-known config filenames (lowercased basename). */
const CONFIG_FILENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'jsconfig.json',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.js',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
]);

/** True if a lowercased basename looks like a config file (name or extension). */
function isConfigBasename(basename: string): boolean {
  if (CONFIG_FILENAMES.has(basename)) return true;
  if (/\.config\.(js|ts|mjs|cjs|json|ya?ml|toml)$/.test(basename)) return true;
  if (/^\.(eslintrc|prettierrc)/.test(basename)) return true;
  // Root-level JSON/YAML/TOML files are conventionally configuration.
  if (/\.(json|ya?ml|toml)$/.test(basename)) return true;
  return false;
}

/**
 * Normalize an allowed_changes entry to a comparable posix form: forward
 * slashes, no leading `./`, no trailing `/`. Glob metacharacters (`*`) are
 * preserved — classification keys off the leading path segment, which globs do
 * not change.
 */
function normalizeAllowedChange(p: string): string {
  let s = String(p ?? '').replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+$/, '');
  return s;
}

/** Classify an allowed_changes entry by its leading path segment. */
function classifyAllowedChange(p: string): AllowedChangeClass {
  const n = normalizeAllowedChange(p);
  if (!n) return 'other';
  if (n === 'tests' || n.startsWith('tests/')) return 'test';
  if (n === 'src' || n.startsWith('src/')) return 'source';
  if (n === 'docs' || n.startsWith('docs/')) return 'docs';
  const basename = n.split('/').pop()!.toLowerCase();
  if (isConfigBasename(basename)) return 'config';
  return 'other';
}

/**
 * True if a normalized verification command argv references `tests/integration`
 * (e.g. `tests/integration/task-graph.test.ts`). Matching on the literal path
 * segment keeps the check deterministic and immune to flag ordering.
 */
function argvReferencesIntegrationTests(argv: string[]): boolean {
  return argv.some((tok) => typeof tok === 'string' && tok.includes('tests/integration'));
}

/**
 * Run the task graph scope preflight.
 *
 * Emits a warning iff ALL hold:
 *   1. The task has at least one required verification command whose argv
 *      references `tests/integration`.
 *   2. `allowed_changes` is non-empty.
 *   3. Every `allowed_changes` entry is a test path — i.e. there is no source,
 *      docs, or config path the Developer can touch to satisfy the integration
 *      test.
 *
 * The result is always non-blocking ({@link TaskGraphPreflightResult#blocked}
 * is `false`); callers log warnings and proceed.
 */
export function runTaskGraphPreflight(input: TaskGraphPreflightInput): TaskGraphPreflightResult {
  const taskId = input.task_id;
  const allowedChanges = Array.isArray(input.allowed_changes) ? input.allowed_changes : [];
  const commands = Array.isArray(input.verification_commands) ? input.verification_commands : [];

  // (1) Required verification commands that reference tests/integration.
  const integrationCommandIds = commands
    .filter((c) => c.required && argvReferencesIntegrationTests(c.argv))
    .map((c) => c.id);

  if (integrationCommandIds.length === 0) {
    return { warnings: [], blocked: false };
  }

  // (2) + (3) Non-empty scope that is exclusively test paths (no
  // source/docs/config path).
  const classes = allowedChanges.map(classifyAllowedChange);
  const isTestOnlyScope =
    classes.length > 0 && classes.every((c) => c === 'test');

  if (!isTestOnlyScope) {
    return { warnings: [], blocked: false };
  }

  const message =
    `Task "${taskId}" requires integration-test verification (${integrationCommandIds.join(', ')}) ` +
    `but allowed_changes only permits test paths (no source, docs, or config path). ` +
    `Integration tests usually require source changes; if this task must make an integration ` +
    `test pass, widen allowed_changes to include the needed source/docs/config path. ` +
    `(Warning only — execution is not blocked.)`;

  return {
    warnings: [
      {
        code: TASK_GRAPH_PREFLIGHT_WARNING_CODE,
        task_id: taskId,
        message,
        verification_command_ids: integrationCommandIds,
        allowed_changes: allowedChanges,
      },
    ],
    blocked: false,
  };
}
