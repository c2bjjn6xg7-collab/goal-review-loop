const MAX_OUTPUT_LENGTH = 500;
const TRUNCATION_SUFFIX = '…';

const THINKING_BLOCK_PATTERN =
  /<(thinking|antThinking)>[\s\S]*?<\/\1>/g;

const TOOL_LINE_PREFIX_PATTERN =
  /^\s*\{"type":"(tool_use|tool_result)"/;

/**
 * Strips Claude/Codex agent private output from a raw stdout/stderr chunk:
 * - removes <thinking>…</thinking> and <antThinking>…</antThinking> blocks
 *   (matching across newlines)
 * - drops any line whose leading non-whitespace starts with a
 *   `{"type":"tool_use"` or `{"type":"tool_result"` JSON marker
 * - truncates the result to 500 characters, appending `…` when truncated
 * - returns "" when nothing visible remains
 *
 * Pure: no I/O, no side effects. Safe to call on partial chunks.
 */
export function filterAgentOutput(rawChunk: string): string {
  if (typeof rawChunk !== 'string' || rawChunk.length === 0) {
    return '';
  }

  const withoutThinking = rawChunk.replace(THINKING_BLOCK_PATTERN, '');

  const keptLines = withoutThinking
    .split('\n')
    .filter((line) => !TOOL_LINE_PREFIX_PATTERN.test(line));
  let result = keptLines.join('\n');

  if (result.length > MAX_OUTPUT_LENGTH) {
    result = result.slice(0, MAX_OUTPUT_LENGTH) + TRUNCATION_SUFFIX;
  }

  return result;
}
