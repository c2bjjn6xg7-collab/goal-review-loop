import { describe, it, expect } from 'vitest';
import {
  parseFeedbackBlocks,
  reparseSingleBlock,
  defaultAllowedTypes,
} from '../../src/artifacts/feedback-block-parser.js';

describe('feedback-block-parser', () => {
  describe('language tag strictness', () => {
    it('rejects lowercase tag and writes an error', () => {
      const md = '```reviewlooprequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors).toHaveLength(0); // not even located as a candidate
    });

    it('rejects hyphenated / underscored variants', () => {
      for (const tag of ['Review-loop-request', 'review_loop_request', 'ReviewLoopRequests']) {
        const md = '```' + tag + '\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d\n```';
        const res = parseFeedbackBlocks(md, 'auditor', 10);
        expect(res.blocks, tag).toHaveLength(0);
      }
    });

    it('accepts the exact tag', () => {
      const md = '```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(1);
      expect(res.blocks[0].type).toBe('risk_note');
    });
  });

  describe('fence top-level (column 0) requirement', () => {
    it('rejects blocks nested inside an indented code fence', () => {
      const md = [
        '```markdown',
        'Some prose',
        '  ```ReviewLoopRequest',
        '  type: risk_note',
        '  origin_agent: auditor',
        '  message: m',
        '  category: other',
        '  description: d',
        '  ```',
        '```',
      ].join('\n');
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(0);
    });

    it('accepts a block with leading spaces inside the body', () => {
      const md = '```ReviewLoopRequest\n  type: risk_note\n  origin_agent: auditor\n  message: m\n  category: other\n  description: d\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(1);
    });
  });

  describe('YAML parsing', () => {
    it('records a YAML parse error with line + excerpt', () => {
      const md = '```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\n: : bad\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].reason).toContain('YAML');
      expect(res.errors[0].source_line).toBe(1);
      expect(res.errors[0].raw_excerpt.length).toBeLessThanOrEqual(200);
    });

    it('rejects a non-mapping body', () => {
      const md = '```ReviewLoopRequest\n- a\n- b\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors[0].reason).toContain('not a mapping');
    });

    it('records unterminated fence', () => {
      const md = '```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors[0].reason).toContain('unterminated');
    });
  });

  describe('origin_agent enforcement', () => {
    it('rejects auditor block claiming clarify (anti Auditor-uses-clarify)', () => {
      const md = '```ReviewLoopRequest\ntype: clarify\norigin_agent: auditor\nmessage: m\ntarget: planner\nquestion: q\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      // clarify is not in auditor allowlist AND origin mismatch would be caught first
      expect(res.blocks).toHaveLength(0);
      expect(res.errors).toHaveLength(1);
    });

    it('rejects when origin_agent does not match expected role', () => {
      const md = '```ReviewLoopRequest\ntype: risk_note\norigin_agent: developer\nmessage: m\ncategory: other\ndescription: d\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors[0].reason).toContain('does not match expected role');
    });
  });

  describe('per-type field validation', () => {
    it('validates clarify fully', () => {
      const md = '```ReviewLoopRequest\ntype: clarify\norigin_agent: planner\nmessage: m\ntarget: planner\nquestion: what is the goal?\nblocking: true\n```';
      const res = parseFeedbackBlocks(md, 'planner', 10);
      expect(res.blocks).toHaveLength(1);
      expect(res.blocks[0].fields.blocking).toBe(true);
      expect(res.blocks[0].priority).toBe('medium');
    });

    it('rejects clarify with missing question', () => {
      const md = '```ReviewLoopRequest\ntype: clarify\norigin_agent: planner\nmessage: m\ntarget: planner\n```';
      const res = parseFeedbackBlocks(md, 'planner', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors[0].reason).toContain('schema validation failed');
    });

    it('validates followup_task with suggested_files', () => {
      const md = '```ReviewLoopRequest\ntype: followup_task\norigin_agent: developer\nmessage: m\ntitle: t\ndescription: d\nestimated_difficulty: high\nsuggested_files:\n  - src/a.ts\n```';
      const res = parseFeedbackBlocks(md, 'developer', 10);
      expect(res.blocks).toHaveLength(1);
      expect(res.blocks[0].fields.suggested_files).toEqual(['src/a.ts']);
    });

    it('validates risk_note with mitigation_hint', () => {
      const md = '```ReviewLoopRequest\ntype: risk_note\norigin_agent: developer\nmessage: m\ncategory: race_condition\ndescription: d\nmitigation_hint: lock\n```';
      const res = parseFeedbackBlocks(md, 'developer', 10);
      expect(res.blocks).toHaveLength(1);
    });

    it('validates scope_concern', () => {
      const md = '```ReviewLoopRequest\ntype: scope_concern\norigin_agent: developer\nmessage: m\nrequested_paths:\n  - src/x\nreason: need\n```';
      const res = parseFeedbackBlocks(md, 'developer', 10);
      expect(res.blocks).toHaveLength(1);
    });

    it('validates verification_suggestion', () => {
      const md = '```ReviewLoopRequest\ntype: verification_suggestion\norigin_agent: developer\nmessage: m\ncommand:\n  - npm\n  - test\nreason: r\n```';
      const res = parseFeedbackBlocks(md, 'developer', 10);
      expect(res.blocks).toHaveLength(1);
    });

    it('rejects unknown type', () => {
      const md = '```ReviewLoopRequest\ntype: bogus\norigin_agent: developer\nmessage: m\n```';
      const res = parseFeedbackBlocks(md, 'developer', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors[0].reason).toContain('invalid or missing "type"');
    });
  });

  describe('max_blocks cap', () => {
    it('ignores blocks beyond the cap and warns', () => {
      const block = '```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d\n```';
      const md = [block, block, block].join('\n\n');
      const res = parseFeedbackBlocks(md, 'auditor', 2);
      expect(res.blocks).toHaveLength(2);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].reason).toContain('max_blocks_per_document');
    });
  });

  describe('multiple blocks in one document', () => {
    it('parses a planner doc with mixed types', () => {
      const md = [
        '# Plan',
        '',
        '```ReviewLoopRequest',
        'type: clarify',
        'origin_agent: planner',
        'message: m',
        'target: planner',
        'question: q1',
        '```',
        '',
        '```ReviewLoopRequest',
        'type: risk_note',
        'origin_agent: planner',
        'message: m',
        'category: security',
        'description: d',
        '```',
      ].join('\n');
      const res = parseFeedbackBlocks(md, 'planner', 10);
      expect(res.blocks).toHaveLength(2);
      expect(res.blocks.map((b) => b.type)).toEqual(['clarify', 'risk_note']);
    });

    it('does not confuse a non-tagged code fence', () => {
      const md = '```yaml\ntype: risk_note\norigin_agent: auditor\nmessage: m\n```\n\n```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(1);
    });
  });

  describe('reparseSingleBlock (self-correction)', () => {
    it('parses a valid rewritten block', () => {
      const body = 'type: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d';
      const res = reparseSingleBlock(body, 'auditor', 5);
      expect(res.blocks).toHaveLength(1);
      expect(res.blocks[0].source_line).toBe(5);
    });

    it('returns an error for invalid YAML, no recursion', () => {
      const res = reparseSingleBlock(': : bad', 'auditor', 3);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors).toHaveLength(1);
    });

    it('respects the role allowlist', () => {
      const res = reparseSingleBlock(
        'type: clarify\norigin_agent: auditor\nmessage: m\ntarget: planner\nquestion: q',
        'auditor',
        1,
      );
      expect(res.blocks).toHaveLength(0);
    });
  });

  describe('defaultAllowedTypes', () => {
    it('returns all four roles', () => {
      const a = defaultAllowedTypes();
      expect(Object.keys(a).sort()).toEqual(['auditor', 'developer', 'final_auditor', 'planner']);
      expect(a.auditor).not.toContain('clarify');
    });
  });
});
