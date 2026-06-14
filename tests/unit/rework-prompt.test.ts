/**
 * Unit tests for rework prompt builder.
 * Phase 4 §7: buildReworkPrompt placeholder replacement.
 */

import { describe, it, expect } from 'vitest';
import { buildReworkPrompt, type ReworkPromptContext } from '../../src/agents/prompt-builder.js';

describe('buildReworkPrompt', () => {
  const template = `---
schema_version: 1
template_version: {{TEMPLATE_VERSION}}
role: developer-rework
---

# Rework Task

Run ID: {{RUN_ID}}
Iteration: {{ITERATION}}
Project Root: {{PROJECT_ROOT}}
GOAL Path: {{GOAL_PATH}}
Rework Instructions Path: {{REWORK_INSTRUCTIONS_PATH}}
Handoff Path: {{HANDOFF_PATH}}
`;

  const context: ReworkPromptContext = {
    run_id: 'run-001',
    iteration: 2,
    project_root: '/project',
    goal_path: '/project/.agent/GOAL.md',
    rework_instructions_path: '/project/.agent/rework-instructions.md',
    handoff_path: '/project/.agent/developer-handoff.md',
  };

  it('replaces all template tokens', () => {
    const result = buildReworkPrompt(template, context);
    expect(result).toContain('run-001');
    expect(result).toContain('2');
    expect(result).toContain('/project');
    expect(result).toContain('/project/.agent/GOAL.md');
    expect(result).toContain('/project/.agent/rework-instructions.md');
    expect(result).toContain('/project/.agent/developer-handoff.md');
    expect(result).not.toContain('{{RUN_ID}}');
    expect(result).not.toContain('{{ITERATION}}');
    expect(result).not.toContain('{{PROJECT_ROOT}}');
    expect(result).not.toContain('{{GOAL_PATH}}');
    expect(result).not.toContain('{{REWORK_INSTRUCTIONS_PATH}}');
    expect(result).not.toContain('{{HANDOFF_PATH}}');
    expect(result).not.toContain('{{TEMPLATE_VERSION}}');
  });

  it('includes template version number', () => {
    const result = buildReworkPrompt(template, context);
    expect(result).toMatch(/template_version: \d+/);
  });

  it('handles special characters in paths', () => {
    const specialContext: ReworkPromptContext = {
      ...context,
      project_root: '/project with spaces',
      goal_path: '/project with spaces/.agent/GOAL.md',
    };
    const result = buildReworkPrompt(template, specialContext);
    expect(result).toContain('/project with spaces');
    expect(result).not.toContain('{{PROJECT_ROOT}}');
  });
});
