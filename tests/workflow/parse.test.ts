import { describe, expect, it } from 'vitest';
import { parseWorkflow, WorkflowParseError } from '../../src/workflow/parse.js';

const SOURCE = [
  '---',
  'name: apply-greenhouse',
  'match: "boards.greenhouse.io/*/jobs/*"',
  'requires: [profile, resume]',
  'confirm_submit: true',
  'rate_limit: 10/hour',
  '---',
  '',
  '## Intent',
  'Apply to a Greenhouse job posting. Never submit without confirmation.',
  '',
  '## Steps',
  '1. Click Apply',
  '   <!-- hint: role=link[name="Apply for this job"] -->',
  '2. Upload resume from $RESUME',
  '   <!-- hint: role=button[name="Attach"] -->',
  '3. Custom questions -> reason from $PROFILE',
  '',
].join('\n');

describe('parseWorkflow', () => {
  it('reads frontmatter', () => {
    const wf = parseWorkflow(SOURCE, '/w/apply-greenhouse.md');
    expect(wf.frontmatter).toEqual({
      name: 'apply-greenhouse',
      match: 'boards.greenhouse.io/*/jobs/*',
      requires: ['profile', 'resume'],
      confirm_submit: true,
      rate_limit: { count: 10, per: 'hour' },
    });
    expect(wf.path).toBe('/w/apply-greenhouse.md');
    expect(wf.source).toBe(SOURCE);
  });

  it('defaults confirm_submit to true — submit confirmation is default-on', () => {
    const src = ['---', 'name: x', 'match: "example.com/*"', '---', '## Steps', '1. Go'].join('\n');
    expect(parseWorkflow(src, '/w/x.md').frontmatter.confirm_submit).toBe(true);
    expect(parseWorkflow(src, '/w/x.md').frontmatter.requires).toEqual([]);
    expect(parseWorkflow(src, '/w/x.md').frontmatter.rate_limit).toBeNull();
  });

  it('honours an explicit confirm_submit: false opt-out', () => {
    const src = ['---', 'name: x', 'match: "e.com/*"', 'confirm_submit: false', '---', '## Steps', '1. Go'].join('\n');
    expect(parseWorkflow(src, '/w/x.md').frontmatter.confirm_submit).toBe(false);
  });

  it('extracts the intent section', () => {
    expect(parseWorkflow(SOURCE, '/w/x.md').intent).toBe(
      'Apply to a Greenhouse job posting. Never submit without confirmation.',
    );
  });

  it('extracts steps with their inline hints and source line numbers', () => {
    const wf = parseWorkflow(SOURCE, '/w/x.md');
    expect(wf.steps).toEqual([
      { index: 1, text: 'Click Apply', hint: 'role=link[name="Apply for this job"]', line: 12, hintLine: 13 },
      { index: 2, text: 'Upload resume from $RESUME', hint: 'role=button[name="Attach"]', line: 14, hintLine: 15 },
      { index: 3, text: 'Custom questions -> reason from $PROFILE', hint: null, line: 16, hintLine: null },
    ]);
    expect(SOURCE.split('\n')[12]).toBe('1. Click Apply');
  });

  it('accepts a hint on the same line as the step', () => {
    const src = ['---', 'name: x', 'match: "e.com/*"', '---', '## Steps', '1. Click Apply <!-- hint: role=button[name="Apply"] -->'].join('\n');
    const step = parseWorkflow(src, '/w/x.md').steps[0]!;
    expect(step.text).toBe('Click Apply');
    expect(step.hint).toBe('role=button[name="Apply"]');
    expect(step.hintLine).toBe(5);
  });

  it('parses rate_limit in per-day form', () => {
    const src = ['---', 'name: x', 'match: "e.com/*"', 'rate_limit: 50/day', '---', '## Steps', '1. Go'].join('\n');
    expect(parseWorkflow(src, '/w/x.md').frontmatter.rate_limit).toEqual({ count: 50, per: 'day' });
  });

  it('rejects a workflow with no name or no match', () => {
    expect(() => parseWorkflow('---\nmatch: "e.com/*"\n---\n', '/w/x.md')).toThrow(WorkflowParseError);
    expect(() => parseWorkflow('---\nname: x\n---\n', '/w/x.md')).toThrow(WorkflowParseError);
  });

  it('rejects an unparseable rate_limit', () => {
    const src = ['---', 'name: x', 'match: "e.com/*"', 'rate_limit: lots', '---', '## Steps', '1. Go'].join('\n');
    expect(() => parseWorkflow(src, '/w/x.md')).toThrow(WorkflowParseError);
  });
});
