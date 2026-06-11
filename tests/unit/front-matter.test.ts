import { describe, it, expect } from 'vitest';
import {
  parseFrontMatter,
  serializeFrontMatter,
  validateRequiredFields,
  validateEnumField,
  FrontMatterError,
} from '../../src/artifacts/front-matter.js';

describe('YAML Front Matter Parser', () => {
  describe('parseFrontMatter', () => {
    it('should parse valid front matter', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
author_role: planner
---

# Plan

Some body content here.`;

      const result = parseFrontMatter(content);
      expect(result.frontMatter).toEqual({
        schema_version: 1,
        run_id: '20260610-test',
        author_role: 'planner',
      });
      expect(result.body).toContain('# Plan');
      expect(result.body).toContain('Some body content here.');
    });

    it('should parse GOAL front matter with arrays', () => {
      const content = `---
schema_version: 1
run_id: "20260610-test"
goal_id: "goal-001"
title: "Test goal"
allowed_changes:
  - "src/**"
  - "tests/**"
disallowed_changes:
  - ".git/**"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
---

# Goal`;

      const result = parseFrontMatter<Record<string, unknown>>(content);
      expect(result.frontMatter.schema_version).toBe(1);
      expect(result.frontMatter.allowed_changes).toEqual(['src/**', 'tests/**']);
      expect(result.frontMatter.disallowed_changes).toEqual(['.git/**']);
    });

    it('should throw if file does not start with --- at position 0', () => {
      const content = '# No front matter\nJust body.';
      expect(() => parseFrontMatter(content)).toThrow(FrontMatterError);
      expect(() => parseFrontMatter(content)).toThrow('position 0');
    });

    it('should reject leading whitespace before ---', () => {
      const content = '  ---\nschema_version: 1\n---\nBody';
      expect(() => parseFrontMatter(content)).toThrow(FrontMatterError);
      expect(() => parseFrontMatter(content)).toThrow('position 0');
    });

    it('should reject leading blank lines before ---', () => {
      const content = '\n---\nschema_version: 1\n---\nBody';
      expect(() => parseFrontMatter(content)).toThrow(FrontMatterError);
    });

    it('should reject leading newline before ---', () => {
      const content = '\n---\nschema_version: 1\n---\nBody';
      expect(() => parseFrontMatter(content)).toThrow(FrontMatterError);
    });

    it('should throw if closing --- is missing', () => {
      const content = `---
schema_version: 1
run_id: test

No closing delimiter.`;
      expect(() => parseFrontMatter(content)).toThrow(FrontMatterError);
      expect(() => parseFrontMatter(content)).toThrow('Missing closing');
    });

    it('should not confuse --- in body text as closing delimiter', () => {
      const content = `---
schema_version: 1
---

Body with --- on a line that is not a delimiter`;
      // The closing --- must be on its own line after the opening
      // This should parse correctly because the first \n---\n is the closing delimiter
      const result = parseFrontMatter(content);
      expect(result.frontMatter).toEqual({ schema_version: 1 });
    });

    it('should throw if YAML is invalid', () => {
      const content = `---
: invalid yaml
---

Body`;
      expect(() => parseFrontMatter(content)).toThrow(FrontMatterError);
      expect(() => parseFrontMatter(content)).toThrow('Failed to parse YAML');
    });

    it('should throw if YAML is not an object', () => {
      const content = `---
just a string
---

Body`;
      expect(() => parseFrontMatter(content)).toThrow(FrontMatterError);
      expect(() => parseFrontMatter(content)).toThrow('must be an object');
    });

    it('should handle empty body after front matter', () => {
      const content = `---
schema_version: 1
---`;
      const result = parseFrontMatter(content);
      expect(result.frontMatter).toEqual({ schema_version: 1 });
      expect(result.body).toBe('');
    });

    it('should include filePath in error messages', () => {
      const content = 'No front matter';
      expect(() => parseFrontMatter(content, '.agent/GOAL.md')).toThrow('.agent/GOAL.md');
    });

    it('should handle CRLF line endings', () => {
      const content = '---\r\nschema_version: 1\r\n---\r\n\r\nBody';
      const result = parseFrontMatter(content);
      expect(result.frontMatter).toEqual({ schema_version: 1 });
    });
  });

  describe('serializeFrontMatter', () => {
    it('should serialize front matter and body', () => {
      const fm = { schema_version: 1, run_id: 'test' };
      const body = '# Title\nContent';
      const result = serializeFrontMatter(fm, body);

      expect(result).toContain('---');
      expect(result).toContain('schema_version: 1');
      expect(result).toContain('# Title');
    });

    it('should produce parseable output', () => {
      const fm = { schema_version: 1, run_id: 'test', author_role: 'planner' };
      const body = '# Plan\nContent';
      const serialized = serializeFrontMatter(fm, body);
      const parsed = parseFrontMatter(serialized);

      expect(parsed.frontMatter).toEqual(fm);
      expect(parsed.body).toBe(body);
    });
  });

  describe('validateRequiredFields', () => {
    it('should pass when all required fields exist', () => {
      const fm = { schema_version: 1, run_id: 'test' };
      expect(() => validateRequiredFields(fm, ['schema_version', 'run_id'])).not.toThrow();
    });

    it('should throw when required fields are missing', () => {
      const fm = { schema_version: 1 };
      expect(() => validateRequiredFields(fm, ['schema_version', 'run_id'])).toThrow(FrontMatterError);
      expect(() => validateRequiredFields(fm, ['schema_version', 'run_id'])).toThrow('run_id');
    });

    it('should throw when required fields are null', () => {
      const fm = { schema_version: 1, run_id: null };
      expect(() => validateRequiredFields(fm, ['schema_version', 'run_id'])).toThrow(FrontMatterError);
    });

    it('should throw when required fields are empty string', () => {
      const fm = { schema_version: 1, run_id: '' };
      expect(() => validateRequiredFields(fm, ['schema_version', 'run_id'])).toThrow(FrontMatterError);
    });
  });

  describe('validateEnumField', () => {
    it('should pass when value is in allowed set', () => {
      const fm = { decision: 'PASS' };
      expect(() => validateEnumField(fm, 'decision', ['PASS', 'FAIL', 'BLOCKED'])).not.toThrow();
    });

    it('should throw when value is not in allowed set', () => {
      const fm = { decision: 'UNKNOWN' };
      expect(() => validateEnumField(fm, 'decision', ['PASS', 'FAIL', 'BLOCKED'])).toThrow(FrontMatterError);
      expect(() => validateEnumField(fm, 'decision', ['PASS', 'FAIL', 'BLOCKED'])).toThrow('UNKNOWN');
    });

    it('should pass when field is undefined (optional)', () => {
      const fm = {};
      expect(() => validateEnumField(fm, 'decision', ['PASS', 'FAIL', 'BLOCKED'])).not.toThrow();
    });
  });
});