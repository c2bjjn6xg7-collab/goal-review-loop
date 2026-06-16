/**
 * Tests for CLI Dashboard Command
 * Phase 7 §5: Tests
 */

import { describe, it, expect } from 'vitest';
import {
  createDashboardCommand,
  parseDashboardPort,
  resolveDashboardCommandOptions,
} from '../../src/cli/dashboard.js';

describe('CLI Dashboard Command', () => {
  describe('command creation', () => {
    it('should create a valid Commander command', () => {
      const cmd = createDashboardCommand();

      expect(cmd.name()).toBe('dashboard');
      expect(cmd.description()).toContain('visual progress dashboard');
    });

    it('should have --port option', () => {
      const cmd = createDashboardCommand();

      const portOption = cmd.options.find(opt => opt.long === '--port');
      expect(portOption).toBeDefined();
      expect(portOption?.description).toContain('Port');
    });

    it('should have --host option', () => {
      const cmd = createDashboardCommand();

      const hostOption = cmd.options.find(opt => opt.long === '--host');
      expect(hostOption).toBeDefined();
      expect(hostOption?.description).toContain('Host');
    });

    it('should have --no-open option', () => {
      const cmd = createDashboardCommand();

      const noOpenOption = cmd.options.find(opt => opt.long === '--no-open');
      expect(noOpenOption).toBeDefined();
    });

    it('should have --project-root option', () => {
      const cmd = createDashboardCommand();

      const projectRootOption = cmd.options.find(opt => opt.long === '--project-root');
      expect(projectRootOption).toBeDefined();
      expect(projectRootOption?.description).toContain('Project root');
    });
  });

  describe('default values', () => {
    it('should have default port 4317 in description', () => {
      const cmd = createDashboardCommand();

      const portOption = cmd.options.find(opt => opt.long === '--port');
      expect(portOption?.description).toContain('4317');
    });

    it('should have default host 127.0.0.1 in description', () => {
      const cmd = createDashboardCommand();

      const hostOption = cmd.options.find(opt => opt.long === '--host');
      expect(hostOption?.description).toContain('127.0.0.1');
    });
  });

  describe('option resolution', () => {
    it('should map Commander --no-open to noOpen true', () => {
      const resolved = resolveDashboardCommandOptions({
        projectRoot: '.',
        host: '127.0.0.1',
        port: 4317,
        open: false,
      });

      expect(resolved.noOpen).toBe(true);
    });

    it('should leave browser opening enabled by default', () => {
      const resolved = resolveDashboardCommandOptions({
        projectRoot: '.',
        host: '127.0.0.1',
        port: 4317,
      });

      expect(resolved.noOpen).toBe(false);
    });

    it('should parse valid ports', () => {
      expect(parseDashboardPort('4317')).toBe(4317);
      expect(parseDashboardPort('65535')).toBe(65535);
    });

    it('should reject invalid ports', () => {
      expect(() => parseDashboardPort('0')).toThrow('Invalid port');
      expect(() => parseDashboardPort('65536')).toThrow('Invalid port');
      expect(() => parseDashboardPort('abc')).toThrow('Invalid port');
      expect(() => parseDashboardPort('123abc')).toThrow('Invalid port');
    });
  });
});
