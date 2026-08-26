import { describe, expect, it, vi } from 'vitest';
import { HintResolver, MISS_SCOPE_ORDER } from '../../src/hints/resolve.js';
import type { AriaNode } from '../../src/protocol.js';
import { ariaNode, FakeDriver, type FakeHandlers } from '../helpers/fake-driver.js';

const FORM: AriaNode = ariaNode({
  role: 'form',
  name: 'Application',
  children: [
    ariaNode({ role: 'textbox', name: 'First Name', ref: 'e1' }),
    ariaNode({ role: 'link', name: 'Apply now', ref: 'e2' }),
  ],
});

function resolver(handlers: FakeHandlers = {}, persist = vi.fn(async () => true)) {
  const driver = new FakeDriver(handlers);
  return { driver, persist, hints: new HintResolver({ driver, persist }) };
}

describe('HintResolver', () => {
  it('HIT: resolves from the hint alone and never looks at the page', async () => {
    const { driver, hints } = resolver({
      query: () => ({ kind: 'query', generation: 1, matches: [{ ref: 'q0', role: 'button', name: 'Apply' }] }),
    });
    const res = await hints.resolve({ intent: 'Apply button', hint: 'role=button[name="Apply"]' });
    expect(res).toEqual({ kind: 'resolved', ref: 'q0', role: 'button', name: 'Apply', persisted: false });
    expect(driver.kinds()).toEqual(['query']);
    expect(driver.kinds()).not.toContain('aria_tree');
  });

  it('MISS: returns a scoped snapshot when the hint matches nothing', async () => {
    const { driver, hints } = resolver({
      query: () => ({ kind: 'query', generation: 1, matches: [] }),
      aria_tree: (req) => req.scope === 'role=main'
        ? { kind: 'aria_tree', root: ariaNode({ role: 'main', children: [FORM] }), generation: 1, url: 'https://x.test/' }
        : { kind: 'error', code: 'not_found', message: 'no match' },
    });
    const res = await hints.resolve({ intent: 'Apply button', hint: 'role=button[name="Apply"]' });
    if (res.kind !== 'miss') throw new Error(`expected miss, got ${res.kind}`);
    expect(res.scope).toBe('role=main');
    expect(res.snapshot).toContain('link "Apply now" [e2]');
    expect(driver.kinds()).toEqual(['query', 'aria_tree']);
  });

  it('MISS: walks the scope order until one resolves', async () => {
    expect(MISS_SCOPE_ORDER).toEqual(['role=main', 'role=form', 'css=body']);
    const { driver, hints } = resolver({
      query: () => ({ kind: 'query', generation: 1, matches: [] }),
      aria_tree: (req) => req.scope === 'css=body'
        ? { kind: 'aria_tree', root: ariaNode({ role: 'document', children: [FORM] }), generation: 1, url: 'https://x.test/' }
        : { kind: 'error', code: 'not_found', message: 'no match' },
    });
    const res = await hints.resolve({ intent: 'Apply', hint: 'role=button[name="Apply"]' });
    if (res.kind !== 'miss') throw new Error('expected miss');
    expect(res.scope).toBe('css=body');
    expect(driver.sent.filter((r) => r.kind === 'aria_tree')).toHaveLength(3);
  });

  it('MISS: honours an explicit scope instead of the default order', async () => {
    const { driver, hints } = resolver({
      query: () => ({ kind: 'query', generation: 1, matches: [] }),
      aria_tree: () => ({ kind: 'aria_tree', root: ariaNode({ role: 'form', children: [FORM] }), generation: 1, url: 'https://x.test/' }),
    });
    const res = await hints.resolve({ intent: 'Apply' }, 'role=form[name="Application"]');
    if (res.kind !== 'miss') throw new Error('expected miss');
    expect(res.scope).toBe('role=form[name="Application"]');
    expect(driver.sent.filter((r) => r.kind === 'aria_tree')).toHaveLength(1);
  });

  it('no hint and no ref goes straight to the miss path without querying', async () => {
    const { driver, hints } = resolver({
      aria_tree: () => ({ kind: 'aria_tree', root: ariaNode({ role: 'main', children: [FORM] }), generation: 1, url: 'https://x.test/' }),
    });
    const res = await hints.resolve({ intent: 'Apply button' });
    expect(res.kind).toBe('miss');
    expect(driver.kinds()).not.toContain('query');
  });

  it('persists a learned_hint and uses it as the locator', async () => {
    const persist = vi.fn(async () => true);
    const { driver, hints } = resolver({
      query: () => ({ kind: 'query', generation: 1, matches: [{ ref: 'q3', role: 'link', name: 'Apply now' }] }),
    }, persist);
    const res = await hints.resolve({
      intent: 'Apply button',
      hint: 'role=button[name="Apply"]',
      learned_hint: 'role=link[name="Apply now"]',
    });
    expect(persist).toHaveBeenCalledWith({
      intent: 'Apply button',
      oldHint: 'role=button[name="Apply"]',
      newHint: 'role=link[name="Apply now"]',
    });
    expect(res).toMatchObject({ kind: 'resolved', ref: 'q3', persisted: true });
    expect(driver.sent[0]).toEqual({ kind: 'query', locator: 'role=link[name="Apply now"]' });
  });

  it('reports persisted false when the store could not place the hint', async () => {
    const persist = vi.fn(async () => false);
    const { hints } = resolver({
      query: () => ({ kind: 'query', generation: 1, matches: [{ ref: 'q0', role: 'link', name: 'x' }] }),
    }, persist);
    const res = await hints.resolve({ intent: 'x', learned_hint: 'role=link[name="x"]' });
    expect(res).toMatchObject({ persisted: false });
  });

  it('a ref target short-circuits everything, still persisting the correction', async () => {
    const persist = vi.fn(async () => true);
    const { driver, hints } = resolver({}, persist);
    hints.indexRefs(ariaNode({ role: 'document', children: [FORM] }));
    const res = await hints.resolve({
      intent: 'Apply button', ref: 'e2', learned_hint: 'role=link[name="Apply now"]',
    });
    expect(res).toEqual({ kind: 'resolved', ref: 'e2', role: 'link', name: 'Apply now', persisted: true });
    expect(driver.sent).toEqual([]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('falls back to the stated intent when a ref is not in the index', async () => {
    const { hints } = resolver({});
    const res = await hints.resolve({ intent: 'Submit application', ref: 'e77' });
    expect(res).toEqual({ kind: 'resolved', ref: 'e77', role: '', name: 'Submit application', persisted: false });
  });

  it('invalidate() drops the ref index', async () => {
    const { hints } = resolver({});
    hints.indexRefs(ariaNode({ role: 'document', children: [FORM] }));
    expect(hints.describeRef('e1')).toEqual({ ref: 'e1', role: 'textbox', name: 'First Name' });
    hints.invalidate();
    expect(hints.describeRef('e1')).toBeNull();
  });

  it('treats a malformed hint as a miss rather than an error', async () => {
    const { hints } = resolver({
      aria_tree: () => ({ kind: 'aria_tree', root: ariaNode({ role: 'main', children: [FORM] }), generation: 1, url: 'https://x.test/' }),
    });
    const res = await hints.resolve({ intent: 'Apply', hint: '.apply-btn' });
    expect(res.kind).toBe('miss');
  });

  it('surfaces a driver failure on the miss path as an error resolution', async () => {
    const { hints } = resolver({
      query: () => ({ kind: 'query', generation: 1, matches: [] }),
      aria_tree: () => ({ kind: 'error', code: 'timeout', message: 'page never settled' }),
    });
    const res = await hints.resolve({ intent: 'Apply', hint: 'role=button[name="Apply"]' });
    expect(res).toEqual({ kind: 'error', code: 'timeout', message: 'page never settled' });
  });
});
