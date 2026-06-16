/**
 * YAML Front Matter parser — parses Markdown files with YAML front matter.
 * Design doc §8: "所有模型生成的 Markdown 文件使用 YAML front matter 提供机器字段"
 *
 * STRICT: Front matter must begin at byte position 0.
 * No leading whitespace, no leading blank lines.
 * Closing delimiter must be its own complete line.
 */
import yaml from 'js-yaml';

export interface FrontMatterResult<T = Record<string, unknown>> {
  frontMatter: T;
  body: string;
}

export class FrontMatterError extends Error {
  constructor(message: string, public readonly filePath?: string) {
    super(message);
    this.name = 'FrontMatterError';
  }
}

/**
 * Parse YAML front matter from a Markdown string.
 *
 * Strict rules:
 * - Opening `---` must be at position 0 (no leading whitespace or blank lines).
 * - Closing `---` must be its own complete line (not embedded in text).
 * - Handles both LF and CRLF line endings.
 *
 * @param content - The full Markdown content
 * @param filePath - Optional file path for error messages
 * @returns Parsed front matter and body
 */
export function parseFrontMatter<T = Record<string, unknown>>(
  content: string,
  filePath?: string,
): FrontMatterResult<T> {
  // STRICT: Must start with --- at position 0
  if (!content.startsWith('---')) {
    throw new FrontMatterError(
      `File must start with YAML front matter delimiter (---) at position 0${filePath ? ` in ${filePath}` : ''}`,
      filePath,
    );
  }

  // Normalize CRLF to LF for consistent parsing
  const normalized = content.replace(/\r\n/g, '\n');

  // Find the closing --- as its own line
  // After the opening ---, look for \n---\n or \n---$ (end of string)
  const afterOpen = normalized.slice(3); // skip opening ---

  // The closing delimiter must be preceded by \n and followed by \n or end-of-string
  const closingPattern = /\n---(?=\n|$)/;
  const match = afterOpen.match(closingPattern);

  if (!match || match.index === undefined) {
    throw new FrontMatterError(
      `Missing closing YAML front matter delimiter (---) on its own line${filePath ? ` in ${filePath}` : ''}`,
      filePath,
    );
  }

  const yamlContent = afterOpen.slice(0, match.index).trim();
  const bodyStart = afterOpen.slice(match.index + 4).trimStart(); // skip \n---

  // Parse YAML
  let frontMatter: T;
  try {
    frontMatter = yaml.load(yamlContent) as T;
  } catch (err) {
    throw new FrontMatterError(
      `Failed to parse YAML front matter: ${err}${filePath ? ` in ${filePath}` : ''}`,
      filePath,
    );
  }

  if (typeof frontMatter !== 'object' || frontMatter === null) {
    throw new FrontMatterError(
      `YAML front matter must be an object${filePath ? ` in ${filePath}` : ''}`,
      filePath,
    );
  }

  return {
    frontMatter,
    body: bodyStart,
  };
}

/**
 * Serialize front matter and body back to a Markdown string.
 */
export function serializeFrontMatter<T = Record<string, unknown>>(
  frontMatter: T,
  body: string,
): string {
  const yamlContent = yaml.dump(frontMatter, {
    lineWidth: -1, // Don't wrap lines
    noRefs: true,
    sortKeys: false,
  });

  return `---\n${yamlContent}---\n\n${body}`;
}

/**
 * Validate that required fields exist in front matter.
 */
export function validateRequiredFields(
  frontMatter: Record<string, unknown>,
  requiredFields: string[],
  filePath?: string,
): void {
  const missing = requiredFields.filter((field) => {
    const value = frontMatter[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new FrontMatterError(
      `Missing required front matter fields: ${missing.join(', ')}${filePath ? ` in ${filePath}` : ''}`,
      filePath,
    );
  }
}

/**
 * Validate that a field value is one of the allowed enum values.
 */
export function validateEnumField(
  frontMatter: Record<string, unknown>,
  field: string,
  allowedValues: string[],
  filePath?: string,
): void {
  const value = frontMatter[field];
  if (value !== undefined && !allowedValues.includes(String(value))) {
    throw new FrontMatterError(
      `Field '${field}' must be one of: ${allowedValues.join(', ')}, got: ${value}${filePath ? ` in ${filePath}` : ''}`,
      filePath,
    );
  }
}
