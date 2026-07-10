import { describe, expect, it } from 'vitest';
import { supportsGracefulSigterm } from '../../src/runtime/platform-signals.js';

describe('platform signal capabilities', () => {
  it('does not use SIGTERM as a graceful notification on Windows', () => {
    expect(supportsGracefulSigterm('win32')).toBe(false);
  });

  it('preserves graceful SIGTERM notification on macOS and Linux', () => {
    expect(supportsGracefulSigterm('darwin')).toBe(true);
    expect(supportsGracefulSigterm('linux')).toBe(true);
  });
});
