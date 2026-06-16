/**
 * Unit tests for src/agents/command-renderer.ts
 */
import { describe, it, expect } from 'vitest';
import { renderCommand, validateCommandTemplate, ALLOWED_PLACEHOLDERS, CommandRendererError } from '../../src/agents/command-renderer.js';

describe('command-renderer', () => {
  describe('ALLOWED_PLACEHOLDERS', () => {
    it('contains all expected placeholders', () => {
      expect(ALLOWED_PLACEHOLDERS.has('prompt')).toBe(true);
      expect(ALLOWED_PLACEHOLDERS.has('prompt_file')).toBe(true);
      expect(ALLOWED_PLACEHOLDERS.has('run_id')).toBe(true);
      expect(ALLOWED_PLACEHOLDERS.has('iteration')).toBe(true);
      expect(ALLOWED_PLACEHOLDERS.has('project_root')).toBe(true);
    });
  });

  describe('validateCommandTemplate', () => {
    it('accepts template with {prompt}', () => {
      expect(() => validateCommandTemplate(['codex', 'exec', '{prompt}'])).not.toThrow();
    });

    it('accepts template with {prompt_file}', () => {
      expect(() => validateCommandTemplate(['codex', 'exec', '{prompt_file}'])).not.toThrow();
    });

    it('rejects template without {prompt} or {prompt_file}', () => {
      expect(() => validateCommandTemplate(['echo', '{run_id}'])).toThrow(CommandRendererError);
    });

    it('rejects template with unknown placeholder', () => {
      expect(() => validateCommandTemplate(['echo', '{unknown_placeholder}'])).toThrow(CommandRendererError);
    });
  });

  describe('renderCommand', () => {
    it('renders {prompt} placeholder', () => {
      const result = renderCommand(
        ['claude', '-p', '{prompt}'],
        { prompt: 'hello world', run_id: 'run-1', iteration: 1, project_root: '/tmp/project' },
      );
      expect(result).toEqual(['claude', '-p', 'hello world']);
    });

    it('renders {prompt_file} placeholder', () => {
      const result = renderCommand(
        ['codex', 'exec', '{prompt_file}'],
        { prompt_file: '/tmp/prompt.md', run_id: 'run-1', iteration: 1, project_root: '/tmp/project' },
      );
      expect(result).toEqual(['codex', 'exec', '/tmp/prompt.md']);
    });

    it('renders {run_id} placeholder', () => {
      const result = renderCommand(
        ['claude', '-p', '{prompt}', '--run', '{run_id}'],
        { prompt: 'test', run_id: 'run-123', iteration: 1, project_root: '/tmp/project' },
      );
      expect(result).toEqual(['claude', '-p', 'test', '--run', 'run-123']);
    });

    it('renders {iteration} as string', () => {
      const result = renderCommand(
        ['claude', '-p', '{prompt}', '--iter', '{iteration}'],
        { prompt: 'test', run_id: 'run-1', iteration: 3, project_root: '/tmp/project' },
      );
      expect(result).toEqual(['claude', '-p', 'test', '--iter', '3']);
    });

    it('renders {project_root} placeholder', () => {
      const result = renderCommand(
        ['claude', '-p', '{prompt}', '--root', '{project_root}'],
        { prompt: 'test', run_id: 'run-1', iteration: 1, project_root: '/home/user/project' },
      );
      expect(result).toEqual(['claude', '-p', 'test', '--root', '/home/user/project']);
    });

    it('throws on missing value for placeholder', () => {
      expect(() => renderCommand(
        ['claude', '-p', '{prompt}'],
        { run_id: 'run-1', iteration: 1, project_root: '/tmp' } as any,
      )).toThrow(CommandRendererError);
    });

    it('throws on empty program name after rendering', () => {
      // This is a degenerate case but should be caught
      expect(() => renderCommand(
        ['{prompt}'],
        { prompt: '', run_id: 'run-1', iteration: 1, project_root: '/tmp' },
      )).toThrow(CommandRendererError);
    });

    it('renders multiple placeholders in one element', () => {
      const result = renderCommand(
        ['tool', '{prompt}', '{run_id}-{iteration}'],
        { prompt: 'test', run_id: 'run-1', iteration: 2, project_root: '/tmp' },
      );
      expect(result).toEqual(['tool', 'test', 'run-1-2']);
    });
  });
});
