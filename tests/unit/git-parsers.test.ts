import { describe, it, expect } from 'vitest';
import { parsePorcelainStatus, parseNameStatus, parseNumstat } from '../../src/git/git-parsers.js';

describe('git-parsers', () => {
  describe('parsePorcelainStatus', () => {
    it('should parse modified files', () => {
      const output = ' M src/foo.ts\n M src/bar.ts\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ x: ' ', y: 'M', path: 'src/foo.ts' });
      expect(entries[1]).toEqual({ x: ' ', y: 'M', path: 'src/bar.ts' });
    });

    it('should parse added files', () => {
      const output = 'A  src/new.ts\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ x: 'A', y: ' ', path: 'src/new.ts' });
    });

    it('should parse deleted files', () => {
      const output = ' D src/deleted.ts\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ x: ' ', y: 'D', path: 'src/deleted.ts' });
    });

    it('should parse renamed files', () => {
      const output = 'R  src/old.ts\nsrc/new.ts\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        x: 'R',
        y: ' ',
        path: 'src/new.ts',
        orig_path: 'src/old.ts',
      });
    });

    it('should parse untracked files', () => {
      const output = '?? src/untracked.ts\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ x: '?', y: '?', path: 'src/untracked.ts' });
    });

    it('should skip header lines', () => {
      const output = '# branch.head main\n M src/foo.ts\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('src/foo.ts');
    });

    it('should handle quoted paths', () => {
      const output = '?? "file with spaces.ts"\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('file with spaces.ts');
    });

    it('should handle escaped unicode paths', () => {
      const output = '?? "file-with-\\344\\270\\255\\346\\226\\207.ts"\n';
      const entries = parsePorcelainStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe('file-with-中文.ts');
    });
  });

  describe('parseNameStatus', () => {
    it('should parse modified files', () => {
      const output = 'M\tsrc/foo.ts\0';
      const entries = parseNameStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ status: 'M', path: 'src/foo.ts' });
    });

    it('should parse added files', () => {
      const output = 'A\tsrc/new.ts\0';
      const entries = parseNameStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ status: 'A', path: 'src/new.ts' });
    });

    it('should parse deleted files', () => {
      const output = 'D\tsrc/deleted.ts\0';
      const entries = parseNameStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ status: 'D', path: 'src/deleted.ts' });
    });

    it('should parse renamed files', () => {
      const output = 'R100\0src/old.ts\0src/new.ts\0';
      const entries = parseNameStatus(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        status: 'R100',
        path: 'src/new.ts',
        orig_path: 'src/old.ts',
      });
    });
  });

  describe('parseNumstat', () => {
    it('should parse text files', () => {
      const output = '10\t5\tsrc/foo.ts\0';
      const entries = parseNumstat(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ additions: 10, deletions: 5, path: 'src/foo.ts' });
    });

    it('should handle binary files', () => {
      const output = '-\t-\timage.png\0';
      const entries = parseNumstat(output);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ additions: null, deletions: null, path: 'image.png' });
    });
  });
});
