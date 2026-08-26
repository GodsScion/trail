import { describe, it, expect } from 'vitest';
import { TOOL_NAMES, renderResult } from '../../src/tools/index.js';

describe('tool surface', () => {
  it('exposes exactly twelve tools', () => {
    expect(TOOL_NAMES).toHaveLength(12);
    expect(new Set(TOOL_NAMES).size).toBe(12);
  });

  it('names every tool from the spec and nothing else', () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      'browser_click', 'browser_drag', 'browser_navigate', 'browser_press',
      'browser_screenshot', 'browser_scroll', 'browser_select',
      'browser_snapshot', 'browser_type', 'browser_upload', 'browser_wait',
      'workflow_load',
    ]);
  });
});

describe('renderResult', () => {
  it('renders a bare ok in very few tokens', () => {
    expect(renderResult({ ok: true })).toBe('ok');
  });

  it('surfaces the hint_miss snapshot so the agent can correct', () => {
    const out = renderResult({ ok: false, hint_miss: true, snapshot: '- button "Apply"', scope: 'body' });
    expect(out).toMatch(/hint_miss/);
    expect(out).toMatch(/- button "Apply"/);
  });

  it('surfaces a confirmation request without pretending to succeed', () => {
    const out = renderResult({ ok: false, needs_confirm: true, description: 'submit?', screenshot: '/tmp/a.png' });
    expect(out).toMatch(/needs_confirm/);
    expect(out).toMatch(/\/tmp\/a\.png/);
  });

  it('surfaces a block', () => {
    const out = renderResult({ ok: false, blocked: true, reason: 'captcha', screenshot: '/tmp/b.png' });
    expect(out).toMatch(/blocked/);
    expect(out).toMatch(/captcha/);
  });
});
