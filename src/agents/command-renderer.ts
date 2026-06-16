/**
 * Command Renderer — safe template rendering for agent command templates.
 * Phase 3 §9.1: Command templates use whitelist placeholders only.
 *
 * Allowed placeholders: {prompt}, {prompt_file}, {run_id}, {iteration}, {project_root}
 * Unknown placeholders → CONFIG_ERROR before execution.
 * Each template must contain {prompt} or {prompt_file}.
 * Replacement happens within argv elements, not through shell.
 */

/** The only placeholders allowed in command templates. */
export const ALLOWED_PLACEHOLDERS = new Set([
  'prompt',
  'prompt_file',
  'run_id',
  'iteration',
  'project_root',
]);

/** Placeholder pattern: {name} */
const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * Validate that a command template only uses allowed placeholders
 * and contains at least {prompt} or {prompt_file}.
 *
 * Throws on:
 * - Unknown placeholders
 * - Missing {prompt} or {prompt_file}
 * - Empty program name after rendering (checked at render time)
 */
export function validateCommandTemplate(template: string[]): void {
  const foundPlaceholders = new Set<string>();
  let hasPromptOrFile = false;

  for (const element of template) {
    const matches = element.matchAll(PLACEHOLDER_RE);
    for (const match of matches) {
      const name = match[1];
      foundPlaceholders.add(name);
      if (name === 'prompt' || name === 'prompt_file') {
        hasPromptOrFile = true;
      }
      if (!ALLOWED_PLACEHOLDERS.has(name)) {
        throw new CommandRendererError(
          'CONFIG_ERROR',
          `Unknown placeholder "{${name}}" in command template element "${element}". Allowed: ${[...ALLOWED_PLACEHOLDERS].map(p => `{${p}}`).join(', ')}`,
        );
      }
    }
  }

  if (!hasPromptOrFile) {
    throw new CommandRendererError(
      'CONFIG_ERROR',
      `Command template must contain {prompt} or {prompt_file}. Found: ${foundPlaceholders.size > 0 ? [...foundPlaceholders].map(p => `{${p}}`).join(', ') : 'none'}`,
    );
  }
}

/**
 * Render a command template by replacing placeholders with values.
 *
 * Rules:
 * - Only allowed placeholders are replaced.
 * - Unknown placeholders throw CONFIG_ERROR (caught by validateCommandTemplate first).
 * - Replacement happens within argv elements, not through shell.
 * - command[0] after rendering must be a non-empty program name.
 * - {iteration} is rendered as a string (number → string).
 *
 * @param template - Command template array with placeholders
 * @param values - Values to substitute for placeholders
 * @returns Rendered argv array ready for Process Runner
 */
export function renderCommand(
  template: string[],
  values: CommandRenderValues,
): string[] {
  // Validate template first
  validateCommandTemplate(template);

  const rendered = template.map((element) => {
    return element.replace(PLACEHOLDER_RE, (_match, name: string) => {
      if (!ALLOWED_PLACEHOLDERS.has(name)) {
        throw new CommandRendererError(
          'CONFIG_ERROR',
          `Unknown placeholder "{${name}}" in command template`,
        );
      }

      const value = values[name as keyof CommandRenderValues];
      if (value === undefined || value === null) {
        throw new CommandRendererError(
          'CONFIG_ERROR',
          `Missing value for placeholder "{${name}}"`,
        );
      }

      // iteration is a number, render as string
      if (name === 'iteration') {
        return String(value);
      }

      return String(value);
    });
  });

  // Validate program name (command[0]) is non-empty after rendering
  if (!rendered[0] || rendered[0].trim() === '') {
    throw new CommandRendererError(
      'CONFIG_ERROR',
      `Command template renders to empty program name (command[0] = "${rendered[0]}")`,
    );
  }

  return rendered;
}

/** Values for command template rendering. */
export interface CommandRenderValues {
  prompt?: string;
  prompt_file?: string;
  run_id: string;
  iteration: number;
  project_root: string;
}

/**
 * Command Renderer Error — always CONFIG_ERROR category.
 */
export class CommandRendererError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandRendererError';
    this.code = code;
  }
}
