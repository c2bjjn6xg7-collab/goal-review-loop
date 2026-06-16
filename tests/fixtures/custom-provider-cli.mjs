#!/usr/bin/env node
/**
 * Custom Provider Fake CLI — simulates a non-Claude/non-Codex AI tool.
 * Phase 6 F-603: Used by integration tests to verify that the Provider Profile
 * system can route agent calls through a custom command_template.
 *
 * This script reads the prompt file, determines the role from environment
 * variable REVIEW_LOOP_ROLE, and delegates to the standard fake-agent.mjs.
 *
 * Usage: node custom-provider-cli.mjs --prompt-file <path>
 * Environment: REVIEW_LOOP_ROLE=planner|developer|auditor|final-auditor
 *              REVIEW_LOOP_BEHAVIOR=success|audit-pass|... (optional)
 */

import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeAgentPath = resolve(join(__dirname, 'fake-agent.mjs'));

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const promptFile = getArg('prompt-file');
const role = process.env.REVIEW_LOOP_ROLE || 'developer';
const behavior = process.env.REVIEW_LOOP_BEHAVIOR || (role === 'auditor' || role === 'final-auditor' ? 'audit-pass' : 'success');
const runId = process.env.REVIEW_LOOP_RUN_ID || 'custom-run';
const iteration = process.env.REVIEW_LOOP_ITERATION || '1';
const projectRoot = process.env.REVIEW_LOOP_PROJECT_ROOT || process.cwd();

const cmdArgs = [
  fakeAgentPath,
  '--role', role,
  '--run-id', runId,
  '--iteration', iteration,
  '--project-root', projectRoot,
  '--behavior', behavior,
];

if (promptFile) {
  cmdArgs.push('--prompt-file', promptFile);
}

try {
  execFileSync('node', cmdArgs, {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: process.env,
  });
  process.exit(0);
} catch (err) {
  process.exit(err.status || 1);
}
