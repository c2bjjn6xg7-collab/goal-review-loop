/**
 * Unit tests for GOAL command/argv normalization.
 * Phase 3 §6.1: normalizeGoalCommands in artifact-schemas.ts
 */
import { describe, it, expect } from 'vitest';
import { normalizeGoalCommands } from '../../src/artifacts/artifact-schemas.js';
import type { GoalVerificationCommand } from '../../src/types.js';

describe('normalizeGoalCommands', () => {
  it('normalizes command to argv', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'unit-tests', command: ['npm', 'test'], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    const result = normalizeGoalCommands(cmds);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('unit-tests');
    expect(result[0].argv).toEqual(['npm', 'test']);
    expect(result[0].cwd).toBe('.');
    expect(result[0].required).toBe(true);
    expect(result[0].timeout_seconds).toBe(900);
  });

  it('normalizes multiple commands', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'unit-tests', command: ['npm', 'test'], cwd: '.', required: true, timeout_seconds: 900 },
      { id: 'lint', command: ['npm', 'run', 'lint'], cwd: '.', required: false, timeout_seconds: 300 },
    ];
    const result = normalizeGoalCommands(cmds);
    expect(result).toHaveLength(2);
    expect(result[0].argv).toEqual(['npm', 'test']);
    expect(result[1].argv).toEqual(['npm', 'run', 'lint']);
  });

  it('rejects empty command array', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'bad', command: [], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/empty or missing command/);
  });

  it('rejects empty program name', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'bad', command: ['', 'arg'], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/empty program name/);
  });

  it('rejects duplicate IDs', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'test', command: ['npm', 'test'], cwd: '.', required: true, timeout_seconds: 900 },
      { id: 'test', command: ['npm', 'lint'], cwd: '.', required: false, timeout_seconds: 300 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/duplicate id/);
  });

  it('rejects destructive git push command', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'push', command: ['git', 'push'], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/destructive/);
  });

  it('rejects destructive git reset --hard command', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'reset', command: ['git', 'reset', '--hard'], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/destructive/);
  });

  it('rejects rm -rf / command', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'rm', command: ['rm', '-rf', '/'], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/destructive/);
  });

  it('rejects sudo command', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'sudo', command: ['sudo', 'something'], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/destructive/);
  });

  it('rejects cwd with ..', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'test', command: ['npm', 'test'], cwd: '../escape', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/\.\./);
  });

  it('rejects absolute cwd', () => {
    const cmds: GoalVerificationCommand[] = [
      { id: 'test', command: ['npm', 'test'], cwd: '/absolute/path', required: true, timeout_seconds: 900 },
    ];
    expect(() => normalizeGoalCommands(cmds)).toThrow(/absolute cwd/);
  });

  it('makes defensive copy of command array', () => {
    const original: GoalVerificationCommand[] = [
      { id: 'test', command: ['npm', 'test'], cwd: '.', required: true, timeout_seconds: 900 },
    ];
    const result = normalizeGoalCommands(original);
    // Mutating the original should not affect the result
    original[0].command[0] = 'yarn';
    expect(result[0].argv[0]).toBe('npm');
  });
});
