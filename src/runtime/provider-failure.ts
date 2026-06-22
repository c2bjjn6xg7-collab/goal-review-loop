/**
 * Provider Failure Classification — Phase 9 R1.
 *
 * Reads an agent subprocess stderr log and pattern-matches it against known
 * provider-side failure signatures (quota exhaustion, rate limiting, overload).
 *
 * This is observability-only: classification never changes orchestration
 * decisions. It only surfaces a structured `provider.failure` event so the
 * operator understands why a resume would retry the same blocked model call.
 */
import { existsSync, readFileSync } from 'node:fs';

export type ProviderFailureClass =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'overloaded'
  | 'auth_error'
  | 'unknown_provider_error';

export interface ProviderFailureClassification {
  classification: ProviderFailureClass;
  retry_recommended: boolean;
  /** Short human-readable evidence snippet from stderr (first match). */
  evidence: string;
}

interface ClassifyInput {
  stderrPath: string;
  provider: string;
  exitCode: number | null | undefined;
}

interface Pattern {
  regex: RegExp;
  classification: ProviderFailureClass;
  retry_recommended: boolean;
}

// Patterns are intentionally broad and case-insensitive so they survive minor
// provider message wording changes. Order matters: earlier patterns win.
const PATTERNS: Pattern[] = [
  {
    regex: /out of credits|billing limit|quota.*exhaust|exhausted.*quota|insufficient_quota|payment required|credit balance/i,
    classification: 'quota_exhausted',
    retry_recommended: false,
  },
  {
    regex: /\b429\b|rate.?limit|too many requests|throttl/i,
    classification: 'rate_limited',
    retry_recommended: true,
  },
  {
    regex: /overloaded|capacity|service unavailable|temporarily unavailable|internal server error|\b503\b|\b529\b/i,
    classification: 'overloaded',
    retry_recommended: true,
  },
  {
    regex: /invalid api key|unauthor|authentication|401|forbidden|403/i,
    classification: 'auth_error',
    retry_recommended: false,
  },
];

/**
 * Classify a provider failure from the agent's stderr log.
 * Returns null if the failure does not match a known provider signature,
 * if the stderr file is missing, or if exitCode is 0 (success).
 */
export async function classifyProviderFailure(
  input: ClassifyInput,
): Promise<ProviderFailureClassification | null> {
  // Exit code 0 means success — no failure to classify.
  if (input.exitCode === 0 || input.exitCode === null || input.exitCode === undefined) {
    return null;
  }

  if (!existsSync(input.stderrPath)) return null;

  let content: string;
  try {
    content = readFileSync(input.stderrPath, 'utf8');
  } catch {
    return null;
  }

  if (!content.trim()) return null;

  for (const pattern of PATTERNS) {
    const match = content.match(pattern.regex);
    if (match) {
      // Extract a short evidence snippet around the match.
      const idx = match.index ?? 0;
      const start = Math.max(0, idx - 20);
      const end = Math.min(content.length, idx + match[0].length + 40);
      const evidence = content.slice(start, end).replace(/\s+/g, ' ').trim();
      return {
        classification: pattern.classification,
        retry_recommended: pattern.retry_recommended,
        evidence,
      };
    }
  }

  return null;
}
