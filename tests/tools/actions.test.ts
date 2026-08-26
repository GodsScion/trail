import { describe, it, expect } from 'vitest';
import { Actions } from '../../src/tools/actions.js';
import { HintResolver } from '../../src/hints/resolve.js';
import { FakeDriver, type FakeHandlers } from '../helpers/fake-driver.js';

function mk(handlers: FakeHandlers = {}, confirmSubmit = true) {
  const driver = new FakeDriver({
    aria_tree: () => ({
      kind: 'aria_tree',
      root: { ref: 'e1', role: 'button', name: 'Apply', children: [] },
      generation: 1,
      url: 'https://x.test/',
    }),
    query: () => ({ kind: 'query', matches: [], generation: 1 }),
    click: () => ({ kind: 'ok' }),
    ...handlers,
  });
  const resolver = new HintResolver({ driver, persist: async () => true });
  return { driver, resolver, actions: new Actions({ driver, resolver, confirmSubmit }) };
}

describe('Actions', () => {
  it('returns the hint_miss shape unchanged when the hint does not resolve', async () => {
    const { actions } = mk();
    const r = await actions.click({ intent: 'Apply', hint: 'role=button[name="Nope"]' });
    expect(r.ok).toBe(false);
    expect((r as any).hint_miss).toBe(true);
    expect(typeof (r as any).snapshot).toBe('string');
    expect(typeof (r as any).scope).toBe('string');
  });
});
