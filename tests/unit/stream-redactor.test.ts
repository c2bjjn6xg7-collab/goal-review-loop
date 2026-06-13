import { describe, it, expect } from 'vitest';
import { StreamRedactor } from '../../src/runtime/process-runner.js';

const REDACTED = '***REDACTED***';

/**
 * Helper: feed input through the redactor in a single call.
 */
function redactSingle(secrets: string[], input: string): string {
  const redactor = new StreamRedactor(secrets);
  const out = redactor.process(Buffer.from(input, 'utf8'));
  const flush = redactor.flush();
  return Buffer.concat([out, flush]).toString('utf8');
}

/**
 * Helper: feed input through the redactor split into chunks at a single split point.
 */
function redactTwoChunks(secrets: string[], input: string, splitAt: number): string {
  const redactor = new StreamRedactor(secrets);
  const chunks: Buffer[] = [];

  const left = input.substring(0, splitAt);
  const right = input.substring(splitAt);
  if (left.length > 0) chunks.push(redactor.process(Buffer.from(left, 'utf8')));
  if (right.length > 0) chunks.push(redactor.process(Buffer.from(right, 'utf8')));

  chunks.push(redactor.flush());
  return Buffer.concat(chunks.filter(b => b.length > 0)).toString('utf8');
}

/**
 * Generate all partitions of a string into 1..length non-empty chunks.
 * Returns arrays of substrings.
 */
function allPartitions(s: string): string[][] {
  if (s.length === 0) return [[]];
  const results: string[][] = [];
  // Enumerate all 2^(n-1) split patterns
  const n = s.length;
  for (let mask = 0; mask < (1 << (n - 1)); mask++) {
    const parts: string[] = [];
    let last = 0;
    for (let i = 0; i < n - 1; i++) {
      if (mask & (1 << i)) {
        parts.push(s.substring(last, i + 1));
        last = i + 1;
      }
    }
    parts.push(s.substring(last));
    results.push(parts);
  }
  return results;
}

/**
 * Helper: feed input through the redactor using a specific partition (array of chunks).
 */
function redactPartition(secrets: string[], partition: string[]): string {
  const redactor = new StreamRedactor(secrets);
  const chunks: Buffer[] = [];

  for (const part of partition) {
    chunks.push(redactor.process(Buffer.from(part, 'utf8')));
  }

  chunks.push(redactor.flush());
  return Buffer.concat(chunks.filter(b => b.length > 0)).toString('utf8');
}

/**
 * Verify chunk invariance — ALL possible partitions produce the same result
 * as a single-chunk input.
 */
function expectChunkInvariant(secrets: string[], input: string): void {
  const expected = redactSingle(secrets, input);
  const partitions = allPartitions(input);

  for (const partition of partitions) {
    if (partition.length <= 1) continue; // skip single-chunk (same as reference)
    const actual = redactPartition(secrets, partition);
    expect(actual).toBe(expected);
  }
}

/**
 * Exhaustive chunk invariance test over a small alphabet.
 * For each pair of secrets (length 1-3) and input (length 1-5),
 * verify all partitions produce the same result.
 */
function exhaustiveChunkInvariant(alphabet: string): { tested: number; failed: number } {
  let tested = 0;
  let failed = 0;

  // Generate all strings of length 1-3 from alphabet
  const allStrings: string[] = [];
  for (let len = 1; len <= 3; len++) {
    for (const combo of combinations(alphabet, len)) {
      allStrings.push(combo);
    }
  }

  // Test all pairs of secrets + all inputs of length 1-5
  for (let i = 0; i < allStrings.length; i++) {
    for (let j = 0; j < allStrings.length; j++) {
      if (i === j) continue; // skip identical secrets
      const secrets = [allStrings[i], allStrings[j]];
      // Generate all inputs of length 1-5
      for (let inputLen = 1; inputLen <= 5; inputLen++) {
        for (const input of combinations(alphabet, inputLen)) {
          tested++;
          const expected = redactSingle(secrets, input);
          const partitions = allPartitions(input);
          for (const partition of partitions) {
            if (partition.length <= 1) continue;
            const actual = redactPartition(secrets, partition);
            if (actual !== expected) {
              failed++;
              // Log the failure for debugging
              console.error(`FAIL: secrets=${JSON.stringify(secrets)} input="${input}" partition=${JSON.stringify(partition)} expected="${expected}" actual="${actual}"`);
            }
          }
        }
      }
    }
  }

  return { tested, failed };
}

/**
 * Generate all strings of a given length from an alphabet.
 */
function combinations(alphabet: string, length: number): string[] {
  if (length === 0) return [''];
  const shorter = combinations(alphabet, length - 1);
  const result: string[] = [];
  for (const prefix of shorter) {
    for (const ch of alphabet) {
      result.push(prefix + ch);
    }
  }
  return result;
}

describe('StreamRedactor', () => {
  // --- Ordinary single secret ---

  describe('ordinary single secret', () => {
    it('should redact a simple secret in the middle of text', () => {
      expect(redactSingle(['secret'], 'hello secret world')).toBe(`hello ${REDACTED} world`);
    });

    it('should redact secret at start of text', () => {
      expect(redactSingle(['secret'], 'secret world')).toBe(`${REDACTED} world`);
    });

    it('should redact secret at end of text', () => {
      expect(redactSingle(['secret'], 'hello secret')).toBe(`hello ${REDACTED}`);
    });

    it('should redact entire text when it is the secret', () => {
      expect(redactSingle(['secret'], 'secret')).toBe(REDACTED);
    });

    it('should redact multiple occurrences', () => {
      expect(redactSingle(['ab'], 'abxab')).toBe(`${REDACTED}x${REDACTED}`);
    });

    it('should not redact when secret is not present', () => {
      expect(redactSingle(['secret'], 'hello world')).toBe('hello world');
    });

    it('should handle empty input', () => {
      expect(redactSingle(['secret'], '')).toBe('');
    });

    it('should handle empty secrets list', () => {
      expect(redactSingle([], 'hello world')).toBe('hello world');
    });
  });

  // --- Self-overlapping secrets ---

  describe('self-overlapping secret', () => {
    it('should redact bb in bbbb (overlapping)', () => {
      expect(redactSingle(['bb'], 'bbbb')).toBe(`${REDACTED}${REDACTED}`);
    });

    it('should redact aba in abaaba', () => {
      expect(redactSingle(['aba'], 'abaaba')).toBe(`${REDACTED}${REDACTED}`);
    });

    it('should redact aba in xabax', () => {
      expect(redactSingle(['aba'], 'xabax')).toBe(`x${REDACTED}x`);
    });

    it('should handle self-overlapping with chunk invariance', () => {
      expectChunkInvariant(['bb'], 'bbbb');
      expectChunkInvariant(['aba'], 'abaaba');
      expectChunkInvariant(['aba'], 'xabax');
    });
  });

  // --- Multiple secrets ---

  describe('multiple secrets', () => {
    it('should redact both secrets', () => {
      expect(redactSingle(['foo', 'bar'], 'foo x bar')).toBe(`${REDACTED} x ${REDACTED}`);
    });

    it('should choose earliest match', () => {
      expect(redactSingle(['bar', 'foo'], 'foobar')).toBe(`${REDACTED}${REDACTED}`);
    });

    it('should choose longest match at same position', () => {
      expect(redactSingle(['ab', 'abc'], 'xabc')).toBe(`x${REDACTED}`);
    });

    it('should handle multiple secrets with chunk invariance', () => {
      expectChunkInvariant(['foo', 'bar'], 'foobar');
      expectChunkInvariant(['ab', 'cd'], 'abcd');
    });
  });

  // --- Same-start prefix-related secrets (F-210R11, closed) ---

  describe('same-start prefix-related secrets', () => {
    it('should redact ab/abc: abc → single REDACTED (longest match)', () => {
      expect(redactSingle(['ab', 'abc'], 'abc')).toBe(REDACTED);
    });

    it('should redact ab/abc: xabc → single REDACTED', () => {
      expect(redactSingle(['ab', 'abc'], 'xabc')).toBe(`x${REDACTED}`);
    });

    it('should redact ab/abc: abd → REDACTED + d (short match only)', () => {
      expect(redactSingle(['ab', 'abc'], 'abd')).toBe(`${REDACTED}d`);
    });

    it('should redact a/abcdef: abcdef → single REDACTED (longest match)', () => {
      expect(redactSingle(['a', 'abcdef'], 'abcdef')).toBe(REDACTED);
    });

    it('should redact a/abcdef: abcdeg → REDACTED + bcdeg (short match)', () => {
      expect(redactSingle(['a', 'abcdef'], 'abcdeg')).toBe(`${REDACTED}bcdeg`);
    });

    it('should maintain chunk invariance for ab/abc', () => {
      expectChunkInvariant(['ab', 'abc'], 'abc');
      expectChunkInvariant(['ab', 'abc'], 'xabc');
      expectChunkInvariant(['ab', 'abc'], 'abd');
      expectChunkInvariant(['ab', 'abc'], 'abcabc');
      expectChunkInvariant(['ab', 'abc'], 'xabcyabcz');
    });

    it('should maintain chunk invariance for a/abcdef', () => {
      expectChunkInvariant(['a', 'abcdef'], 'abcdef');
      expectChunkInvariant(['a', 'abcdef'], 'abcdeg');
      expectChunkInvariant(['a', 'abcdef'], 'xabcdef');
      expectChunkInvariant(['a', 'abcdef'], 'abcdefx');
    });

    it('should maintain chunk invariance for prefix/longer prefix', () => {
      expectChunkInvariant(['pre', 'prefix'], 'prefix');
      expectChunkInvariant(['pre', 'prefix'], 'prefix123');
      expectChunkInvariant(['pre', 'prefix'], 'pre123');
    });
  });

  // --- Different-start overlapping secrets (F-210R12) ---

  describe('different-start overlapping secrets', () => {
    it('should redact a/baa: baa → single REDACTED (longest earliest match)', () => {
      expect(redactSingle(['a', 'baa'], 'baa')).toBe(REDACTED);
    });

    it('should redact a/baa: baa split as ba+a → single REDACTED', () => {
      expect(redactTwoChunks(['a', 'baa'], 'baa', 2)).toBe(REDACTED);
    });

    it('should redact a/baa: baa split as b+aa → single REDACTED', () => {
      expect(redactTwoChunks(['a', 'baa'], 'baa', 1)).toBe(REDACTED);
    });

    it('should redact b/aba: aba → single REDACTED (longest earliest match)', () => {
      expect(redactSingle(['b', 'aba'], 'aba')).toBe(REDACTED);
    });

    it('should redact b/aba: aba split as ab+a → single REDACTED', () => {
      expect(redactTwoChunks(['b', 'aba'], 'aba', 2)).toBe(REDACTED);
    });

    it('should redact b/aba: aba split as a+ba → single REDACTED', () => {
      expect(redactTwoChunks(['b', 'aba'], 'aba', 1)).toBe(REDACTED);
    });

    it('should maintain chunk invariance for a/baa', () => {
      expectChunkInvariant(['a', 'baa'], 'baa');
      expectChunkInvariant(['a', 'baa'], 'xbaa');
      expectChunkInvariant(['a', 'baa'], 'baax');
      expectChunkInvariant(['a', 'baa'], 'baabaa');
    });

    it('should maintain chunk invariance for b/aba', () => {
      expectChunkInvariant(['b', 'aba'], 'aba');
      expectChunkInvariant(['b', 'aba'], 'xaba');
      expectChunkInvariant(['b', 'aba'], 'abax');
    });

    it('should maintain chunk invariance for a/baa with non-matching input', () => {
      expectChunkInvariant(['a', 'baa'], 'bax');
      expectChunkInvariant(['a', 'baa'], 'xab');
    });

    it('should maintain chunk invariance for ab/bab', () => {
      expectChunkInvariant(['ab', 'bab'], 'bab');
      expectChunkInvariant(['ab', 'bab'], 'abab');
    });
  });

  // --- Chunk invariance property test (all partitions) ---

  describe('chunk invariance property', () => {
    const testCases: { secrets: string[]; input: string }[] = [
      { secrets: ['bb'], input: 'bbbb' },
      { secrets: ['aba'], input: 'abaaba' },
      { secrets: ['ab', 'abc'], input: 'abc' },
      { secrets: ['ab', 'abc'], input: 'abcabc' },
      { secrets: ['a', 'abcdef'], input: 'abcdef' },
      { secrets: ['a', 'abcdef'], input: 'abcdefx' },
      { secrets: ['foo', 'bar'], input: 'foobar' },
      { secrets: ['secret'], input: 'hello secret world' },
      { secrets: ['ab', 'cd', 'ef'], input: 'abcdef' },
      { secrets: ['x', 'xyz'], input: 'xyz' },
      { secrets: ['x', 'xyz'], input: 'xyw' },
      // Different-start overlap cases
      { secrets: ['a', 'baa'], input: 'baa' },
      { secrets: ['b', 'aba'], input: 'aba' },
      { secrets: ['ab', 'bab'], input: 'bab' },
    ];

    for (const { secrets, input } of testCases) {
      it(`should be chunk-invariant for secrets=${JSON.stringify(secrets)} input="${input}"`, () => {
        expectChunkInvariant(secrets, input);
      });
    }
  });

  // --- Exhaustive chunk invariance over binary alphabet ---

  describe('exhaustive chunk invariance', () => {
    it('should be chunk-invariant for all binary secrets (len 1-3) and inputs (len 1-5)', () => {
      const { tested, failed } = exhaustiveChunkInvariant('ab');
      expect(tested).toBeGreaterThan(0);
      expect(failed).toBe(0);
    });
  });

  // --- UTF-8 ---

  describe('UTF-8 handling', () => {
    it('should redact UTF-8 secret', () => {
      expect(redactSingle(['密码'], '我的密码是密码')).toBe(`我的${REDACTED}是${REDACTED}`);
    });

    it('should handle multi-byte characters at chunk boundary', () => {
      const redactor = new StreamRedactor(['密码']);
      const input = '密码';
      const buf = Buffer.from(input, 'utf8');

      // Split after first byte of "密" (which is 3 bytes)
      const chunk1 = buf.subarray(0, 1);
      const chunk2 = buf.subarray(1);

      const out1 = redactor.process(chunk1);
      const out2 = redactor.process(chunk2);
      const flush = redactor.flush();

      const result = Buffer.concat([out1, out2, flush].filter(b => b.length > 0)).toString('utf8');
      expect(result).toBe(REDACTED);
    });

    it('should maintain chunk invariance for UTF-8', () => {
      expectChunkInvariant(['密码'], '密码');
      expectChunkInvariant(['密码'], '我的密码');
    });
  });

  // --- EOF / flush ---

  describe('EOF / flush', () => {
    it('should flush remaining pending content that is a partial match', () => {
      const redactor = new StreamRedactor(['abc']);
      const out = redactor.process(Buffer.from('ab', 'utf8'));
      expect(out.length).toBe(0);
      const flush = redactor.flush();
      expect(flush.toString('utf8')).toBe('ab');
    });

    it('should flush non-matching pending content immediately', () => {
      const redactor = new StreamRedactor(['xyz']);
      const out = redactor.process(Buffer.from('ab', 'utf8'));
      expect(out.toString('utf8')).toBe('ab');
      const flush = redactor.flush();
      expect(flush.length).toBe(0);
    });

    it('should handle prefix-related partial match at EOF', () => {
      const redactor = new StreamRedactor(['a', 'abcdef']);
      const out = redactor.process(Buffer.from('abc', 'utf8'));
      const flush = redactor.flush();
      const result = Buffer.concat([out, flush].filter(b => b.length > 0)).toString('utf8');
      expect(result).toBe(`${REDACTED}bc`);
    });

    it('should flush complete match at EOF', () => {
      const redactor = new StreamRedactor(['abc']);
      const out = redactor.process(Buffer.from('abc', 'utf8'));
      expect(out.toString('utf8')).toBe(REDACTED);
      const flush = redactor.flush();
      expect(flush.length).toBe(0);
    });

    it('should handle different-start overlap at EOF', () => {
      // secrets = ['a', 'baa'], pending = 'ba' — partial match for 'baa'
      const redactor = new StreamRedactor(['a', 'baa']);
      const out = redactor.process(Buffer.from('ba', 'utf8'));
      // 'baa' starts at 0 and is partial, 'a' at pos 1 is complete but
      // 'baa' from pos 0 is still possible — wait
      expect(out.length).toBe(0);
      const flush = redactor.flush();
      // At EOF, 'baa' is not complete, so redact 'a' at pos 1 and output 'b'
      const result = Buffer.concat([out, flush].filter(b => b.length > 0)).toString('utf8');
      expect(result).toBe(`b${REDACTED}`);
    });
  });
});
