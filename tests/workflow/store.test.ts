import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow } from '../../src/workflow/parse.js';
import {
  findWorkflowByName, loadWorkflows, loadWorkflowsWithErrors, matchWorkflow,
  recordHint, toLoadedWorkflow, urlMatchesPattern,
} from '../../src/workflow/store.js';

const GREENHOUSE = [
  '---',
  'name: apply-greenhouse',
  'match: "boards.greenhouse.io/*/jobs/*"',
  'requires: [profile, resume]',
  'rate_limit: 10/hour',
  '---',
  '',
  '## Intent',
  'Apply to a Greenhouse job posting.',
  '',
  '## Steps',
  '1. Click Apply',
  '   <!-- hint: role=link[name="Apply for this job"] -->',
  '2. Fill first name',
  '',
].join('\n');

const LEVER = [
  '---',
  'name: apply-lever',
  'match: "jobs.lever.co/**"',
  '---',
  '',
  '## Steps',
  '1. Click Apply',
  '',
].join('\n');

describe('workflow store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trail-wf-'));
    await writeFile(join(dir, 'apply-greenhouse.md'), GREENHOUSE, 'utf8');
    await writeFile(join(dir, 'apply-lever.md'), LEVER, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('urlMatchesPattern', () => {
    it('matches a single path segment with a star', () => {
      expect(urlMatchesPattern('boards.greenhouse.io/*/jobs/*', 'https://boards.greenhouse.io/acme/jobs/12345')).toBe(true);
      expect(urlMatchesPattern('boards.greenhouse.io/*/jobs/*', 'https://boards.greenhouse.io/acme/jobs/12345?utm=x#top')).toBe(true);
      expect(urlMatchesPattern('boards.greenhouse.io/*/jobs/*', 'https://boards.greenhouse.io/acme/jobs/12345/application')).toBe(false);
    });

    it('matches across path segments with a double star', () => {
      expect(urlMatchesPattern('jobs.lever.co/**', 'https://jobs.lever.co/acme/abc-123/apply')).toBe(true);
    });

    it('ignores scheme, trailing slash and host case', () => {
      expect(urlMatchesPattern('https://Example.com/jobs/*', 'http://example.com/jobs/9/')).toBe(true);
    });

    it('does not match a different host', () => {
      expect(urlMatchesPattern('boards.greenhouse.io/*/jobs/*', 'https://evil.com/acme/jobs/1')).toBe(false);
    });
  });

  it('loads every valid workflow in the directory', async () => {
    const workflows = await loadWorkflows(dir);
    expect(workflows.map((w) => w.frontmatter.name).sort()).toEqual(['apply-greenhouse', 'apply-lever']);
  });

  it('skips an invalid file and reports it rather than failing the whole load', async () => {
    await writeFile(join(dir, 'broken.md'), '---\nmatch: "x.com/*"\n---\n', 'utf8');
    const { workflows, errors } = await loadWorkflowsWithErrors(dir);
    expect(workflows).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toContain('broken.md');
    expect(errors[0]!.message).toContain('name');
  });

  it('matches the most specific pattern for a URL', async () => {
    const workflows = await loadWorkflows(dir);
    expect(matchWorkflow(workflows, 'https://boards.greenhouse.io/acme/jobs/1')?.frontmatter.name)
      .toBe('apply-greenhouse');
    expect(matchWorkflow(workflows, 'https://jobs.lever.co/acme/x/apply')?.frontmatter.name)
      .toBe('apply-lever');
    expect(matchWorkflow(workflows, 'https://example.com/')).toBeNull();
  });

  it('finds a workflow by name', async () => {
    const workflows = await loadWorkflows(dir);
    expect(findWorkflowByName(workflows, 'apply-lever')?.path).toContain('apply-lever.md');
    expect(findWorkflowByName(workflows, 'nope')).toBeNull();
  });

  it('replaces an existing hint in place and leaves the rest of the file untouched', async () => {
    const wf = parseWorkflow(GREENHOUSE, join(dir, 'apply-greenhouse.md'));
    const res = await recordHint(wf, {
      intent: 'Apply button',
      oldHint: 'role=link[name="Apply for this job"]',
      newHint: 'role=link[name="Apply now"]',
    });
    expect(res.persisted).toBe(true);
    const after = await readFile(join(dir, 'apply-greenhouse.md'), 'utf8');
    expect(after).toContain('   <!-- hint: role=link[name="Apply now"] -->');
    expect(after).not.toContain('Apply for this job');
    expect(after).toContain('rate_limit: 10/hour');
    expect(after.split('\n')).toHaveLength(GREENHOUSE.split('\n').length);
    expect(res.workflow.steps[0]!.hint).toBe('role=link[name="Apply now"]');
  });

  it('round-trips byte-identically apart from the single rewritten hint line', async () => {
    const path = join(dir, 'apply-greenhouse.md');
    const before = await readFile(path, 'utf8');
    const res = await recordHint(parseWorkflow(before, path), {
      intent: 'Click Apply',
      oldHint: 'role=link[name="Apply for this job"]',
      newHint: 'role=link[name="Apply now"]',
    });
    expect(res.persisted).toBe(true);

    const after = await readFile(path, 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);

    const changed = beforeLines.map((_, i) => i).filter((i) => beforeLines[i] !== afterLines[i]);
    expect(changed).toEqual([12]);
    expect(afterLines[12]).toBe('   <!-- hint: role=link[name="Apply now"] -->');
    expect(after.endsWith('\n')).toBe(true);
  });

  it('inserts a hint line for a step that has none, matched by intent', async () => {
    const wf = parseWorkflow(GREENHOUSE, join(dir, 'apply-greenhouse.md'));
    const res = await recordHint(wf, {
      intent: 'Fill first name',
      newHint: 'role=textbox[name="First Name"]',
    });
    expect(res.persisted).toBe(true);
    const after = await readFile(join(dir, 'apply-greenhouse.md'), 'utf8');
    expect(after).toContain('2. Fill first name\n   <!-- hint: role=textbox[name="First Name"] -->');
    expect(res.workflow.steps[1]!.hint).toBe('role=textbox[name="First Name"]');
  });

  it('adds exactly one line when inserting a hint, preserving every original line', async () => {
    const path = join(dir, 'apply-greenhouse.md');
    const before = await readFile(path, 'utf8');
    await recordHint(parseWorkflow(before, path), {
      intent: 'Fill first name',
      newHint: 'role=textbox[name="First Name"]',
    });

    const afterLines = (await readFile(path, 'utf8')).split('\n');
    expect(afterLines).toHaveLength(before.split('\n').length + 1);
    const [inserted] = afterLines.splice(14, 1);
    expect(inserted).toBe('   <!-- hint: role=textbox[name="First Name"] -->');
    expect(afterLines).toEqual(before.split('\n'));
  });

  it('matches a step by fuzzy intent when no old hint is given', async () => {
    const wf = parseWorkflow(GREENHOUSE, join(dir, 'apply-greenhouse.md'));
    const res = await recordHint(wf, { intent: 'first name field', newHint: 'css=#first' });
    expect(res.persisted).toBe(true);
    expect(res.workflow.steps[1]!.hint).toBe('css=#first');
  });

  it('reports persisted false and changes nothing when no step matches', async () => {
    const wf = parseWorkflow(GREENHOUSE, join(dir, 'apply-greenhouse.md'));
    const res = await recordHint(wf, { intent: 'totally unrelated widget', newHint: 'css=#x' });
    expect(res.persisted).toBe(false);
    expect(await readFile(join(dir, 'apply-greenhouse.md'), 'utf8')).toBe(GREENHOUSE);
  });

  it('projects a workflow onto the wire shape', async () => {
    const wf = parseWorkflow(GREENHOUSE, '/w/apply-greenhouse.md');
    expect(toLoadedWorkflow(wf)).toEqual({
      name: 'apply-greenhouse',
      path: '/w/apply-greenhouse.md',
      match: 'boards.greenhouse.io/*/jobs/*',
      intent: 'Apply to a Greenhouse job posting.',
      requires: ['profile', 'resume'],
      confirm_submit: true,
      rate_limit: { count: 10, per: 'hour' },
      steps: [
        { index: 1, text: 'Click Apply', hint: 'role=link[name="Apply for this job"]' },
        { index: 2, text: 'Fill first name', hint: null },
      ],
    });
  });
});
